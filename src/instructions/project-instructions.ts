import { lstat, open } from 'node:fs/promises'
import path from 'node:path'

const PROJECT_INSTRUCTION_MAX_BYTES = 32 * 1024
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export interface ProjectInstructionsLoadOptions {
  cwd: string
  enabled: boolean
  maxBytes?: number
}

export class ProjectInstructions {
  public constructor(public readonly prompt: string | null) {}
}

export async function loadProjectInstructions({
  cwd,
  enabled,
  maxBytes = PROJECT_INSTRUCTION_MAX_BYTES,
}: ProjectInstructionsLoadOptions): Promise<ProjectInstructions> {
  if (!enabled) {
    return new ProjectInstructions(null)
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Project instruction size limit must be a positive integer')
  }

  const instructionPath = path.join(path.resolve(cwd), 'AGENTS.md')
  let metadata
  try {
    metadata = await lstat(instructionPath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return new ProjectInstructions(null)
    }
    throw new Error(`Unable to inspect AGENTS.md: ${getErrorMessage(error)}`, {
      cause: error,
    })
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('AGENTS.md must be a regular, non-symbolic-link file')
  }
  if (metadata.size > maxBytes) {
    throw new Error(`AGENTS.md exceeds the ${maxBytes}-byte limit`)
  }

  let file
  try {
    file = await open(instructionPath, 'r')
  } catch (error) {
    throw new Error(`Unable to read AGENTS.md: ${getErrorMessage(error)}`, {
      cause: error,
    })
  }

  let bytes: Buffer
  try {
    const openedMetadata = await file.stat()
    if (
      !openedMetadata.isFile() ||
      openedMetadata.dev !== metadata.dev ||
      openedMetadata.ino !== metadata.ino
    ) {
      throw new Error('AGENTS.md changed while it was being opened')
    }
    if (openedMetadata.size > maxBytes) {
      throw new Error(`AGENTS.md exceeds the ${maxBytes}-byte limit`)
    }
    bytes = await file.readFile()
  } finally {
    await file.close()
  }
  if (bytes.byteLength > maxBytes) {
    throw new Error(`AGENTS.md exceeds the ${maxBytes}-byte limit`)
  }

  let content: string
  try {
    content = UTF8_DECODER.decode(bytes).replace(/^\uFEFF/, '')
  } catch (error) {
    throw new Error('AGENTS.md must be valid UTF-8', { cause: error })
  }
  return new ProjectInstructions(content.trim() === '' ? null : content)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export { PROJECT_INSTRUCTION_MAX_BYTES }
