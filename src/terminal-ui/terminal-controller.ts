import type { CliCommand } from '../cli-commands/core/command-types.ts'
import type { ThreadHistoryEntry } from '../threads/thread-store.ts'
import type { ThreadHandle, ThreadManager } from '../threads/thread-manager.ts'
import type { SkillListResult } from '../skills/skill-library.ts'
import type { ConversationHistoryMessage } from '../providers/conversation-history.ts'
import type {
  ToolOutcome,
  ToolProgressEvent,
} from '../tools/core/tool-definition.ts'
import {
  extractToolCall,
  parseToolCallPayload,
} from '../tools/core/tool-registry.ts'
import { getDefaultShell } from '../platform/platform-defaults.ts'

export type UiTone =
  | 'info'
  | 'success'
  | 'warning'
  | 'error'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'user'

export type UiPhase = 'idle' | 'working' | 'attention'
export type BubbleFormat = 'plain' | 'markdown' | 'v4a'
export type BrowserConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'

export interface WelcomeTimelineDetails {
  browserStatus: BrowserConnectionStatus
  directory: string
  version: string
}

export interface TimelineEntry {
  id: number
  tone: UiTone
  label: string
  body: string
  format: BubbleFormat
  welcome?: WelcomeTimelineDetails
}

export const HOME_TIMELINE_KEY = 'home'

export interface LiveAssistantEntry {
  id: number
  tone: 'assistant'
  label: string
  body: string
  format: BubbleFormat
}

export interface LiveCommandEntry {
  id: number
  tone: 'tool_result'
  label: string
  body: string
  format: 'plain'
  fixedLineCount?: number
  toolName: string
  threadId: string
  toolCallId: string | null
  startedAt: number
}

interface PendingLiveCommand {
  toolName: string
  threadId: string
  toolCallId: string | null
}

export interface PromptState {
  active: boolean
  label: string
  hint: string
}

export interface TerminalState {
  browserConnected: boolean
  busy: boolean
  lastToolName: string | null
  phase: UiPhase
  lastAction: string
  footerHint: string
  prompt: PromptState
  liveAssistant: LiveAssistantEntry | null
  liveCommand: LiveCommandEntry | null
  timelineVersion: number
  timeline: TimelineEntry[]
}

interface TimelineViewState {
  key: string
  busy: boolean
  lastToolName: string | null
  phase: UiPhase
  lastAction: string
  liveAssistant: LiveAssistantEntry | null
  liveCommand: LiveCommandEntry | null
  pendingLiveCommand: PendingLiveCommand | null
  timeline: TimelineEntry[]
  commandOutputTail: CommandOutputTail | null
  liveAssistantEmitTimer: ReturnType<typeof setTimeout> | null
  lastLiveAssistantEmitAt: number
  liveCommandEmitTimer: ReturnType<typeof setTimeout> | null
  lastLiveCommandEmitAt: number
  liveToolHeartbeatTimer: ReturnType<typeof setTimeout> | null
  liveCommandGeneration: number
}

type Listener = () => void
type ScreenResetter = () => void

export class TerminalController {
  private readonly listeners = new Set<Listener>()
  private threadManager: ThreadManager | null = null
  private nextTimelineEntryId = 1
  private activeTimelineKey = HOME_TIMELINE_KEY
  private readonly timelineViews = new Map<string, TimelineViewState>([
    [HOME_TIMELINE_KEY, createTimelineView(HOME_TIMELINE_KEY)],
  ])
  private screenResetter: ScreenResetter | null = null
  private foregroundBusy = false
  private state: Pick<
    TerminalState,
    'browserConnected' | 'footerHint' | 'prompt' | 'timelineVersion'
  > = {
    browserConnected: false,
    footerHint: 'Type a task or use /help.',
    prompt: {
      active: false,
      label: 'portal > ',
      hint: 'Type a task or use /help.',
    },
    timelineVersion: 0,
  }
  private pendingPrompt: {
    resolve: (value: string) => void
    reject: (error: Error) => void
  } | null = null

  public bindThreadManager(threadManager: ThreadManager) {
    this.threadManager = threadManager
    this.emit()
  }

  public showHomeTimeline(): void {
    this.switchTimeline(HOME_TIMELINE_KEY, 'Returned to portal home.')
  }

  public showThreadTimeline(threadId: string): void {
    this.switchTimeline(threadId, `Switched to ${threadId}.`)
  }

  public removeThreadTimeline(threadId: string): void {
    if (this.activeTimelineKey === threadId) {
      this.showHomeTimeline()
    }
    const view = this.timelineViews.get(threadId)
    if (view !== undefined) {
      this.discardLiveAssistant(view)
      this.discardLiveCommand(view)
      this.timelineViews.delete(threadId)
    }
  }

  public getThreadManager(): ThreadManager | null {
    return this.threadManager
  }

  public getActiveManualSkillNames(): readonly string[] {
    return (
      this.threadManager?.getActiveThread()?.runtime
        .availableManualSkillNames ?? []
    )
  }

