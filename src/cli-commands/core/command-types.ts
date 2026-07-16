import type { Interface as ReadlineInterface } from 'readline/promises'
import type {
  ThreadHandle,
  ThreadManager,
} from '../../threads/thread-manager.ts'
import type { ThreadStore } from '../../threads/thread-store.ts'
import type { ProviderId } from '../../providers/provider-id.ts'
import type { TerminalController } from '../../terminal-ui/terminal-controller.ts'
import type {
  SkillAddResult,
  SkillLibrary,
} from '../../skills/skill-library.ts'
import type { SkillAddOptions } from '../../skills/skill-installer.ts'
import type { McpLibrary } from '../../mcp/mcp-library.ts'
import type { HookCatalog } from '../../hooks/hook-catalog.ts'
import type { KeybindingCatalog } from '../../keybindings/keybinding-catalog.ts'
import type { RunCommandJobService } from '../../processes/run-command-job-manager.ts'

export interface ListenerCommandController {
  start(): Promise<void>
  stop(): Promise<void>
  status(): { running: boolean; address: string | null; auth: boolean }
  token(): string | null
}

export interface CommandResult {
  continue: boolean
}

export interface CliCommandContext {
  readline: ReadlineInterface
  threadManager: ThreadManager
  threadStore: ThreadStore
  skillLibrary: SkillLibrary
  mcpLibrary: McpLibrary
  runCommandJobs?: RunCommandJobService
  hookCatalog?: HookCatalog
  keybindingCatalog?: KeybindingCatalog
  api?: ListenerCommandController
  mcpServer?: ListenerCommandController
  ui: TerminalController
  browserProfileDir: string
  providers: readonly ProviderId[]
  resolveProvider(value: string): ProviderId | null
  createThread(provider: ProviderId, model: string | null): Promise<void>
  resumeThread(conversationUrl: string): Promise<void>
  reloadThread?: (threadId: string) => Promise<void>
  closeThread(threadId: string): Promise<boolean>
  addSkill(source: string, options?: SkillAddOptions): Promise<SkillAddResult>
  submitThreadInput(input: string, displayInput?: string): Promise<void>
  listCommands(): readonly CliCommand[]
}

export interface CliCommand {
  name: string
  description: string
  usage?: string
  subcommands?: readonly string[]
  execute(
    context: CliCommandContext,
    args: readonly string[]
  ): Promise<CommandResult>
}

export function getActiveThread(
  context: CliCommandContext
): ThreadHandle | null {
  return context.threadManager.getActiveThread()
}
