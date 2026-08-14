import path from 'node:path'

import { createToolServices } from '../app/app-spawn-tool-services.ts'
import {
  createPortalRuntimeSettings,
  type PortalRuntimeSettings,
} from '../app/app-runtime-settings.ts'
import { createAdapterForProvider } from '../app/app-provider-catalog.ts'
import {
  closeWithTimeout,
  createIdempotentAsyncTask,
} from '../app/app-lifecycle.ts'
import {
  createDefaultPortalConfig,
  ensurePortalConfig,
} from '../config/portal-config.ts'
import { HookCatalog } from '../hooks/hook-catalog.ts'
import { createHookSnapshot } from '../hooks/hook-config.ts'
import { HookDispatcher } from '../hooks/hook-dispatcher.ts'
import { HookEventBus } from '../hooks/hook-event-sink.ts'
import {
  loadProjectInstructions,
  type ProjectInstructions,
} from '../instructions/project-instructions.ts'
import { launchBrowser } from '../platform/browser-cdp-launcher.ts'
import { resolvePortalDataDirectory } from '../platform/portal-data-directory.ts'
import { RunCommandJobManager } from '../processes/run-command-job-manager.ts'
import { resolveConversationUrl } from '../providers/provider-conversation-url.ts'
import type { RuntimeCore } from '../runtime/runtime-core.ts'
import { ChildRuntimeFactory } from '../runtime/child-runtime-factory.ts'
import { throwIfAborted } from '../runtime/runtime-cancellation.ts'
import { createRuntimeFromAdapter } from '../runtime/runtime-factory.ts'
import { sleepWithAbortAsync } from '../shared/sleep.ts'
import { SkillLibrary } from '../skills/skill-library.ts'
import {
  ThreadLifecycleService,
  type ThreadLifecycleEvent,
} from '../threads/thread-lifecycle-service.ts'
import { ThreadManager } from '../threads/thread-manager.ts'
import { ThreadOperationCoordinator } from '../threads/thread-operation-coordinator.ts'
import { ThreadRuntimeRegistry } from '../threads/thread-runtime-registry.ts'
import {
  buildThreadHistoryTitle,
  createThreadStore,
  type ThreadStore,
} from '../threads/thread-store.ts'
import type {
  ExecProgressEvent,
  PortalExecSession,
  PortalExecSessionOptions,
} from './exec-types.ts'

const LOGIN_CHECK_INTERVAL_MS = 1000

export async function createPortalExecSession(
  options: PortalExecSessionOptions
): Promise<PortalExecSession> {
  return await PortalApplicationCore.open(options)
}

export interface PortalApplicationCoreDependencies {
  launchBrowser?: typeof launchBrowser
  createProviderAdapter?: typeof createAdapterForProvider
  createRuntime?: typeof createRuntimeFromAdapter
}

/** UI-independent application composition used by one-shot execution. */
export class PortalApplicationCore implements PortalExecSession {
  private threadId: string | null = null
  private unsubscribeThreadPageClose: (() => void) | null = null

  private constructor(
    private readonly options: PortalExecSessionOptions,
    private readonly lifecycle: ThreadLifecycleService,
    private readonly threadManager: ThreadManager,
    private readonly runCommandJobs: RunCommandJobManager,
    private readonly threadStore: ThreadStore,
    private readonly browserLaunch: Awaited<ReturnType<typeof launchBrowser>>,
    private readonly shutdown: () => Promise<void>
  ) {}