  public cycleThread(direction: -1 | 1): ThreadHandle | null {
    const threadManager = this.threadManager
    if (threadManager === null) {
      return null
    }

    const threads = threadManager.listThreads()
    if (threads.length === 0) {
      return null
    }

    const activeThreadId = threadManager.getActiveThread()?.id ?? null
    const currentIndex = threads.findIndex(
      (thread) => thread.id === activeThreadId
    )
    const safeIndex = currentIndex >= 0 ? currentIndex : 0
    const nextIndex = (safeIndex + direction + threads.length) % threads.length
    const nextThread = threads[nextIndex] ?? null
    if (nextThread === null) {
      return null
    }

    threadManager.switchThread(nextThread.id)
    this.showThreadTimeline(nextThread.id)
    this.activeTimelineView().lastAction = `Switched to ${nextThread.id} (${nextThread.provider}).`
    this.emit()
    return threadManager.getActiveThread()
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  public setScreenResetter(reset: ScreenResetter | null): void {
    this.screenResetter = reset
  }

  public getState(): TerminalState {
    const view = this.activeTimelineView()
    return {
      ...this.state,
      busy: this.foregroundBusy || view.busy,
      lastToolName: view.lastToolName,
      phase: this.foregroundBusy ? 'working' : view.phase,
      lastAction: view.lastAction,
      prompt: { ...this.state.prompt },
      liveAssistant: view.liveAssistant
        ? {
            ...view.liveAssistant,
          }
        : null,
      liveCommand: view.liveCommand
        ? {
            ...view.liveCommand,
          }
        : null,
      timelineVersion: this.state.timelineVersion,
      timeline: view.timeline.map((entry) => ({
        ...entry,
      })),
    }
  }

  public setBrowserConnected(connected: boolean) {
    const view = this.activeTimelineView()
    this.state.browserConnected = connected
    view.lastAction = connected ? 'Browser connected.' : 'Browser disconnected.'

    const browserStatus: BrowserConnectionStatus = connected
      ? 'connected'
      : 'disconnected'
    let staticWelcomeUpdated = false
    view.timeline = view.timeline.map((entry) => {
      if (
        entry.welcome === undefined ||
        entry.welcome.browserStatus === browserStatus
      ) {
        return entry
      }

      staticWelcomeUpdated ||= entry.welcome.browserStatus !== 'connecting'
      return {
        ...entry,
        welcome: {
          ...entry.welcome,
          browserStatus,
        },
      }
    })

    if (staticWelcomeUpdated) {
      this.state.timelineVersion += 1
      this.screenResetter?.()
    }
    this.emit()
  }

  public setBusy(busy: boolean) {
    this.foregroundBusy = busy
    this.emit()
  }

  public setThreadBusy(threadId: string, busy: boolean) {
    this.setViewBusy(this.getTimelineView(threadId), busy)
  }

  public setLastToolName(toolName: string | null) {
    const view = this.activeTimelineView()
    view.lastToolName = toolName
    this.emitView(view)
  }

  public setThreadLastToolName(threadId: string, toolName: string | null) {
    const view = this.getTimelineView(threadId)
    view.lastToolName = toolName
    this.emitView(view)
  }

  public async requestInput(label: string, hint: string): Promise<string> {
    if (this.pendingPrompt !== null) {
      throw new Error('Prompt already active')
    }

    this.state.prompt = {
      active: true,
      label,
      hint,
    }
    this.state.footerHint = hint
    this.emit()

    return await new Promise<string>((resolve, reject) => {
      this.pendingPrompt = { resolve, reject }
    })
  }

  public submitInput(value: string): boolean {
    if (this.pendingPrompt === null) {
      return false
    }

    const pendingPrompt = this.pendingPrompt
    this.pendingPrompt = null
    this.state.prompt = {
      active: false,
      label: this.state.prompt.label,
      hint: 'Type a task or use /help.',
    }
    this.state.footerHint = 'Type a task or use /help.'
    this.emit()
    pendingPrompt.resolve(value)
    return true
  }

  public cancelPendingInput(error: Error) {
    if (this.pendingPrompt === null) {
      return
    }

    const pendingPrompt = this.pendingPrompt
    this.pendingPrompt = null
    this.state.prompt = {
      active: false,
      label: this.state.prompt.label,
      hint: 'Type a task or use /help.',
    }
    this.state.footerHint = 'Type a task or use /help.'
    this.emit()
    pendingPrompt.reject(error)
  }

  public renderWelcome(details: {
    browserStatus: BrowserConnectionStatus
    directory: string
    version: string
  }) {
    const view = this.activeTimelineView()
    view.timeline = [
      ...view.timeline,
      {
        id: this.allocateTimelineEntryId(),
        tone: 'info',
        label: 'portal',
        body: '',
        format: 'plain',
        welcome: {
          browserStatus: details.browserStatus,
          directory: details.directory,
          version: details.version,
        },
      },
    ]
    view.lastAction =
      details.browserStatus === 'connecting'
        ? 'Connecting to browser.'
        : 'Portal is ready.'
    this.emit()
  }

  public renderPromptHeader(_threadManager: ThreadManager) {}

  public promptLabel(threadManager: ThreadManager): string {
    const activeThread = threadManager.getActiveThread()
    if (activeThread === null) {
      return 'portal > '
    }

    return `${activeThread.provider} > `
  }

  public renderInfo(
    title: string,
    body: string | readonly string[],
    format: BubbleFormat = 'plain'
  ) {
    this.addTimelineEntry('info', title, body, format)
  }

  public renderThreadInfo(
    thread: ThreadHandle,
    title: string,
    body: string | readonly string[],
    format: BubbleFormat = 'plain'
  ) {
    this.addTimelineEntry(
      'info',
      title,
      body,
      format,
      undefined,
      this.getThreadTimelineView(thread.id)
    )
  }

  public renderSuccess(
    title: string,
    body: string | readonly string[],
    format: BubbleFormat = 'plain'
  ) {
    this.addTimelineEntry('success', title, body, format)
  }

  public renderWarning(
    title: string,
    body: string | readonly string[],
    format: BubbleFormat = 'plain'
  ) {
    const view = this.activeTimelineView()
    view.phase = 'attention'
    this.addTimelineEntry('warning', title, body, format, undefined, view)
  }

  public renderThreadWarning(
    thread: ThreadHandle,
    title: string,
    body: string | readonly string[],
    format: BubbleFormat = 'plain'
  ) {
    const view = this.getThreadTimelineView(thread.id)
    view.phase = 'attention'
    this.addTimelineEntry('warning', title, body, format, undefined, view)
  }

  public renderError(
    title: string,
    body: string | readonly string[],
    format: BubbleFormat = 'plain'
  ) {
    const view = this.activeTimelineView()
    view.phase = 'attention'
    this.addTimelineEntry('error', title, body, format, undefined, view)
  }

  public renderThreadError(
    thread: ThreadHandle,
    title: string,
    body: string | readonly string[],
    format: BubbleFormat = 'plain'
  ) {
    const view = this.getThreadTimelineView(thread.id)
    view.phase = 'attention'
    this.addTimelineEntry('error', title, body, format, undefined, view)
  }

  public renderCommandHelp(commands: readonly CliCommand[]) {
    const usageWidth = Math.max(
      0,
      ...commands.map((command) => (command.usage ?? command.name).length)
    )
    const lines = commands.map((command) => {
      const usage = command.usage ?? command.name
      return `  ${usage.padEnd(usageWidth, ' ')}  ${command.description}`
    })

    this.renderInfo('/help', ['Commands:', ...lines].join('\n'))
  }

  public renderProviderList(providers: readonly string[]) {
    this.renderInfo(
      '/providers',
      ['Providers:', ...providers.map((provider) => `  ${provider}`)].join('\n')
    )
  }

  public renderSkillList(result: SkillListResult) {
    if (result.skills.length === 0 && result.issues.length === 0) {
      this.renderWarning('/skill list', 'No skills registered.')
      return
    }

    if (result.skills.length > 0) {
      this.renderInfo('/skill list', [
        'Skills:',
        ...result.skills.map(
          (skill) => `${skill.enabled ? '*' : ' '} ${skill.name}`
        ),
      ])
    }

    if (result.issues.length > 0) {
      const issueRows = result.issues.flatMap((issue) => [
        `  ${issue.directory}`,
        `    ${issue.message}`,
      ])
      this.renderWarning('/skill list', ['Invalid skills:', ...issueRows])
    }
  }

  public renderThreadList(threads: readonly ThreadHandle[]) {
    if (threads.length === 0) {
      this.renderWarning('/thread list', 'No local threads.')
      return
    }

    const activeThreadId = this.threadManager?.getActiveThread()?.id ?? null
    const rows = threads.flatMap((thread, index) => {
      const marker = thread.id === activeThreadId ? '*' : ' '
      const turnLabel = thread.turnCount === 1 ? 'turn' : 'turns'
      const lines = [
        `${marker} ${thread.id}  ${thread.provider}  ${thread.turnCount} ${turnLabel}`,
        `  title: ${thread.title ?? '(untitled)'}`,
        `  url: ${thread.runtime.conversationUrl}`,
      ]
      return index === threads.length - 1 ? lines : [...lines, '']
    })

    this.renderInfo('/thread list', ['Threads:', ...rows].join('\n'))
  }

  public renderThreadHistory(entries: readonly ThreadHistoryEntry[]) {
    if (entries.length === 0) {
      this.renderWarning('/thread history', 'No thread history.')
      return
    }

    const rows = entries.flatMap((entry, index) => {
      const lines = [
        `#${entry.id} ${entry.title ?? '(untitled)'}`,
        `   Provider: ${entry.provider}`,
        `   Created: ${entry.createdAt}`,
        `   Last used: ${entry.lastUsedAt}`,
        `   URL: ${entry.conversationUrl}`,
      ]
      return index === entries.length - 1 ? lines : [...lines, '']
    })

    this.renderInfo('/thread history', ['History:', ...rows].join('\n'))
  }

  public renderThreadStatus(thread: ThreadHandle) {
    this.renderInfo(
      '/thread status',
      [
        'Thread:',
        `  id: ${thread.id}`,
        `  provider: ${thread.provider}`,
        `  title: ${thread.title ?? '(untitled)'}`,
        `  turns: ${thread.turnCount}`,
        `  url: ${thread.runtime.conversationUrl}`,
      ].join('\n')
    )
  }

  public renderAssistantStream(thread: ThreadHandle, message: string) {
    const view = this.getThreadTimelineView(thread.id)
    const displayMessage = escapeToolTagsForMarkdown(message)
    const existing =
      view.liveAssistant?.label ===
      `assistant ${this.formatThreadTarget(thread)}`
        ? view.liveAssistant
        : null
    view.liveAssistant = {
      id: existing?.id ?? this.allocateTimelineEntryId(),
      tone: 'assistant',
      label: `assistant ${this.formatThreadTarget(thread)}`,
      body: displayMessage,
      format: 'markdown',
    }
    const lines = displayMessage.split(/\r?\n/)
    const firstMeaningfulLine =
      lines.find((line) => line.trim()) ?? view.liveAssistant.label
    view.lastAction = firstMeaningfulLine
    this.scheduleLiveAssistantEmit(view)
  }

  public commitLiveAssistant(thread: ThreadHandle) {
    const view = this.getThreadTimelineView(thread.id)
    const liveAssistant = this.takeLiveAssistant(thread)
    if (liveAssistant === null) {
      return
    }

    view.timeline = [...view.timeline, liveAssistant]
    view.lastAction = `Assistant response interrupted in ${this.formatThreadTarget(thread)}.`
    this.emitView(view)
  }

  public renderAssistantMessage(thread: ThreadHandle, message: string) {
    const view = this.getThreadTimelineView(thread.id)
    view.lastAction = `Assistant replied in ${this.formatThreadTarget(thread)}.`
    const liveAssistant = this.takeLiveAssistant(thread)
    const id = liveAssistant?.id
    this.addTimelineEntry(
      'assistant',
      `assistant ${this.formatThreadTarget(thread)}`,
      escapeToolTagsForMarkdown(message),
      'markdown',
      id,
      view
    )
  }

  public renderUserMessage(thread: ThreadHandle, message: string) {
    const view = this.getThreadTimelineView(thread.id)
    view.lastAction = `Sent message in ${this.formatThreadTarget(thread)}.`
    this.clearLiveAssistant(thread)
    this.addTimelineEntry(
      'user',
      `user ${this.formatThreadTarget(thread)}`,
      message,
      'plain',
      undefined,
      view
    )
  }

  public renderConversationHistory(
    thread: ThreadHandle,
    messages: readonly ConversationHistoryMessage[]
  ) {
    const view = this.getThreadTimelineView(thread.id)
    if (messages.length === 0) {
      return
    }

    const hiddenIndexes = new Set<number>()
    const firstMessage = messages[0]
    if (isInitialSetupMessage(firstMessage)) {
      hiddenIndexes.add(0)
      const firstAssistantIndex = messages.findIndex(
        (message, index) => index > 0 && message.role === 'assistant'
      )
      const firstAssistant =
        firstAssistantIndex === -1 ? null : messages[firstAssistantIndex]
      if (firstAssistant?.text.trim() === 'READY') {
        hiddenIndexes.add(firstAssistantIndex)
      }
    }

    const entries: TimelineEntry[] = []
    for (const [index, message] of messages.entries()) {
      if (hiddenIndexes.has(index)) {
        continue
      }
      if (message.role === 'user' && isToolResultMessage(message.text)) {
        continue
      }

      if (message.role === 'assistant') {
        const extracted = extractToolCall(message.text)
        if (extracted !== null) {
          this.appendHistoryAssistantEntry(
            entries,
            thread,
            message,
            extracted.leadingText
          )
          const toolCall = parseToolCallPayload(
            extracted.rawPayload,
            extracted.declaredToolName
          )
          const toolName = toolCall?.tool ?? 'unknown'
          entries.push({
            id: this.allocateTimelineEntryId(),
            tone: 'tool_call',
            label: `${toolName} · call`,
            body: this.summarizeToolCall(
              thread,
              toolName,
              extracted.rawPayload
            ).join('\n'),
            format: 'plain',
          })
          this.appendHistoryAssistantEntry(
            entries,
            thread,
            message,
            extracted.trailingText
          )
          continue
        }
      }

      entries.push({
        id: this.allocateTimelineEntryId(),
        tone: message.role,
        label: `${message.role} ${this.formatThreadTarget(thread)}`,
        body: message.text,
        format: message.format,
      })
    }

    if (entries.length === 0) {
      return
    }

    view.timeline = [...view.timeline, ...entries]
    const latest = entries.at(-1)!
    view.lastAction =
      latest.body.split(/\r?\n/).find((line) => line.trim()) ?? latest.label
    this.emitView(view)
  }

  private appendHistoryAssistantEntry(
    entries: TimelineEntry[],
    thread: ThreadHandle,
    message: ConversationHistoryMessage,
    text: string
  ) {
    const normalized = text.trim()
    if (!normalized) {
      return
    }
    entries.push({
      id: this.allocateTimelineEntryId(),
      tone: 'assistant',
      label: `assistant ${this.formatThreadTarget(thread)}`,
      body: normalized,
      format: message.format,
    })
  }

  public renderToolCall(
    thread: ThreadHandle,
    toolName: string,
    rawPayload: string,
    toolCallId?: string
  ) {
    const view = this.getThreadTimelineView(thread.id)
    const lines = this.summarizeToolCall(thread, toolName, rawPayload)
    view.lastAction = `Calling ${toolName}.`
    this.clearLiveAssistant(thread)
    this.discardLiveCommand(view)
    view.pendingLiveCommand = isLiveCommandTool(toolName)
      ? {
          toolName,
          threadId: thread.id,
          toolCallId: toolCallId ?? null,
        }
      : null

    this.addTimelineEntry(
      'tool_call',
      `${toolName} · call`,
      lines,
      'plain',
      undefined,
      view
    )
  }

  public renderToolProgress(
    thread: ThreadHandle,
    toolName: string,
    event: ToolProgressEvent,
    toolCallId?: string
  ) {
    const view = this.getThreadTimelineView(thread.id)
    if (toolName !== 'run_command') {
      if (toolName !== 'spawn') {
        return
      }
    }

    if (event.type === 'start') {
      const pending = view.pendingLiveCommand
      const expectedToolCallId = toolCallId ?? null
      if (
        pending === null ||
        pending.threadId !== thread.id ||
        pending.toolName !== toolName ||
        pending.toolCallId !== expectedToolCallId
      ) {
        return
      }
      this.discardLiveCommand(view)
      view.commandOutputTail =
        toolName === 'run_command' ? new CommandOutputTail() : null
      view.liveCommand = {
        id: this.allocateTimelineEntryId(),
        tone: 'tool_result',
        label: toolName,
        body:
          toolName === 'spawn'
            ? 'Waiting for child worker to finish...'
            : 'Waiting for command output...',
        format: 'plain',
        toolName,
        threadId: thread.id,
        toolCallId: expectedToolCallId,
        startedAt: event.startedAt,
      }
      view.lastAction = `Running ${toolName}.`
      view.lastLiveCommandEmitAt = Date.now()
      this.emitView(view)
      if (toolName === 'spawn') {
        this.scheduleLiveToolHeartbeat(view)
      }
      return
    }

    const liveCommand = view.liveCommand
    const tail = view.commandOutputTail
    const expectedToolCallId = toolCallId ?? null
    if (
      toolName !== 'run_command' ||
      liveCommand === null ||
      tail === null ||
      liveCommand.threadId !== thread.id ||
      liveCommand.toolName !== toolName ||
      liveCommand.toolCallId !== expectedToolCallId
    ) {
      return
    }

    tail.append(event.stream, event.text)
    const lines = tail.toLines()
    if (lines.length === 0) {
      return
    }
    liveCommand.body = lines.join('\n')
    liveCommand.fixedLineCount = Math.min(
      LIVE_COMMAND_TAIL_LINE_COUNT,
      lines.length
    )
    const latestLine = lines.at(-1)
    if (latestLine !== undefined && latestLine.trim()) {
      view.lastAction = latestLine
    }
    this.scheduleLiveCommandEmit(view)
  }

  public renderToolResult(
    thread: ThreadHandle,
    toolName: string,
    outcome: ToolOutcome,
    result: Record<string, unknown>,
    displayText?: string,
    toolCallId?: string
  ) {
    const view = this.getThreadTimelineView(thread.id)
    const lines =
      displayText === undefined
        ? this.summarizeToolResult(toolName, outcome, result)
        : toLines(displayText)
    const liveCommand = this.takeLiveCommand(thread, toolName, toolCallId)
    this.clearPendingLiveCommand(thread, toolName, toolCallId)
    view.lastAction = lines[0] ?? `${toolName} ${outcome}.`
    this.clearLiveAssistant(thread)

    const tone: UiTone =
      outcome === 'error'
        ? 'error'
        : outcome === 'unknown'
          ? 'warning'
          : 'tool_result'
    const label = `${toolName} · ${outcome === 'success' ? 'result' : outcome}`

    const format: BubbleFormat =
      toolName === 'apply_patch' && outcome === 'success' ? 'v4a' : 'plain'
    this.addTimelineEntry(tone, label, lines, format, liveCommand?.id, view)
  }

  public clearLiveCommand(thread: ThreadHandle, toolCallId?: string): void {
    const view = this.getThreadTimelineView(thread.id)
    const hadLiveState =
      view.liveCommand?.threadId === thread.id ||
      view.pendingLiveCommand?.threadId === thread.id
    if (!hadLiveState) return

    if (toolCallId === undefined) {
      this.discardLiveCommand(view)
      this.emitView(view)
      return
    }

    const toolName =
      view.liveCommand?.toolCallId === toolCallId
        ? view.liveCommand.toolName
        : view.pendingLiveCommand?.toolCallId === toolCallId
          ? view.pendingLiveCommand.toolName
          : null
    if (toolName === null) return

    const removedLive = this.takeLiveCommand(thread, toolName, toolCallId)
    const removedPending = this.clearPendingLiveCommand(
      thread,
      toolName,
      toolCallId
    )
    if (removedLive !== null || removedPending) {
      this.emitView(view)
    }
  }

  private scheduleLiveAssistantEmit(view: TimelineViewState): void {
    if (view.key !== this.activeTimelineKey) {
      return
    }
    const now = Date.now()
    const elapsed = now - view.lastLiveAssistantEmitAt
    if (elapsed >= LIVE_ASSISTANT_EMIT_INTERVAL_MS) {
      this.cancelLiveAssistantEmit(view)
      view.lastLiveAssistantEmitAt = now
      this.emitView(view)
      return
    }

    if (view.liveAssistantEmitTimer !== null) {
      return
    }

    view.liveAssistantEmitTimer = setTimeout(
      () => {
        view.liveAssistantEmitTimer = null
        if (view.liveAssistant === null) {
          return
        }
        view.lastLiveAssistantEmitAt = Date.now()
        this.emitView(view)
      },
      Math.max(1, LIVE_ASSISTANT_EMIT_INTERVAL_MS - elapsed)
    )
  }

  private cancelLiveAssistantEmit(view: TimelineViewState): void {
    if (view.liveAssistantEmitTimer === null) {
      return
    }
    clearTimeout(view.liveAssistantEmitTimer)
    view.liveAssistantEmitTimer = null
  }

  private discardLiveAssistant(view: TimelineViewState): void {
    this.cancelLiveAssistantEmit(view)
    view.lastLiveAssistantEmitAt = 0
    view.liveAssistant = null
  }

  private scheduleLiveCommandEmit(view: TimelineViewState): void {
    const liveCommand = view.liveCommand
    if (view.key !== this.activeTimelineKey || liveCommand === null) {
      return
    }
    const generation = view.liveCommandGeneration
    const entryId = liveCommand.id
    const now = Date.now()
    const elapsed = now - view.lastLiveCommandEmitAt
    if (elapsed >= LIVE_COMMAND_EMIT_INTERVAL_MS) {
      this.cancelLiveCommandEmit(view)
      view.lastLiveCommandEmitAt = now
      this.emitView(view)
      return
    }

    if (view.liveCommandEmitTimer !== null) {
      return
    }

    const timer = setTimeout(
      () => {
        if (view.liveCommandEmitTimer !== timer) {
          return
        }
        view.liveCommandEmitTimer = null
        if (
          view.liveCommandGeneration !== generation ||
          view.liveCommand?.id !== entryId
        ) {
          return
        }
        view.lastLiveCommandEmitAt = Date.now()
        this.emitView(view)
      },
      Math.max(1, LIVE_COMMAND_EMIT_INTERVAL_MS - elapsed)
    )
    view.liveCommandEmitTimer = timer
  }

  private cancelLiveCommandEmit(view: TimelineViewState): void {
    if (view.liveCommandEmitTimer === null) {
      return
    }
    clearTimeout(view.liveCommandEmitTimer)
    view.liveCommandEmitTimer = null
  }

  private discardLiveCommand(view: TimelineViewState): void {
    this.cancelLiveCommandEmit(view)
    this.cancelLiveToolHeartbeat(view)
    view.liveCommandGeneration += 1
    view.commandOutputTail = null
    view.liveCommand = null
    view.pendingLiveCommand = null
  }

  private scheduleLiveToolHeartbeat(view: TimelineViewState): void {
    const liveCommand = view.liveCommand
    if (
      view.key !== this.activeTimelineKey ||
      view.liveToolHeartbeatTimer !== null ||
      liveCommand?.toolName !== 'spawn'
    ) {
      return
    }
    const generation = view.liveCommandGeneration
    const entryId = liveCommand.id

    const timer = setTimeout(() => {
      if (view.liveToolHeartbeatTimer !== timer) {
        return
      }
      view.liveToolHeartbeatTimer = null
      if (
        view.liveCommandGeneration !== generation ||
        view.liveCommand?.id !== entryId ||
        view.liveCommand.toolName !== 'spawn'
      ) {
        return
      }

      this.emitView(view)
      this.scheduleLiveToolHeartbeat(view)
    }, LIVE_TOOL_HEARTBEAT_INTERVAL_MS)
    view.liveToolHeartbeatTimer = timer
  }

  private cancelLiveToolHeartbeat(view: TimelineViewState): void {
    if (view.liveToolHeartbeatTimer === null) {
      return
    }
    clearTimeout(view.liveToolHeartbeatTimer)
    view.liveToolHeartbeatTimer = null
  }

  private addTimelineEntry(
    tone: UiTone,
    label: string,
    body: string | readonly string[],
    format: BubbleFormat = 'plain',
    id = this.allocateTimelineEntryId(),
    view = this.activeTimelineView()
  ) {
    const text = toBodyText(body)
    view.timeline = [...view.timeline, { id, tone, label, body: text, format }]

    const firstMeaningfulLine =
      text.split(/\r?\n/).find((line) => line.trim()) ?? label
    view.lastAction = firstMeaningfulLine
    this.emitView(view)
  }

  private switchTimeline(nextKey: string, lastAction: string): void {
    const previousView = this.activeTimelineView()
    if (previousView.key !== nextKey) {
      this.discardLiveCommand(previousView)
    }
    this.activeTimelineKey = nextKey
    const nextView = this.getTimelineView(nextKey)
    this.state.timelineVersion += 1
    nextView.lastAction = lastAction
    if (nextView.liveCommand?.toolName === 'spawn') {
      this.scheduleLiveToolHeartbeat(nextView)
    }
    this.screenResetter?.()
    this.emit()
  }

  private summarizeToolCall(
    thread: ThreadHandle,
    toolName: string,
    rawPayload: string
  ): string[] {
    if (toolName === 'apply_patch') {
      return summarizeApplyPatch(rawPayload)
    }
    try {
      const parsed: unknown = JSON.parse(rawPayload)
      if (
        !isRecord(parsed) ||
        (parsed.params !== undefined && !isRecord(parsed.params))
      ) {
        return [`payload: ${truncatePreview(rawPayload, 600)}`]
      }
      const params = parsed.params ?? {}
      switch (toolName) {
        case 'run_command': {
          const shell =
            typeof params.shell === 'string' ? params.shell : getDefaultShell()
          return [
            `cwd: ${displayScalar(params.cwd, process.cwd())}`,
            `shell: ${shell}`,
            `timeoutMs: ${displayScalar(params.timeoutMs, 'none')}`,
            `command: ${displayScalar(params.command, '(missing)')}`,
          ]
        }
        case 'attach_image':
          return [`path: ${displayScalar(params.path, '(missing)')}`]
        case 'spawn':
          return [
            `provider: ${displayScalar(params.provider, thread.provider)}`,
            `prompt: ${truncatePreview(firstLine(displayScalar(params.prompt, '(missing)')))}`,
          ]
        case 'load_skill':
          return [`name: ${displayScalar(params.name, '(missing)')}`]
        case 'mcp_search_tool':
        case 'mcp_call_tool': {
          const lines = [
            `server: ${displayScalar(params.server, '(missing)')}`,
            `tool: ${displayScalar(params.tool, '(missing)')}`,
          ]
          if (toolName === 'mcp_call_tool') {
            lines.push(
              `arguments: ${truncatePreview(compactJson(params.arguments ?? {}), 600)}`
            )
          }
          return lines
        }
        default:
          return [`payload: ${truncatePreview(rawPayload, 600)}`]
      }
    } catch {
      return [`payload: ${truncatePreview(rawPayload, 600)}`]
    }
  }

  private summarizeToolResult(
    toolName: string,
    outcome: ToolOutcome,
    result: Record<string, unknown>
  ): string[] {
    if (outcome !== 'success') {
      const message =
        typeof result.message === 'string'
          ? result.message
          : JSON.stringify(result)
      return toLines(message ?? `${toolName} ${outcome}.`).slice(0, 4)
    }

    if (toolName === 'run_command') {
      const lines = [
        `exitCode: ${displayScalar(result.exitCode, 'null')}`,
        `timedOut: ${result.timedOut === true ? 'yes' : 'no'} · truncated: ${result.truncated === true ? 'yes' : 'no'}`,
      ]
      const stderrPreview =
        typeof result.stderr === 'string' ? result.stderr.trim() : ''
      if (stderrPreview) {
        lines.push(`stderr: ${stderrPreview.split(/\r?\n/)[0]}`)
      }
      return lines
    }

    if (toolName === 'spawn') {
      const lines = ['Spawn completed.']
      if (typeof result.provider === 'string') {
        lines.push(`provider: ${result.provider}`)
      }
      if (typeof result.conversationUrl === 'string') {
        lines.push(`conversation: ${result.conversationUrl}`)
      }
      return lines
    }

    if (toolName === 'load_skill' && typeof result.name === 'string') {
      return [`Loaded skill: ${result.name}`]
    }

    if (
      (toolName === 'mcp_search_tool' || toolName === 'mcp_call_tool') &&
      typeof result.server === 'string' &&
      typeof result.tool === 'string'
    ) {
      return [
        toolName === 'mcp_search_tool'
          ? 'MCP tool definition loaded.'
          : 'MCP tool returned a result.',
        `server: ${result.server}`,
        `tool: ${result.tool}`,
      ]
    }

    return Object.entries(result)
      .slice(0, 4)
      .map(([key, value]) => `${key}: ${formatPreviewValue(value)}`)
  }

  private formatThreadTarget(thread: ThreadHandle): string {
    return `${thread.id}@${thread.provider}`
  }

  private clearLiveAssistant(thread: ThreadHandle) {
    this.takeLiveAssistant(thread)
  }

  private takeLiveCommand(
    thread: ThreadHandle,
    toolName: string,
    toolCallId?: string
  ): LiveCommandEntry | null {
    const view = this.getThreadTimelineView(thread.id)
    const liveCommand = view.liveCommand
    if (
      liveCommand === null ||
      liveCommand.threadId !== thread.id ||
      liveCommand.toolName !== toolName ||
      liveCommand.toolCallId !== (toolCallId ?? null)
    ) {
      return null
    }

    this.cancelLiveCommandEmit(view)
    this.cancelLiveToolHeartbeat(view)
    view.liveCommandGeneration += 1
    view.commandOutputTail = null
    view.liveCommand = null
    return liveCommand
  }

  private clearPendingLiveCommand(
    thread: ThreadHandle,
    toolName: string,
    toolCallId?: string
  ): boolean {
    const view = this.getThreadTimelineView(thread.id)
    const pending = view.pendingLiveCommand
    if (
      pending === null ||
      pending.threadId !== thread.id ||
      pending.toolName !== toolName ||
      pending.toolCallId !== (toolCallId ?? null)
    ) {
      return false
    }
    view.pendingLiveCommand = null
    return true
  }

  private takeLiveAssistant(thread: ThreadHandle): LiveAssistantEntry | null {
    const view = this.getThreadTimelineView(thread.id)
    const expectedLabel = `assistant ${this.formatThreadTarget(thread)}`
    if (view.liveAssistant?.label === expectedLabel) {
      const liveAssistant = view.liveAssistant
      this.discardLiveAssistant(view)
      return liveAssistant
    }
    return null
  }

  private allocateTimelineEntryId(): number {
    const id = this.nextTimelineEntryId
    this.nextTimelineEntryId += 1
    return id
  }

  private setViewBusy(view: TimelineViewState, busy: boolean): void {
    view.busy = busy
    view.phase = busy ? 'working' : 'idle'
    this.emitView(view)
  }

  private activeTimelineView(): TimelineViewState {
    return this.getTimelineView(this.activeTimelineKey)
  }

  private getTimelineView(key: string): TimelineViewState {
    const existing = this.timelineViews.get(key)
    if (existing !== undefined) {
      return existing
    }
    const view = createTimelineView(key)
    this.timelineViews.set(key, view)
    return view
  }

  private getThreadTimelineView(threadId: string): TimelineViewState {
    if (
      this.threadManager === null &&
      this.activeTimelineKey === HOME_TIMELINE_KEY
    ) {
      return this.activeTimelineView()
    }
    return this.getTimelineView(threadId)
  }

  private emitView(view: TimelineViewState): void {
    if (view.key === this.activeTimelineKey) {
      this.emit()
    }
  }

  private emit() {
    for (const listener of this.listeners) {
      listener()
    }
  }
}

function createTimelineView(key: string): TimelineViewState {
  return {
    key,
    busy: false,
    lastToolName: null,
    phase: 'idle',
    lastAction: 'Ready.',
    liveAssistant: null,
    liveCommand: null,
    pendingLiveCommand: null,
    timeline: [],
    commandOutputTail: null,
    liveAssistantEmitTimer: null,
    lastLiveAssistantEmitAt: 0,
    liveCommandEmitTimer: null,
    lastLiveCommandEmitAt: 0,
    liveToolHeartbeatTimer: null,
    liveCommandGeneration: 0,
  }
}

function isLiveCommandTool(toolName: string): boolean {
  return toolName === 'run_command' || toolName === 'spawn'
}

function isInitialSetupMessage(
  message: ConversationHistoryMessage | undefined
): boolean {
  return (
    message?.role === 'user' && message.text.trimStart().startsWith('# System')
  )
}

function isToolResultMessage(text: string): boolean {
  return text.trimStart().startsWith('### Tool Result ###')
}

function toBodyText(body: string | readonly string[]): string {
  if (typeof body === 'string') {
    return body
  }

  return body.join('\n')
}

function toLines(body: string | readonly string[]): string[] {
  if (typeof body === 'string') {
    return body.split(/\r?\n/)
  }

  return body.flatMap((item) => item.split(/\r?\n/))
}

function firstLine(value: string): string {
  return value.split(/\r?\n/)[0] ?? ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function displayScalar(value: unknown, fallback: string): string {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value)
  }
  return fallback
}

