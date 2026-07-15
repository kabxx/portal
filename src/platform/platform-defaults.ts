import os from 'node:os'
import { existsSync } from 'node:fs'
import path from 'node:path'

export type PortalPlatform = 'win32' | 'darwin' | 'linux'
export type BrowserEngine = 'chromium'

export type RunCommandShell =
  | 'powershell'
  | 'cmd'
  | 'bash'
  | 'zsh'
  | 'fish'
  | 'sh'

export interface ShellCommand {
  file: string
  args: string[]
}

type FileExists = (filePath: string) => boolean

export function getDefaultBrowserExecutableCandidates(
  platform: PortalPlatform = getPortalPlatform(),
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir()
): string[] {
  const candidates =
    platform === 'win32'
      ? getWindowsBrowserCandidates(environment, homeDirectory)
      : platform === 'darwin'
        ? getMacBrowserCandidates(homeDirectory)
        : getLinuxBrowserCandidates()

  return uniquePaths(
    [...candidates, ...getBrowserPathCandidates(platform, environment)],
    platform
  )
}

export function getDefaultShell(
  platform: PortalPlatform = getPortalPlatform(),
  environment: NodeJS.ProcessEnv = process.env,
  fileExists: FileExists = existsSync
): RunCommandShell {
  if (platform === 'win32') {
    return 'powershell'
  }

  const shellPath = environment.SHELL ?? ''
  const shellName = getPlatformPath(platform).basename(shellPath)
  if (
    isPosixShell(shellName) &&
    resolveConfiguredShellExecutable(
      shellName,
      platform,
      environment,
      fileExists
    ) !== null
  ) {
    return shellName
  }
  if (
    platform === 'darwin' &&
    isShellAvailable('zsh', platform, environment, fileExists)
  ) {
    return 'zsh'
  }
  if (isShellAvailable('bash', platform, environment, fileExists)) {
    return 'bash'
  }
  return 'sh'
}

export function getSupportedShells(
  platform: PortalPlatform = getPortalPlatform(),
  environment: NodeJS.ProcessEnv = process.env
): RunCommandShell[] {
  const shells: RunCommandShell[] = []
  if (platform === 'win32') {
    shells.push('powershell', 'cmd')
  } else if (isShellAvailable('pwsh', platform, environment)) {
    shells.push('powershell')
  }

  for (const shell of ['bash', 'zsh', 'fish', 'sh'] as const) {
    if (
      resolveConfiguredShellExecutable(
        shell,
        platform,
        environment,
        existsSync
      ) !== null
    ) {
      shells.push(shell)
    }
  }
  return shells
}

export function getShellCommand(
  shell: RunCommandShell,
  command: string,
  platform: PortalPlatform = getPortalPlatform(),
  environment: NodeJS.ProcessEnv = process.env,
  fileExists: FileExists = existsSync
): ShellCommand {
  switch (shell) {
    case 'powershell':
      return {
        file:
          platform === 'win32'
            ? 'powershell.exe'
            : resolveShellExecutable(
                'pwsh',
                platform,
                environment,
                'PowerShell is not installed or is not available on PATH.',
                fileExists
              ),
        args: [
          '-NoLogo',
          '-NoProfile',
          ...(platform === 'win32' ? ['-ExecutionPolicy', 'Bypass'] : []),
          '-Command',
          buildPowerShellUtf8Command(command),
        ],
      }
    case 'cmd':
      if (platform !== 'win32') {
        throw new Error('cmd is only available on Windows.')
      }
      return {
        file: environment.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', command],
      }
    case 'bash':
      return {
        file: requireConfiguredShellExecutable(
          'bash',
          platform,
          environment,
          'Bash is not available on PATH.',
          fileExists
        ),
        args: ['-lc', command],
      }
    case 'zsh':
      return {
        file: requireConfiguredShellExecutable(
          'zsh',
          platform,
          environment,
          'Zsh is not available on PATH.',
          fileExists
        ),
        args: ['-lc', command],
      }
    case 'fish':
      return {
        file: requireConfiguredShellExecutable(
          'fish',
          platform,
          environment,
          'Fish is not available on PATH.',
          fileExists
        ),
        args: ['-lc', command],
      }
    case 'sh':
      return {
        file: requireConfiguredShellExecutable(
          'sh',
          platform,
          environment,
          'sh is not available on PATH.',
          fileExists
        ),
        args: ['-c', command],
      }
  }
}

export function getPortalPlatform(): PortalPlatform {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return process.platform
  }
  return 'linux'
}

