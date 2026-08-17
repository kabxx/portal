import type {
  CommandContribution,
  CommandHandler,
  CommandResult,
} from '../cli-commands/core/command-contracts.ts'
import { commandOutputService } from '../cli-commands/core/command-services.ts'
import {
  commandContributions,
  commandHandlerBindings,
} from '../cli-commands/core/command-plan.ts'
import type {
  ExtensionDescriptor,
  ExtensionModule,
  ExtensionRegistrationApi,
} from '../extensions/extension-contracts.ts'
import {
  contributionLabel,
  createPluginManagementService,
  pluginManagementService,
} from '../extensions/plugin-management-service.ts'
import type { PluginManager } from '../extensions/plugin-manager.ts'

const PACKAGE_ID = 'portal.plugins'
const COMMAND_ID = 'portal.plugins.command'
const HANDLER_ID = `${COMMAND_ID}.handler`
const CONTINUE: CommandResult = Object.freeze({ disposition: 'continue' })

export const pluginsDescriptor: ExtensionDescriptor = Object.freeze({
  id: PACKAGE_ID,
  version: '1.0.0',
  dependencies: Object.freeze(['portal.commands']),
  capabilities: Object.freeze([
    'portal.command.plugin.read',
    'portal.command.plugin.manage',
  ]),
})

const pluginsCommand: CommandContribution = Object.freeze({
  id: COMMAND_ID,
  primaryName: '/plugins',
  aliases: Object.freeze([]),
  usage:
    '/plugins <list|inspect|add|update|enable|disable|remove|diagnose|enable-contribution|disable-contribution>',
  description: 'Inspect and manage Portal plugins for the next generation.',
  routes: Object.freeze([
    route('root', [], []),
    route('list', ['list'], []),
    route('inspect', ['inspect'], [required('package-id')]),
    route('add', ['add'], [oneOrMore('source')]),
    route('update', ['update'], [required('package-id')]),
    route('enable', ['enable'], [required('package-id')]),
    route('disable', ['disable'], [required('package-id')]),
    route('remove', ['remove'], [required('package-id')]),
    route('diagnose', ['diagnose'], []),
    route(
      'enable-contribution',
      ['enable-contribution'],
      [required('package-id'), required('point'), required('contribution-id')]
    ),
    route(
      'disable-contribution',
      ['disable-contribution'],
      [required('package-id'), required('point'), required('contribution-id')]
    ),
  ]),
})