function escapeToolTagsForMarkdown(message: string): string {
  return message.replace(/<\/?tool(?:\s+[^>]*)?>/gi, (tag) => `\\${tag}`)
}

function summarizeApplyPatch(rawPayload: string): string[] {
  const files = [
    ...rawPayload.matchAll(/^\s*\*\*\* (Add|Update) File:\s*(.+)$/gm),
  ]
  if (files.length === 0) {
    return ['payload: invalid or empty V4A patch']
  }
  const lines = files.slice(0, 8).map((match) => {
    return `${match[1]?.toLowerCase() ?? 'update'}: ${match[2]?.trim() ?? '(missing)'}`
  })
  if (files.length > lines.length) {
    lines.push(`... ${files.length - lines.length} more file(s)`)
  }
  return lines
}

function compactJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value)
    return serialized ?? String(value)
  } catch {
    return String(value)
  }
}

function truncatePreview(value: string, maxLength = 240): string {
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`
}

function formatPreviewValue(value: unknown): string {
  return truncatePreview(
    typeof value === 'string' ? value : compactJson(value),
    240
  )
}

const LIVE_ASSISTANT_EMIT_INTERVAL_MS = 120
const LIVE_COMMAND_EMIT_INTERVAL_MS = 120
const LIVE_TOOL_HEARTBEAT_INTERVAL_MS = 1000
const LIVE_COMMAND_TAIL_LINE_COUNT = 2
const MAX_COMMAND_TAIL_LINE_LENGTH = 4096

type CommandOutputStream = 'stdout' | 'stderr'

interface CommandTailRecord {
  stream: CommandOutputStream
  text: string
}

interface CommandStreamState {
  current: CommandTailRecord | null
  pendingCarriageReturn: boolean
}

class CommandOutputTail {
  private readonly records: CommandTailRecord[] = []
  private readonly streams: Record<CommandOutputStream, CommandStreamState> = {
    stdout: { current: null, pendingCarriageReturn: false },
    stderr: { current: null, pendingCarriageReturn: false },
  }

  public append(stream: CommandOutputStream, text: string): void {
    if (!text) {
      return
    }

    const state = this.streams[stream]
    let value = state.pendingCarriageReturn ? `\r${text}` : text
    state.pendingCarriageReturn = false
    if (value.endsWith('\r')) {
      state.pendingCarriageReturn = true
      value = value.slice(0, -1)
    }

    for (const token of value.split(/(\r\n|\r|\n)/)) {
      if (token === '\r') {
        this.overwrite(state)
      } else if (token === '\n' || token === '\r\n') {
        this.finish(state)
      } else if (token) {
        this.appendText(stream, state, token)
      }
    }
  }

  public toLines(): string[] {
    return this.records.map((record) =>
      record.stream === 'stderr' ? `stderr: ${record.text}` : record.text
    )
  }

  public toBody(): string {
    return this.toLines().join('\n')
  }

  private appendText(
    stream: CommandOutputStream,
    state: CommandStreamState,
    text: string
  ): void {
    const record = state.current ?? { stream, text: '' }
    if (state.current === null) {
      state.current = record
    }
    record.text += text
    if (record.text.length > MAX_COMMAND_TAIL_LINE_LENGTH) {
      record.text = record.text.slice(-MAX_COMMAND_TAIL_LINE_LENGTH)
    }
    this.touch(record)
  }

  private overwrite(state: CommandStreamState): void {
    if (state.current === null) {
      return
    }
    state.current.text = ''
    this.remove(state.current)
  }

  private finish(state: CommandStreamState): void {
    if (state.current === null) {
      return
    }
    const record = state.current
    state.current = null
    if (record.text) {
      this.touch(record)
    } else {
      this.remove(record)
    }
  }

  private touch(record: CommandTailRecord): void {
    this.remove(record)
    this.records.push(record)
    while (this.records.length > 2) {
      this.records.shift()
    }
  }

  private remove(record: CommandTailRecord): void {
    const index = this.records.indexOf(record)
    if (index >= 0) {
      this.records.splice(index, 1)
    }
  }
}
