import { createHash } from 'node:crypto'

import type { CommandServiceHost } from '../cli-commands/core/command-services.ts'
import type {
  BuiltInPluginRecord,
  PluginManifest,
} from '../extensions/plugin-contracts.ts'
import type { BuiltInPluginDefinition } from './kernel-bootstrap.ts'
import type { PluginManager } from '../extensions/plugin-manager.ts'
import { FIRST_PARTY_PROVIDER_IDS } from '../providers/first-party-provider-id.ts'
import { FIRST_PARTY_PROVIDER_PACKAGE_PREFIX } from '../providers/first-party-provider-plugin.ts'
import { PROVIDER_ATTACHMENT_CAPABILITY } from '../providers/provider-exchange.ts'
import { PORTAL_SKILLS_PACKAGE_ID } from '../skills/skill-services.ts'
import { PORTAL_SKILL_COMMAND_PACKAGE_ID } from '../skills/skill-command-plugin.ts'

const PORTAL_COMMANDS = 'portal.commands'
const ATTACH_IMAGE = 'portal.tool.attach-image'
const RUN_COMMAND = 'portal.tool.run-command'
const APPLY_PATCH = 'portal.tool.apply-patch'
const SPAWN = 'portal.tool.spawn'
const PLUGINS = 'portal.plugins'
const TUI_SURFACE = 'portal.surface.tui'
const EXEC_SURFACE = 'portal.surface.exec'
const MCP_SURFACE = 'portal.surface.mcp'

const FIRST_PARTY_MANIFESTS: readonly PluginManifest[] = Object.freeze([
  manifest(
    PORTAL_COMMANDS,
    [],
    [
      'portal.command.thread.read',
      'portal.command.thread.manage',
      'portal.command.provider.capability.manage',
      'portal.command.mcp.manage',
      'portal.command.job.read',
      'portal.command.job.manage',
      'portal.command.keybinding.manage',
    ],
    [
      contribution('commands.collect', 'commands.help'),
      contribution('commands.collect', 'commands.thread'),
      contribution('commands.collect', 'commands.mcp'),
      contribution('commands.collect', 'commands.providers'),
      contribution('commands.collect', 'commands.keybinding'),
      contribution('commands.collect', 'commands.exit'),
    ]
  ),
  manifest(PORTAL_SKILLS_PACKAGE_ID, [], [], []),
  manifest(
    PORTAL_SKILL_COMMAND_PACKAGE_ID,
    [
      { id: PORTAL_COMMANDS, versionRange: '^1.0.0' },
      { id: PORTAL_SKILLS_PACKAGE_ID, versionRange: '^1.0.0' },
    ],
    ['portal.command.skill.read', 'portal.command.skill.manage'],
    [contribution('commands.collect', 'commands.skill')]
  ),
  manifest(
    ATTACH_IMAGE,
    [],
    ['portal.provider.attachments'],
    [contribution('tools.collect', ATTACH_IMAGE)]
  ),
  manifest(
    RUN_COMMAND,
    [{ id: PORTAL_COMMANDS, versionRange: '^1.0.0' }],
    ['portal.command.job.read', 'portal.command.job.manage'],
    [
      contribution('tools.collect', RUN_COMMAND),
      contribution('commands.collect', `${RUN_COMMAND}.command`),
      contribution(
        'surface.features.collect',
        `${RUN_COMMAND}.mcp-job-management`
      ),
    ]
  ),
  manifest(APPLY_PATCH, [], [], [contribution('tools.collect', APPLY_PATCH)]),
  manifest(SPAWN, [], [], [contribution('tools.collect', SPAWN)]),
  manifest(
    PLUGINS,
    [{ id: PORTAL_COMMANDS, versionRange: '^1.0.0' }],
    ['portal.command.plugin.read', 'portal.command.plugin.manage'],
    [contribution('commands.collect', `${PLUGINS}.command`)]
  ),
  manifest(
    TUI_SURFACE,
    [],
    [],
    [contribution('surfaces.collect', 'portal.tui')]
  ),
  manifest(
    EXEC_SURFACE,
    [],
    [],
    [contribution('surfaces.collect', 'portal.exec')]
  ),
  manifest(
    MCP_SURFACE,
    [],
    [],
    [contribution('surfaces.collect', 'portal.mcp')]
  ),
  ...FIRST_PARTY_PROVIDER_IDS.map((providerId) =>
    manifest(
      `${FIRST_PARTY_PROVIDER_PACKAGE_PREFIX}${providerId}`,
      [{ id: PORTAL_SKILLS_PACKAGE_ID, versionRange: '^1.0.0' }],
      [PROVIDER_ATTACHMENT_CAPABILITY],
      [contribution('providers.collect', providerId)]
    )
  ),
])

export function firstPartyPluginRecords(): readonly BuiltInPluginRecord[] {
  return Object.freeze(
    FIRST_PARTY_MANIFESTS.map((manifestValue) => {
      const digest = createHash('sha256')
        .update(JSON.stringify(manifestValue))
        .digest('hex')
      return Object.freeze({
        manifest: manifestValue,
        source: Object.freeze({
          kind: 'built-in' as const,
          locator: `portal:built-in/${manifestValue.id}`,
          digest,
        }),
        trust: Object.freeze({
          capabilities: manifestValue.capabilities,
          updatePolicy: 'pinned' as const,
          capabilityExpansion: 'deny' as const,
        }),
        disabledContributions: Object.freeze([]),
      })
    })
  )
}

