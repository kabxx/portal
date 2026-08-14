import { Command, CommanderError } from 'commander'
import path from 'node:path'

import { resolvePortalDataDirectory } from '../platform/portal-data-directory.ts'

interface TextWriter {
  write(text: string): unknown
}

export interface ConfigCliDependencies {
  cwd?: string
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
  platform?: NodeJS.Platform
  output?: TextWriter
  errorOutput?: TextWriter
}

export async function runConfigCli(
  argv: readonly string[],
  dependencies: ConfigCliDependencies = {}
): Promise<number> {
  const output = dependencies.output ?? process.stdout
  const errorOutput = dependencies.errorOutput ?? process.stderr
  const program = new Command()
    .name('portal config')
    .description('Print the Portal configuration file path.')
    .option('--data-dir <path>', 'Portal data directory')
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => output.write(text),
      writeErr: (text) => errorOutput.write(text),
    })

  try {
    program.parse(['node', 'portal config', ...argv])
  } catch (error) {
    if (
      error instanceof CommanderError &&
      error.code === 'commander.helpDisplayed'
    ) {
      return 0
    }
    return 2
  }

  try {
    const options = program.opts<{ dataDir?: string }>()
    const platform = dependencies.platform ?? process.platform
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
    const pathApi = platform === 'win32' ? path.win32 : path.posix
    output.write(`${pathApi.join(dataDirectory, 'config.yaml')}\n`)
    return 0
  } catch (error) {
    errorOutput.write(
      `${error instanceof Error ? error.message : 'Invalid configuration path.'}\n`
    )
    return 2
  }
}
