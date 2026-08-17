import { Command, CommanderError, InvalidArgumentError } from 'commander'
import path from 'node:path'

import {
  PluginManager,
  type AddLocalPluginOptions,
} from '../extensions/plugin-manager.ts'
import type {
  PluginCapabilityExpansionPolicy,
  PluginUpdatePolicy,
} from '../extensions/plugin-contracts.ts'
import { JsonPluginStore } from '../extensions/plugin-store.ts'
import { resolvePortalDataDirectory } from '../platform/portal-data-directory.ts'
import { firstPartyPluginRecords } from './first-party-plugins.ts'

interface TextWriter {
  write(text: string): unknown
}

export interface PluginsCliDependencies {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly homeDirectory?: string
  readonly platform?: NodeJS.Platform
  readonly output?: TextWriter
  readonly errorOutput?: TextWriter
  readonly manager?: PluginManager
}

interface RootOptions {
  readonly dataDir?: string
  readonly json?: boolean
}

export async function runPluginsCli(
  argv: readonly string[],
  dependencies: PluginsCliDependencies = {}
): Promise<number> {
  const output = dependencies.output ?? process.stdout
  const errorOutput = dependencies.errorOutput ?? process.stderr
  const program = new Command()
    .name('portal plugins')
    .description('Install, authorize, enable, and recover Portal plugins.')
    .option('--data-dir <path>', 'Portal data directory')
    .option('--json', 'Print machine-readable JSON')
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => output.write(text),
      writeErr: (text) => errorOutput.write(text),
    })

  let rawManagerPromise: Promise<PluginManager> | null = null
  let synchronizedManagerPromise: Promise<PluginManager> | null = null
  const manager = (synchronize = true): Promise<PluginManager> => {
    rawManagerPromise ??= Promise.resolve(
      dependencies.manager ??
        createPluginManager(program.opts<RootOptions>(), dependencies)
    )
    if (!synchronize || dependencies.manager !== undefined) {
      return rawManagerPromise
    }
    synchronizedManagerPromise ??= rawManagerPromise.then(async (instance) => {
      await instance.synchronizeBuiltIns(firstPartyPluginRecords())
      return instance
    })
    return synchronizedManagerPromise
  }

  program
    .command('list')
    .description(
      'List installed plugins without resolving the normal plugin graph.'
    )
    .action(async () => {
      const records = [...(await (await manager()).list())].sort((a, b) =>
        a.manifest.id.localeCompare(b.manifest.id)
      )
      if (program.opts<RootOptions>().json === true) {
        writeJson(output, records)
        return
      }
      if (records.length === 0) {
        output.write('No plugins installed.\n')
        return
      }
      for (const record of records) {
        output.write(
          `${record.enabled ? 'enabled ' : 'disabled'} ${record.manifest.id}@${record.manifest.version}\n`
        )
      }
    })

  program
    .command('inspect <id>')
    .description('Show one installed plugin record and its persisted grants.')
    .action(async (id: string) => {
      const record = await (await manager()).inspect(id)
      if (record === null) throw new Error(`Plugin is not installed: ${id}`)
      if (program.opts<RootOptions>().json === true) {
        writeJson(output, record)
        return
      }
      output.write(`${record.manifest.id}@${record.manifest.version}\n`)
      output.write(`Status: ${record.enabled ? 'enabled' : 'disabled'}\n`)
      output.write(`Source: ${record.source.locator}\n`)
      output.write(
        `Capabilities: ${record.trust.capabilities.length === 0 ? '(none)' : record.trust.capabilities.join(', ')}\n`
      )
      output.write(`Digest: ${record.source.digest}\n`)
    })

  program
    .command('add <directories...>')
    .description(
      'Install local plugin directories as one authorization transaction.'
    )
    .option(
      '--capability <id...>',
      'Grant only the listed declared capabilities'
    )
    .option(
      '--update-policy <policy>',
      'Persisted update policy',
      parseUpdatePolicy,
      'pinned'
    )
    .option(
      '--capability-expansion <policy>',
      'Policy for capabilities requested by later updates',
      parseCapabilityExpansion,
      'ask'
    )
    .action(
      async (
        directories: string[],
        options: {
          readonly capability?: string[]
          readonly updatePolicy: PluginUpdatePolicy
          readonly capabilityExpansion: PluginCapabilityExpansionPolicy
        }
      ) => {
        const installOptions: AddLocalPluginOptions = {
          updatePolicy: options.updatePolicy,
          capabilityExpansion: options.capabilityExpansion,
          ...(options.capability === undefined
            ? {}
            : { capabilities: options.capability }),
        }
        const records = await (
          await manager()
        ).addLocalDirectories(directories, installOptions)
        if (program.opts<RootOptions>().json === true) {
          writeJson(output, records)
          return
        }
        for (const record of records) {
          output.write(
            `Installed ${record.manifest.id}@${record.manifest.version}.\n`
          )
        }
      }
    )

  program
    .command('enable <id>')
    .description('Enable a plugin for the next immutable generation.')
    .action(async (id: string) => {
      if (!(await (await manager()).enable(id)))
        throw new Error(`Plugin is not installed: ${id}`)
      output.write(`Enabled ${id} for the next Portal generation.\n`)
    })

  program
    .command('disable <id>')
    .description('Disable a plugin for the next immutable generation.')
    .action(async (id: string) => {
      if (!(await (await manager()).disable(id)))
        throw new Error(`Plugin is not installed: ${id}`)
      output.write(`Disabled ${id} for the next Portal generation.\n`)
    })

  program
    .command('enable-contribution <package-id> <point> <contribution-id>')
    .description('Enable one package contribution for the next generation.')
    .action(
      async (packageId: string, point: string, contributionId: string) => {
        if (
          !(await (
            await manager()
          ).setContributionEnabled(packageId, point, contributionId, true))
        ) {
          throw new Error(`Plugin is not installed: ${packageId}`)
        }
        output.write(
          `Enabled ${point}:${contributionId} from ${packageId} for the next Portal generation.\n`
        )
      }
    )

  program
    .command('disable-contribution <package-id> <point> <contribution-id>')
    .description('Disable one package contribution for the next generation.')
    .action(
      async (packageId: string, point: string, contributionId: string) => {
        if (
          !(await (
            await manager()
          ).setContributionEnabled(packageId, point, contributionId, false))
        ) {
          throw new Error(`Plugin is not installed: ${packageId}`)
        }
        output.write(
          `Disabled ${point}:${contributionId} from ${packageId} for the next Portal generation.\n`
        )
      }
    )

  program
    .command('update <id>')
    .description(
      'Accept the current contents of a local plugin directory as an update.'
    )
    .option(
      '--allow-new-capabilities',
      'Persist grants for newly declared capabilities'
    )
    .option(
      '--allow-downgrade',
      'Allow replacing the installed version with an older version'
    )
    .action(
      async (
        id: string,
        options: {
          readonly allowNewCapabilities?: boolean
          readonly allowDowngrade?: boolean
        }
      ) => {
        const record = await (
          await manager()
        ).updateLocalDirectory(id, {
          ...(options.allowNewCapabilities === true
            ? { allowCapabilityExpansion: true }
            : {}),
          ...(options.allowDowngrade === true ? { allowDowngrade: true } : {}),
        })
        if (record === null) throw new Error(`Plugin is not installed: ${id}`)
        output.write(
          `Updated ${record.manifest.id}@${record.manifest.version}.\n`
        )
      }
    )

  program
    .command('remove <id>')
    .description('Remove an installed plugin record.')
    .action(async (id: string) => {
      if (!(await (await manager()).remove(id)))
        throw new Error(`Plugin is not installed: ${id}`)
      output.write(`Removed ${id}.\n`)
    })

  program
    .command('diagnose')
    .description(
      'Verify sources, digests, dependencies, and versions without activation.'
    )
    .action(async () => {
      const diagnostics = await (await manager(false)).diagnose()
      if (program.opts<RootOptions>().json === true) {
        writeJson(output, diagnostics)
        return
      }
      if (diagnostics.length === 0) {
        output.write('No plugin problems found.\n')
        return
      }
      for (const diagnostic of diagnostics) {
        output.write(
          `${diagnostic.packageId} [${diagnostic.code}] ${diagnostic.message}\n`
        )
      }
    })

  program
    .command('repair')
    .description(
      'Preserve unreadable plugin records and rebuild a recoverable store.'
    )
    .action(async () => {
      const instance = await manager(false)
      const result = await instance.repairStore()
      if (dependencies.manager === undefined) {
        await instance.synchronizeBuiltIns(firstPartyPluginRecords())
      }
      output.write(
        result.backupPath === null
          ? 'Plugin records were reset.\n'
          : `Plugin records were preserved at ${result.backupPath} and reset.\n`
      )
    })

  try {
    await program.parseAsync(['node', 'portal plugins', ...argv])
    return 0
  } catch (error) {
    if (
      error instanceof CommanderError &&
      error.code === 'commander.helpDisplayed'
    ) {
      return 0
    }
    if (error instanceof CommanderError) return 2
    errorOutput.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    )
    return 1
  }
}