  public static async open(
    options: PortalExecSessionOptions,
    dependencies: PortalApplicationCoreDependencies = {}
  ): Promise<PortalApplicationCore> {
    const launchBrowserImpl = dependencies.launchBrowser ?? launchBrowser
    const createProviderAdapter =
      dependencies.createProviderAdapter ?? createAdapterForProvider
    const createRuntime = dependencies.createRuntime ?? createRuntimeFromAdapter
    throwIfAborted(options.signal)
    const dataDirectory = resolvePortalDataDirectory({
      cwd: options.cwd,
      ...(options.dataDirectory === undefined
        ? {}
        : { dataDirectory: options.dataDirectory }),
    })
    const configPath = path.join(dataDirectory, 'config.yaml')
    const defaults = createDefaultPortalConfig(dataDirectory)
    const settings = createPortalRuntimeSettings()
    const skillRegistryPath = path.join(dataDirectory, 'state', 'skills.json')
    const portalConfig = await ensurePortalConfig(configPath, defaults)
    const skillLibrary = new SkillLibrary({
      skillsDirectory: path.join(dataDirectory, 'skills'),
      tempDirectory: path.join(dataDirectory, 'temp', 'skill-install'),
      registryPath: skillRegistryPath,
    })
    await skillLibrary.initialize()
    const projectInstructions = await loadProjectInstructions({
      cwd: options.cwd,
      enabled: portalConfig.projectInstructions,
    })
    const hookCatalog = new HookCatalog(
      configPath,
      createHookSnapshot(portalConfig.hooks)
    )
    const hookDispatcher = new HookDispatcher(null, new HookEventBus())
    const browserEngine = 'chromium'
    const browserExecutablePath = path.resolve(
      options.browserExecutablePath ?? portalConfig.browser.executablePath
    )
    const browserRemoteDebuggingPort = 0
    const browserProfileDir = path.resolve(portalConfig.browser.profilePath)
    const threadStore = await createThreadStore(
      path.join(dataDirectory, 'threads.db')
    )
    options.onProgress({
      type: 'status',
      message: `Connecting to ${options.provider}...`,
    })
    let browserLaunch: Awaited<ReturnType<typeof launchBrowser>>
    try {
      browserLaunch = await launchBrowserImpl(
        browserEngine,
        browserExecutablePath,
        browserRemoteDebuggingPort,
        browserProfileDir,
        { signal: options.signal }
      )
    } catch (error) {
      threadStore.close()
      throw error
    }
    const threadManager = new ThreadManager(
      hookCatalog,
      hookDispatcher,
      options.cwd
    )
    const threadOperations = new ThreadOperationCoordinator()
    const runtimeRegistry = new ThreadRuntimeRegistry<RuntimeCore>()
    const runCommandJobs = new RunCommandJobManager()
    const context = browserLaunch.context

    const lifecycle = new ThreadLifecycleService({
      threadManager,
      threadOperations,
      threadStore,
      runtimeRegistry,
      browserProfileDir,
      resolveConversationUrl,
      projectInstructions,
      createAdapter: async ({ provider, conversationUrl, signal }) =>
        await createProviderAdapter(context, provider, conversationUrl, signal),
      createRuntime: async ({
        adapter,
        provider,
        model,
        projectInstructions,
        signal,
      }) =>
        await createRuntime(adapter, {
          model,
          setupMode: 'inline',
          skillLibrary,
          projectInstructions,
          hookDispatcher,
          advertiseSpawnTool: settings.spawnDepthLimit > 0,
          workingDirectory: options.cwd,
          toolServices: createToolServices({
            context,
            provider,
            model,
            skillLibrary,
            projectInstructions,
            runCommandJobs,
            hookDispatcher,
            settings,
            currentSpawnDepth: 0,
            workingDirectory: options.cwd,
          }),
          signal,
        }),
      waitForLogin: async (signal) =>
        await sleepWithAbortAsync(LOGIN_CHECK_INTERVAL_MS, signal),
      observer: {
        onEvent: (event) =>
          reportLifecycleEvent(
            (progressEvent) => options.onProgress(progressEvent),
            event
          ),
      },
    })

    configureHookModelExecutor({
      hookDispatcher,
      context,
      skillLibrary,
      projectInstructions,
      runCommandJobs,
      settings,
      workingDirectory: options.cwd,
      createProviderAdapter,
      createRuntime,
    })

    const holder: { core: PortalApplicationCore | null } = { core: null }
    const shutdown = createIdempotentAsyncTask(async () => {
      holder.core?.unsubscribeThreadPageClose?.()
      if (holder.core !== null) holder.core.unsubscribeThreadPageClose = null
      runCommandJobs.beginShutdown()
      await lifecycle.cancelAll()
      await runCommandJobs.stopAll()
      for (const thread of threadManager.listThreads()) {
        await closeWithTimeout(
          async () =>
            await lifecycle.close(thread.id, 'shutdown').then(() => {})
        )
      }
      await closeWithTimeout(async () => await browserLaunch.close())
      threadStore.close()
    })
    const core = new PortalApplicationCore(
      options,
      lifecycle,
      threadManager,
      runCommandJobs,
      threadStore,
      browserLaunch,
      shutdown
    )
    holder.core = core
    core.unsubscribeThreadPageClose = threadManager.onThreadPageClosed(
      (threadId) => {
        void lifecycle.close(threadId, 'provider_page_closed').catch(() => {})
      }
    )
    return core
  }

