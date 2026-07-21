import koffi from 'koffi'
import type { LibraryHandle } from 'koffi'

const TOKEN_QUERY = 0x0008
const MAX_ENVIRONMENT_BLOCK_CODE_UNITS = 1024 * 1024
const isWin32 = process.platform === 'win32'

type Win32Pointer = number | bigint

interface Win32EnvironmentApi {
  libraries: readonly LibraryHandle[]
  getCurrentProcess(): Win32Pointer
  openProcessToken(
    processHandle: Win32Pointer,
    access: number,
    token: [Win32Pointer | null]
  ): boolean
  closeHandle(handle: Win32Pointer): boolean
  createEnvironmentBlock(
    environment: [Win32Pointer | null],
    token: Win32Pointer,
    inherit: boolean
  ): boolean
  destroyEnvironmentBlock(environment: Win32Pointer): boolean
}

let win32EnvironmentApi: Win32EnvironmentApi | null = null

export function getRunCommandEnvironment(
  platform: NodeJS.Platform = process.platform,
  fallback: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  if (platform !== 'win32') {
    return fallback
  }

  try {
    return readCurrentWindowsEnvironment()
  } catch {
    return fallback
  }
}

function readCurrentWindowsEnvironment(): NodeJS.ProcessEnv {
  const api = getWin32EnvironmentApi()

  const token: [Win32Pointer | null] = [null]
  if (!api.openProcessToken(api.getCurrentProcess(), TOKEN_QUERY, token)) {
    throw new Error('Failed to open the current Windows process token.')
  }
  const tokenHandle = token[0]
  if (tokenHandle === null) {
    throw new Error('Windows process token returned an empty handle.')
  }

  const environmentBlock: [Win32Pointer | null] = [null]
  try {
    if (!api.createEnvironmentBlock(environmentBlock, tokenHandle, true)) {
      throw new Error('Failed to create the current Windows environment.')
    }
    const block = environmentBlock[0]
    if (block === null) {
      throw new Error('Windows environment returned an empty block.')
    }
    return decodeEnvironmentBlock(block)
  } finally {
    try {
      if (environmentBlock[0] !== null) {
        api.destroyEnvironmentBlock(environmentBlock[0])
      }
    } finally {
      api.closeHandle(tokenHandle)
    }
  }
}

function getWin32EnvironmentApi(): Win32EnvironmentApi {
  if (!isWin32) {
    throw new Error('Windows environment refresh is only available on Windows.')
  }
  if (win32EnvironmentApi !== null) {
    return win32EnvironmentApi
  }

  const kernel32 = koffi.load('kernel32.dll')
  const advapi32 = koffi.load('advapi32.dll')
  const userenv = koffi.load('userenv.dll')

  const getCurrentProcess = kernel32.func(
    'GetCurrentProcess',
    'size_t',
    []
  ) as () => number | bigint
  const openProcessToken = advapi32.func('OpenProcessToken', 'bool', [
    'size_t',
    'uint',
    koffi.out(koffi.pointer('size_t')),
  ]) as Win32EnvironmentApi['openProcessToken']
  const closeHandle = kernel32.func('CloseHandle', 'bool', [
    'size_t',
  ]) as Win32EnvironmentApi['closeHandle']

  const environmentBlock = koffi.opaque()
  const createEnvironmentBlock = userenv.func(
    'CreateEnvironmentBlock',
    'bool',
    [koffi.out(koffi.pointer(environmentBlock, 2)), 'size_t', 'bool']
  ) as Win32EnvironmentApi['createEnvironmentBlock']
  const destroyEnvironmentBlock = userenv.func(
    'DestroyEnvironmentBlock',
    'bool',
    [koffi.pointer(environmentBlock)]
  ) as Win32EnvironmentApi['destroyEnvironmentBlock']

  win32EnvironmentApi = {
    libraries: [kernel32, advapi32, userenv],
    getCurrentProcess,
    openProcessToken,
    closeHandle,
    createEnvironmentBlock,
    destroyEnvironmentBlock,
  }
  return win32EnvironmentApi
}

function decodeEnvironmentBlock(block: Win32Pointer): NodeJS.ProcessEnv {
  const variables = new Map<string, { name: string; value: string }>()
  let entry = ''

  for (let index = 0; index < MAX_ENVIRONMENT_BLOCK_CODE_UNITS; index += 1) {
    const codeUnit: unknown = koffi.decode(block, index * 2, 'uint16')
    if (typeof codeUnit !== 'number') {
      throw new Error('Windows environment block contains an invalid value.')
    }
    if (codeUnit !== 0) {
      entry += String.fromCharCode(codeUnit)
      continue
    }
    if (entry.length === 0) {
      return Object.fromEntries(
        [...variables.values()].map(({ name, value }) => [name, value])
      )
    }

    const separator = entry.indexOf('=')
    if (separator > 0 && !entry.startsWith('=')) {
      const name = entry.slice(0, separator)
      variables.set(name.toLowerCase(), {
        name,
        value: entry.slice(separator + 1),
      })
    }
    entry = ''
  }

  throw new Error('Windows environment block is not terminated.')
}
