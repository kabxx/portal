import type { CliCommand } from './core/command-types.ts'
import { ExitCommand } from './commands/command-exit.ts'
import { HelpCommand } from './commands/command-help.ts'
import { ProvidersCommand } from './commands/command-providers.ts'
import { ThreadCommand } from './commands/command-thread.ts'
import { SkillCommand } from './commands/command-skill.ts'
import { McpCommand } from './commands/command-mcp.ts'
import { ServeCommand } from './commands/command-serve.ts'
import { HookCommand } from './commands/command-hook.ts'
import { JobCommand } from './commands/command-job.ts'
import { KeybindingCommand } from './commands/command-keybinding.ts'

export const DEFAULT_COMMANDS: readonly CliCommand[] = [
  HelpCommand,
  ThreadCommand,
  SkillCommand,
  McpCommand,
  ServeCommand,
  HookCommand,
  JobCommand,
  KeybindingCommand,
  ProvidersCommand,
  ExitCommand,
]
