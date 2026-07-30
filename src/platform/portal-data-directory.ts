import os from 'node:os'
import path from 'node:path'

const APPLICATION_DIRECTORY = 'portal'

export interface PortalDataDirectoryOptions {
  cwd?: string
  dataDirectory?: string
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
  platform?: NodeJS.Platform
}

export function resolvePortalDataDirectory(
  options: PortalDataDirectoryOptions = {}
): string {
  const platform = options.platform ?? process.platform
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const commandLineValue = options.dataDirectory

  if (commandLineValue !== undefined) {
    if (commandLineValue.trim() === '') {
      throw new Error('--data-dir must not be empty.')
    }
    return pathApi.resolve(cwd, commandLineValue)
  }

  const environmentValue = env.PORTAL_DATA_DIR
  if (environmentValue !== undefined && environmentValue.trim() !== '') {
    return pathApi.resolve(cwd, environmentValue)
  }

  return defaultPortalDataDirectory(
    platform,
    env,
    options.homeDirectory ?? os.homedir()
  )
}

function defaultPortalDataDirectory(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDirectory: string
): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix

  if (platform === 'win32') {
    const localAppData = absoluteEnvironmentPath(env.LOCALAPPDATA, pathApi)
    return pathApi.join(
      localAppData ?? pathApi.join(homeDirectory, 'AppData', 'Local'),
      APPLICATION_DIRECTORY
    )
  }

  if (platform === 'darwin') {
    return pathApi.join(
      homeDirectory,
      'Library',
      'Application Support',
      APPLICATION_DIRECTORY
    )
  }

  const xdgDataHome = absoluteEnvironmentPath(env.XDG_DATA_HOME, pathApi)
  return pathApi.join(
    xdgDataHome ?? pathApi.join(homeDirectory, '.local', 'share'),
    APPLICATION_DIRECTORY
  )
}

function absoluteEnvironmentPath(
  value: string | undefined,
  pathApi: path.PlatformPath
): string | null {
  return value !== undefined && pathApi.isAbsolute(value) ? value : null
}
