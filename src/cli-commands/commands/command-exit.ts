import type { CliCommand } from '../core/command-types.ts'

export const ExitCommand: CliCommand = {
  name: '/exit',
  description: 'Exit portal.',
  async execute() {
    return { continue: false }
  },
}
