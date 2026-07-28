import fs from 'node:fs'
import { chmod, mkdir, stat } from 'node:fs/promises'

export const PRIVATE_DIRECTORY_MODE = 0o700
export const PRIVATE_FILE_MODE = 0o600
const OWNER_PERMISSION_MASK = 0o700

function ownerOnlyMode(mode: number): number {
  return mode & OWNER_PERMISSION_MASK
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  const created = await mkdir(directory, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  })
  if (process.platform !== 'win32') {
    const mode =
      created === undefined
        ? ownerOnlyMode((await stat(directory)).mode)
        : PRIVATE_DIRECTORY_MODE
    await chmod(directory, mode)
  }
}

export function ensurePrivateDirectorySync(directory: string): void {
  const created = fs.mkdirSync(directory, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  })
  if (process.platform !== 'win32') {
    const mode =
      created === undefined
        ? ownerOnlyMode(fs.statSync(directory).mode)
        : PRIVATE_DIRECTORY_MODE
    fs.chmodSync(directory, mode)
  }
}

export async function ensurePrivateFile(file: string): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(file, ownerOnlyMode((await stat(file)).mode))
  }
}

export function ensurePrivateFileSync(file: string): void {
  if (process.platform !== 'win32') {
    fs.chmodSync(file, ownerOnlyMode(fs.statSync(file).mode))
  }
}