export function createPluginsRegistration(manager: PluginManager): {
  readonly descriptor: ExtensionDescriptor
  readonly module: ExtensionModule
} {
  const management = createPluginManagementService(manager)
  const handler: CommandHandler = async (invocation, context) => {
    const [output, plugins] = await Promise.all([
      context.services.get(commandOutputService),
      context.services.get(pluginManagementService),
    ])
    const packageId = positional(invocation, 'package-id')
    if (invocation.routeId === 'root' || invocation.routeId === 'list') {
      const records = [...(await plugins.list())].sort((a, b) =>
        a.manifest.id.localeCompare(b.manifest.id)
      )
      output.write({
        level: 'info',
        title: '/plugins list',
        body:
          records.length === 0
            ? 'No plugins installed.'
            : records.map(
                (record) =>
                  `${record.enabled ? 'enabled' : 'disabled'} ${record.manifest.id}@${record.manifest.version}`
              ),
        format: 'plain',
      })
      return CONTINUE
    }
    if (invocation.routeId === 'inspect') {
      const record = await plugins.inspect(packageId)
      output.write({
        level: record === null ? 'error' : 'info',
        title: '/plugins inspect',
        body:
          record === null
            ? `Plugin is not installed: ${packageId}`
            : [
                `${record.manifest.id}@${record.manifest.version}`,
                `Status: ${record.enabled ? 'enabled' : 'disabled'}`,
                `Disabled contributions: ${
                  record.disabledContributions.length === 0
                    ? '(none)'
                    : record.disabledContributions
                        .map(contributionLabel)
                        .join(', ')
                }`,
              ],
        format: 'plain',
      })
      return CONTINUE
    }
    if (invocation.routeId === 'add') {
      const records = await plugins.addLocalDirectories(
        positionalValues(invocation, 'source')
      )
      output.write({
        level: 'success',
        title: '/plugins add',
        body: records.map(
          (record) =>
            `Installed ${record.manifest.id}@${record.manifest.version} for the next Portal generation.`
        ),
        format: 'plain',
      })
      return CONTINUE
    }
    if (invocation.routeId === 'update') {
      const record = await plugins.updateLocalDirectory(packageId)
      output.write({
        level: record === null ? 'error' : 'success',
        title: '/plugins update',
        body:
          record === null
            ? `Plugin is not installed: ${packageId}`
            : `Updated ${record.manifest.id}@${record.manifest.version} for the next Portal generation.`,
        format: 'plain',
      })
      return CONTINUE
    }
    if (invocation.routeId === 'diagnose') {
      const diagnostics = await plugins.diagnose()
      output.write({
        level: diagnostics.length === 0 ? 'success' : 'warning',
        title: '/plugins diagnose',
        body:
          diagnostics.length === 0
            ? 'Plugin store and installed packages are healthy.'
            : diagnostics.map(
                (diagnostic) =>
                  `${diagnostic.packageId}: ${diagnostic.code} - ${diagnostic.message}`
              ),
        format: 'plain',
      })
      return CONTINUE
    }
    const enabled =
      invocation.routeId === 'enable' ||
      invocation.routeId === 'enable-contribution'
    const contributionOperation = invocation.routeId.endsWith('-contribution')
    if (invocation.routeId === 'remove') {
      const removed = await plugins.remove(packageId)
      output.write({
        level: removed ? 'success' : 'error',
        title: '/plugins remove',
        body: removed
          ? `Removed ${packageId} for the next Portal generation.`
          : `Plugin is not installed: ${packageId}`,
        format: 'plain',
      })
      return CONTINUE
    }
    const found = contributionOperation
      ? await plugins.setContributionEnabled(
          packageId,
          positional(invocation, 'point'),
          positional(invocation, 'contribution-id'),
          enabled
        )
      : enabled
        ? await plugins.enable(packageId)
        : await plugins.disable(packageId)
    output.write({
      level: found ? 'success' : 'error',
      title: '/plugins',
      body: found
        ? `Plugin change recorded for the next Portal generation.`
        : `Plugin is not installed: ${packageId}`,
      format: 'plain',
    })
    return CONTINUE
  }
  const module: ExtensionModule = Object.freeze({
    register(api: ExtensionRegistrationApi): void {
      api.provide(pluginManagementService, {
        dependencies: Object.freeze([]),
        create: async () => management,
      })
      api.contribute(commandContributions, {
        id: COMMAND_ID,
        value: pluginsCommand,
        requiredServices: Object.freeze([
          commandOutputService,
          pluginManagementService,
        ]),
        requiredCapabilities: pluginsDescriptor.capabilities,
      })
      api.bind(commandHandlerBindings, {
        id: HANDLER_ID,
        targetId: COMMAND_ID,
        binding: handler,
      })
    },
  })
  return Object.freeze({ descriptor: pluginsDescriptor, module })
}

function route(
  id: string,
  routePath: readonly string[],
  positionals: readonly PositionalSpec[]
) {
  return Object.freeze({
    id,
    path: Object.freeze([...routePath]),
    availability: 'always' as const,
    positionals: Object.freeze([...positionals]),
    options: Object.freeze([]),
    constraints: Object.freeze([]),
    help: Object.freeze([]),
  })
}

interface PositionalSpec {
  readonly name: string
  readonly cardinality: 'required' | 'optional' | 'one-or-more' | 'zero-or-more'
}

function required(name: string) {
  return Object.freeze({ name, cardinality: 'required' as const })
}

function oneOrMore(name: string) {
  return Object.freeze({ name, cardinality: 'one-or-more' as const })
}

function positional(
  invocation: Parameters<CommandHandler>[0],
  name: string
): string {
  const value = invocation.arguments.positionals[name]
  return typeof value === 'string' ? value : ''
}

function positionalValues(
  invocation: Parameters<CommandHandler>[0],
  name: string
): readonly string[] {
  const value = invocation.arguments.positionals[name]
  if (value === null || value === undefined) return []
  return typeof value === 'string' ? [value] : value
}
