import type { CliCommand } from '../core/command-types.ts'

export const ProvidersCommand: CliCommand = {
  name: '/providers',
  description: 'List supported providers.',
  async execute(context) {
    context.ui.renderProviderList(context.providers)
    return { continue: true }
  },
}