function getWindowsBrowserCandidates(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string
): string[] {
  const platformPath = path.win32
  const programFiles = environment.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 =
    environment['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData =
    environment.LOCALAPPDATA ??
    platformPath.join(homeDirectory, 'AppData', 'Local')
  return [
    platformPath.join(
      programFiles,
      'Microsoft',
      'Edge',
      'Application',
      'msedge.exe'
    ),
    platformPath.join(
      programFilesX86,
      'Microsoft',
      'Edge',
      'Application',
      'msedge.exe'
    ),
    platformPath.join(
      localAppData,
      'Microsoft',
      'Edge',
      'Application',
      'msedge.exe'
    ),
    platformPath.join(
      programFiles,
      'Google',
      'Chrome',
      'Application',
      'chrome.exe'
    ),
    platformPath.join(
      programFilesX86,
      'Google',
      'Chrome',
      'Application',
      'chrome.exe'
    ),
    platformPath.join(
      localAppData,
      'Google',
      'Chrome',
      'Application',
      'chrome.exe'
    ),
    platformPath.join(localAppData, 'Chromium', 'Application', 'chrome.exe'),
    ...getWindowsApplicationCandidates(
      [programFiles, programFilesX86, localAppData],
      ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe']
    ),
    ...getWindowsApplicationCandidates(
      [programFiles, programFilesX86, localAppData],
      ['Vivaldi', 'Application', 'vivaldi.exe']
    ),
    platformPath.join(localAppData, 'Programs', 'Opera', 'launcher.exe'),
    platformPath.join(localAppData, 'Programs', 'Opera GX', 'launcher.exe'),
    platformPath.join(programFiles, 'Opera', 'launcher.exe'),
    platformPath.join(programFilesX86, 'Opera', 'launcher.exe'),
    platformPath.join(programFiles, 'Opera GX', 'launcher.exe'),
    platformPath.join(programFilesX86, 'Opera GX', 'launcher.exe'),
    platformPath.join(localAppData, 'Microsoft', 'WindowsApps', 'Arc.exe'),
  ]
}

function getWindowsApplicationCandidates(
  roots: string[],
  segments: string[]
): string[] {
  return roots.map((root) => path.win32.join(root, ...segments))
}

function getMacBrowserCandidates(homeDirectory: string): string[] {
  const platformPath = path.posix
  const applications = [
    '/Applications',
    platformPath.join(homeDirectory, 'Applications'),
  ]
  return applications.flatMap((directory) => [
    platformPath.join(
      directory,
      'Microsoft Edge.app',
      'Contents',
      'MacOS',
      'Microsoft Edge'
    ),
    platformPath.join(
      directory,
      'Google Chrome.app',
      'Contents',
      'MacOS',
      'Google Chrome'
    ),
    platformPath.join(
      directory,
      'Chromium.app',
      'Contents',
      'MacOS',
      'Chromium'
    ),
    platformPath.join(
      directory,
      'Brave Browser.app',
      'Contents',
      'MacOS',
      'Brave Browser'
    ),
    platformPath.join(directory, 'Vivaldi.app', 'Contents', 'MacOS', 'Vivaldi'),
    platformPath.join(directory, 'Opera.app', 'Contents', 'MacOS', 'Opera'),
    platformPath.join(
      directory,
      'Opera GX.app',
      'Contents',
      'MacOS',
      'Opera GX'
    ),
    platformPath.join(directory, 'Arc.app', 'Contents', 'MacOS', 'Arc'),
  ])
}

function getLinuxBrowserCandidates(): string[] {
  return [
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/opt/google/chrome/google-chrome',
    '/usr/bin/brave-browser',
    '/usr/bin/brave-browser-stable',
    '/opt/brave.com/brave/brave-browser',
    '/snap/bin/brave',
    '/usr/bin/vivaldi',
    '/usr/bin/vivaldi-stable',
    '/opt/vivaldi/vivaldi',
    '/snap/bin/vivaldi',
    '/usr/bin/opera',
    '/usr/bin/opera-stable',
    '/snap/bin/opera',
  ]
}

function getBrowserPathCandidates(
  platform: PortalPlatform,
  environment: NodeJS.ProcessEnv
): string[] {
  const names =
    platform === 'win32'
      ? [
          'msedge.exe',
          'chrome.exe',
          'chromium.exe',
          'brave.exe',
          'vivaldi.exe',
          'opera.exe',
          'Arc.exe',
        ]
      : platform === 'darwin'
        ? [
            'Microsoft Edge',
            'Google Chrome',
            'Chromium',
            'Brave Browser',
            'Vivaldi',
            'Opera',
            'Opera GX',
            'Arc',
          ]
        : [
            'microsoft-edge',
            'microsoft-edge-stable',
            'google-chrome',
            'google-chrome-stable',
            'chromium',
            'chromium-browser',
            'brave-browser',
            'brave-browser-stable',
            'vivaldi',
            'vivaldi-stable',
            'opera',
            'opera-stable',
          ]
  return getPathEntries(platform, environment).flatMap((directory) =>
    names.map((name) => getPlatformPath(platform).join(directory, name))
  )
}

function isPosixShell(
  value: string
): value is Exclude<RunCommandShell, 'powershell' | 'cmd'> {
  return (
    value === 'bash' || value === 'zsh' || value === 'fish' || value === 'sh'
  )
}

function isShellAvailable(
  shell: string,
  platform: PortalPlatform,
  environment: NodeJS.ProcessEnv,
  fileExists: FileExists = existsSync
): boolean {
  if (shell === 'sh' && platform !== 'win32') {
    return true
  }
  return (
    resolvePathExecutable(shell, platform, environment, fileExists) !== null
  )
}

function resolveShellExecutable(
  shell: string,
  platform: PortalPlatform,
  environment: NodeJS.ProcessEnv,
  message: string,
  fileExists: FileExists
): string {
  const resolved = resolvePathExecutable(
    shell,
    platform,
    environment,
    fileExists
  )
  if (resolved === null) {
    throw new Error(message)
  }
  return resolved
}

function requireConfiguredShellExecutable(
  shell: Exclude<RunCommandShell, 'powershell' | 'cmd'>,
  platform: PortalPlatform,
  environment: NodeJS.ProcessEnv,
  message: string,
  fileExists: FileExists
): string {
  const resolved = resolveConfiguredShellExecutable(
    shell,
    platform,
    environment,
    fileExists
  )
  if (resolved === null) {
    throw new Error(message)
  }
  return resolved
}

function resolveConfiguredShellExecutable(
  shell: Exclude<RunCommandShell, 'powershell' | 'cmd'>,
  platform: PortalPlatform,
  environment: NodeJS.ProcessEnv,
  fileExists: FileExists
): string | null {
  const shellPath = environment.SHELL ?? ''
  const platformPath = getPlatformPath(platform)
  if (
    platform !== 'win32' &&
    platformPath.isAbsolute(shellPath) &&
    platformPath.basename(shellPath) === shell &&
    fileExists(shellPath)
  ) {
    return shellPath
  }
  return resolvePathExecutable(shell, platform, environment, fileExists)
}

function resolvePathExecutable(
  executable: string,
  platform: PortalPlatform,
  environment: NodeJS.ProcessEnv,
  fileExists: FileExists = existsSync
): string | null {
  const entries = getPathEntries(platform, environment)
  for (const directory of entries) {
    const platformPath = getPlatformPath(platform)
    const candidate = platformPath.join(directory, executable)
    if (platformPath.isAbsolute(candidate) && fileExists(candidate)) {
      return candidate
    }
  }
  if (platform !== 'win32') {
    for (const directory of ['/bin', '/usr/bin']) {
      const candidate = path.posix.join(directory, executable)
      if (fileExists(candidate)) {
        return candidate
      }
    }
  }
  return null
}

function getPlatformPath(platform: PortalPlatform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix
}

function getPathEntries(
  platform: PortalPlatform,
  environment: NodeJS.ProcessEnv
): string[] {
  return (environment.PATH ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function uniquePaths(values: string[], platform: PortalPlatform): string[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = platform === 'win32' ? value.toLowerCase() : value
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function buildPowerShellUtf8Command(command: string): string {
  const commandWithStatus = `${command}\n$global:__portalRunCommandSucceeded = $?`
  const encodedCommand = Buffer.from(commandWithStatus, 'utf16le').toString(
    'base64'
  )
  return [
    '$__portalUtf8Encoding = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding = $__portalUtf8Encoding',
    '[Console]::InputEncoding = $__portalUtf8Encoding',
    '$OutputEncoding = $__portalUtf8Encoding',
    "$PSDefaultParameterValues['*:Encoding'] = 'utf8'",
    '$global:__portalRunCommandSucceeded = $true',
    `$__portalEncodedCommand = '${encodedCommand}'`,
    '$__portalCommand = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($__portalEncodedCommand))',
    '& ([ScriptBlock]::Create($__portalCommand))',
    'if (-not $global:__portalRunCommandSucceeded) { exit 1 }',
  ].join('; ')
}