  public async run(task: string, signal: AbortSignal): Promise<string> {
    if (this.threadId !== null) {
      throw new Error('An exec session can run only one task.')
    }
    const disconnected = this.browserLaunch.disconnected.then<never>(() => {
      throw new Error('Browser disconnected while the exec task was running.')
    })
    const execution = this.executeTask(task, signal)
    return await Promise.race([execution, disconnected])
  }

  private async executeTask(
    task: string,
    signal: AbortSignal
  ): Promise<string> {
    const provision = await this.lifecycle.create(
      {
        provider: this.options.provider,
        model: this.options.model,
        mode: 'agent',
        source: 'exec',
        activate: false,
        persistInitialHistory: false,
      },
      signal
    )
    if (!provision.ok) throw new Error(provision.failure.message)
    this.threadId = provision.threadId
    const result = await this.lifecycle.send(provision.threadId, task, {
      signal,
      source: 'exec',
      onTurnItem: async (item) => {
        if (item.kind === 'status') {
          this.options.onProgress({ type: 'status', message: item.text })
        } else if (item.kind === 'tool_call') {
          this.options.onProgress({ type: 'tool', name: item.toolName })
        } else if (item.kind === 'error') {
          this.options.onProgress({ type: 'warning', message: item.text })
        }
      },
    })
    if (result === null) throw new Error('The exec thread could not run.')
    const persistenceWarning = await this.lifecycle.recordActivity({
      threadId: provision.threadId,
      provider: provision.provider,
      conversationUrl: provision.conversationUrl,
      title: buildThreadHistoryTitle(task),
      createdAt: provision.createdAt,
    })
    if (persistenceWarning !== null) {
      this.options.onProgress({
        type: 'warning',
        message: persistenceWarning,
      })
    }
    return result.assistant
  }

  public async close(): Promise<void> {
    await this.shutdown()
  }
}

function reportLifecycleEvent(
  onProgress: (event: ExecProgressEvent) => void,
  event: ThreadLifecycleEvent
): void {
  if (event.type === 'provision.warning') {
    onProgress({ type: 'warning', message: event.lines.join(' ') })
  } else if (event.type === 'provision.login_wait') {
    onProgress({
      type: 'status',
      message: `Waiting for ${event.provider} login...`,
    })
  } else if (event.type === 'thread.ready') {
    const conversation = resolveConversationUrl(event.conversationUrl)
    onProgress({
      type: 'status',
      message:
        conversation === null
          ? `Connected to ${event.provider}.`
          : `Conversation: ${conversation.conversationUrl}`,
    })
  }
}

function configureHookModelExecutor({
  hookDispatcher,
  context,
  skillLibrary,
  projectInstructions,
  runCommandJobs,
  settings,
  workingDirectory,
  createProviderAdapter,
  createRuntime,
}: {
  hookDispatcher: HookDispatcher
  context: Parameters<typeof createToolServices>[0]['context']
  skillLibrary: SkillLibrary
  projectInstructions: ProjectInstructions
  runCommandJobs: RunCommandJobManager
  settings: PortalRuntimeSettings
  workingDirectory: string
  createProviderAdapter: typeof createAdapterForProvider
  createRuntime: typeof createRuntimeFromAdapter
}): void {
  hookDispatcher.setModelExecutor(
    new ChildRuntimeFactory('chatgpt', async (request) => {
      const adapter = await createProviderAdapter(
        context,
        request.provider,
        null,
        request.signal
      )
      let runtime: RuntimeCore | null = null
      try {
        runtime = await createRuntime(adapter, {
          model: null,
          setupMode: 'full',
          skillLibrary,
          projectInstructions,
          hookDispatcher,
          workingDirectory,
          allowedTools: request.allowedTools,
          toolServices: createToolServices({
            context,
            provider: request.provider,
            model: null,
            skillLibrary,
            projectInstructions,
            runCommandJobs,
            hookDispatcher,
            settings,
            currentSpawnDepth: request.executionScope.spawnDepth,
            workingDirectory,
          }),
          signal: request.signal,
        })
        const childRuntime = runtime
        return {
          runtime: childRuntime,
          close: async () => await childRuntime.close(),
        }
      } catch (error) {
        if (runtime !== null) await runtime.close().catch(() => {})
        else await adapter.close().catch(() => {})
        throw error
      }
    })
  )
}
