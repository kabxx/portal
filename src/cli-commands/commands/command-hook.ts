import type { CliCommand } from '../core/command-types.ts'

export const HookCommand: CliCommand = {
  name: '/hook',
  description: 'Inspect, reload, enable, or disable Hooks.',
  usage: '/hook <status|reload|enable|disable>',
  subcommands: ['status', 'reload', 'enable', 'disable'],
  async execute(context, args) {
    if (context.hookCatalog === undefined) {
      context.ui.renderError('/hook', 'Hooks are not configured.')
      return { continue: true }
    }
    const action = args[0] ?? 'status'
    if (action === 'status') {
      const status = context.hookCatalog.status()
      context.ui.renderInfo('/hook status', [
        `Hooks: ${status.enabled ? 'enabled' : 'disabled'}`,
        `Handlers: ${status.activeHandlers}/${status.handlers} active`,
        `Revision: ${status.revision}`,
        `Loaded: ${new Date(status.loadedAt).toISOString()}`,
      ])
      return { continue: true }
    }
    try {
      if (action === 'reload') {
        const snapshot = await context.hookCatalog.reload()
        context.ui.renderSuccess(
          '/hook reload',
          `Loaded ${snapshot.handlers.length} Hook handlers for new turns.`
        )
      } else if (action === 'enable' || action === 'disable') {
        const snapshot = await context.hookCatalog.setEnabled(
          action === 'enable'
        )
        context.ui.renderSuccess(
          `/hook ${action}`,
          `Hooks are ${snapshot.enabled ? 'enabled' : 'disabled'} for new turns.`
        )
      } else {
        context.ui.renderWarning(
          '/hook',
          'Usage: /hook <status|reload|enable|disable>'
        )
      }
    } catch (error) {
      context.ui.renderError(
        `/hook ${action}`,
        error instanceof Error ? error.message : String(error)
      )
    }
    return { continue: true }
  },
}
