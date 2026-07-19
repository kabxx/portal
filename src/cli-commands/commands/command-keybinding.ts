import type { CliCommand } from '../core/command-types.ts'
import { commandGuideSubcommands } from '../core/command-types.ts'

const KEYBINDING_GUIDES = [
  {
    path: ['reset'],
    usage: 'reset',
    description: 'Restore platform-default keybindings.',
  },
] as const

export const KeybindingCommand: CliCommand = {
  name: '/keybinding',
  description: 'Restore terminal shortcuts to platform defaults.',
  usage: '/keybinding reset',
  subcommands: commandGuideSubcommands(KEYBINDING_GUIDES),
  guides: KEYBINDING_GUIDES,
  async execute(context, args) {
    if (args[0] !== 'reset' || args.length !== 1) {
      context.ui.renderWarning('/keybinding', 'Usage: /keybinding reset')
      return { continue: true }
    }
    if (context.keybindingCatalog === undefined) {
      context.ui.renderError('/keybinding', 'Keybindings are not configured.')
      return { continue: true }
    }
    try {
      await context.keybindingCatalog.reset()
      context.ui.renderSuccess(
        '/keybinding reset',
        'Restored platform-default keybindings.'
      )
    } catch (error) {
      context.ui.renderError(
        '/keybinding reset',
        error instanceof Error ? error.message : String(error)
      )
    }
    return { continue: true }
  },
}