function createPluginManager(
  options: RootOptions,
  dependencies: PluginsCliDependencies
): PluginManager {
  const dataDirectory = resolvePortalDataDirectory({
    cwd: dependencies.cwd ?? process.cwd(),
    ...(dependencies.env === undefined ? {} : { env: dependencies.env }),
    ...(dependencies.homeDirectory === undefined
      ? {}
      : { homeDirectory: dependencies.homeDirectory }),
    ...(dependencies.platform === undefined
      ? {}
      : { platform: dependencies.platform }),
    ...(options.dataDir === undefined
      ? {}
      : { dataDirectory: options.dataDir }),
  })
  return new PluginManager({
    store: new JsonPluginStore(
      path.join(dataDirectory, 'plugins', 'installed.json')
    ),
  })
}

function parseUpdatePolicy(value: string): PluginUpdatePolicy {
  if (
    value === 'pinned' ||
    value === 'trust-source' ||
    value === 'trust-publisher' ||
    value === 'trust-all-manual-adds'
  ) {
    return value
  }
  throw new InvalidArgumentError(`Unsupported update policy: ${value}`)
}

function parseCapabilityExpansion(
  value: string
): PluginCapabilityExpansionPolicy {
  if (value === 'auto-allow' || value === 'deny' || value === 'ask')
    return value
  throw new InvalidArgumentError(
    `Unsupported capability expansion policy: ${value}`
  )
}

function writeJson(output: TextWriter, value: unknown): void {
  output.write(`${JSON.stringify(value, null, 2)}\n`)
}
