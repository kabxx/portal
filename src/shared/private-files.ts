import fs from 'node:fs'
import { chmod, mkdir } from 'node:fs/promises'

export const PRIVATE_DIRECTORY_MODE = 0o700
export const PRIVATE_FILE_MODE = 0o600

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  if (process.platform !== 'win32') {
    await chmod(directory, PRIVATE_DIRECTORY_MODE)
  }
}

export function ensurePrivateDirectorySync(directory: string): void {
  fs.mkdirSync(directory, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  })
  if (process.platform !== 'win32') {
    fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE)
  }
}

export async function ensurePrivateFile(file: string): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(file, PRIVATE_FILE_MODE)
  }
}

export function ensurePrivateFileSync(file: string): void {
  if (process.platform !== 'win32') {
    fs.chmodSync(file, PRIVATE_FILE_MODE)
  }
}
