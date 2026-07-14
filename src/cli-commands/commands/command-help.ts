import type { CliCommand } from '../core/command-types.ts'

export const HelpCommand: CliCommand = {
  name: '/help',
  description: 'Show command help.',
  async execute(context) {
    context.ui.renderCommandHelp(context.listCommands())
    return { continue: true }
  },
}