export function createFirstPartyPluginDefinitions(options: {
  readonly commandServices: CommandServiceHost
  readonly pluginManager: PluginManager
  readonly commandDefinitions: readonly import('../cli-commands/command-extension.ts').BuiltinCommandDefinition[]
}): readonly BuiltInPluginDefinition[] {
  const records = new Map(
    firstPartyPluginRecords().map((record) => [record.manifest.id, record])
  )
  const definition = (
    id: string,
    load: BuiltInPluginDefinition['load']
  ): BuiltInPluginDefinition => {
    const record = records.get(id)
    if (record === undefined)
      throw new Error(`Unknown first-party plugin: ${id}`)
    return Object.freeze({ record, load })
  }

  return Object.freeze([
    definition(PORTAL_COMMANDS, async () => {
      const [
        { createPortalCommandsRegistration },
        { builtinCommandDefinitions },
      ] = await Promise.all([
        import('../cli-commands/command-extension.ts'),
        import('../cli-commands/builtin-commands.ts'),
      ])
      return {
        packageId: PORTAL_COMMANDS,
        ...createPortalCommandsRegistration(
          options.commandServices,
          options.commandDefinitions.length === 0
            ? builtinCommandDefinitions
            : options.commandDefinitions
        ),
      }
    }),
    definition(PORTAL_SKILLS_PACKAGE_ID, async () => {
      const { createSkillPluginRegistration } =
        await import('../skills/skill-plugin.ts')
      return {
        packageId: PORTAL_SKILLS_PACKAGE_ID,
        ...createSkillPluginRegistration(),
      }
    }),
    definition(PORTAL_SKILL_COMMAND_PACKAGE_ID, async () => {
      const { createSkillCommandRegistration } =
        await import('../skills/skill-command-plugin.ts')
      return {
        packageId: PORTAL_SKILL_COMMAND_PACKAGE_ID,
        ...createSkillCommandRegistration(),
      }
    }),
    definition(ATTACH_IMAGE, async () => {
      const { createAttachImagePlugin } =
        await import('../tools/builtins/attach-image-plugin.ts')
      const plugin = createAttachImagePlugin()
      return { packageId: ATTACH_IMAGE, ...plugin }
    }),
    definition(RUN_COMMAND, async () => {
      const { RunCommandPlugin } =
        await import('../tools/builtins/run-command-plugin.ts')
      const plugin = new RunCommandPlugin()
      return { packageId: RUN_COMMAND, ...plugin.registration }
    }),
    definition(APPLY_PATCH, async () => {
      const { createApplyPatchPlugin } =
        await import('../tools/builtins/apply-patch-plugin.ts')
      const plugin = createApplyPatchPlugin()
      return { packageId: APPLY_PATCH, ...plugin }
    }),
    definition(SPAWN, async () => {
      const { createSpawnPlugin } =
        await import('../tools/builtins/spawn-plugin.ts')
      const plugin = createSpawnPlugin()
      return { packageId: SPAWN, ...plugin }
    }),
    definition(PLUGINS, async () => {
      const { createPluginsRegistration } = await import('./plugins-plugin.ts')
      return {
        packageId: PLUGINS,
        ...createPluginsRegistration(options.pluginManager),
      }
    }),
    definition(TUI_SURFACE, async () => {
      const { createTuiSurfaceRegistration } =
        await import('../app/tui-surface-plugin.ts')
      return {
        packageId: TUI_SURFACE,
        ...createTuiSurfaceRegistration(),
      }
    }),
    definition(EXEC_SURFACE, async () => {
      const { createExecSurfaceRegistration } =
        await import('../exec/exec-surface-plugin.ts')
      return {
        packageId: EXEC_SURFACE,
        ...createExecSurfaceRegistration(),
      }
    }),
    definition(MCP_SURFACE, async () => {
      const { createMcpSurfaceRegistration } =
        await import('../mcp-server/mcp-surface-plugin.ts')
      return {
        packageId: MCP_SURFACE,
        ...createMcpSurfaceRegistration(),
      }
    }),
    ...FIRST_PARTY_PROVIDER_IDS.map((providerId) =>
      definition(
        `${FIRST_PARTY_PROVIDER_PACKAGE_PREFIX}${providerId}`,
        async () => {
          const { createFirstPartyProviderRegistration } =
            await import('../providers/first-party-provider-plugin.ts')
          return {
            packageId: `${FIRST_PARTY_PROVIDER_PACKAGE_PREFIX}${providerId}`,
            ...createFirstPartyProviderRegistration(providerId),
          }
        }
      )
    ),
  ])
}

function manifest(
  id: string,
  dependencies: readonly {
    readonly id: string
    readonly versionRange: string
  }[] = [],
  capabilities: readonly string[] = [],
  contributions: readonly {
    readonly point: string
    readonly id: string
  }[] = []
): PluginManifest {
  return Object.freeze({
    id,
    version: '1.0.0',
    apiVersion: 1,
    entry: 'built-in',
    dependencies: Object.freeze(dependencies),
    contributions: Object.freeze(
      contributions.map(({ point, id: contributionId }) =>
        Object.freeze({ point, id: contributionId, version: 1 })
      )
    ),
    capabilities: Object.freeze([...capabilities]),
  })
}

function contribution(
  point: string,
  id: string
): { readonly point: string; readonly id: string } {
  return Object.freeze({ point, id })
}
