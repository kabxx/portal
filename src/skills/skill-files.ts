import { lstat, open, readdir, stat } from 'fs/promises'
import path from 'path'
import { throwIfAborted } from '../runtime/runtime-cancellation.ts'
import { readSkillManifest } from './skill-manifest.ts'

export const MAX_SKILL_FILES = 5000
export const MAX_SKILL_BYTES = 500 * 1024 * 1024

export class SkillInstallError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'SkillInstallError'
  }
}

export async function inspectSkillTree(
  root: string,
  signal?: AbortSignal
): Promise<void> {
  let files = 0
  let totalBytes = 0
  const visit = async (current: string): Promise<void> => {
    throwIfAborted(signal)
    for (const entry of await readdir(current, { withFileTypes: true })) {
      throwIfAborted(signal)
      const entryPath = path.join(current, entry.name)
      const entryStat = await lstat(entryPath)
      if (entryStat.isSymbolicLink()) {
        throw new SkillInstallError(
          `Symbolic links are not allowed: ${entryPath}`
        )
      }
      if (entryStat.isDirectory()) {
        await visit(entryPath)
      } else if (entryStat.isFile()) {
        files += 1
        totalBytes += entryStat.size
        if (files > MAX_SKILL_FILES) {
          throw new SkillInstallError(
            `Skill contains more than ${MAX_SKILL_FILES} files`
          )
        }
        if (totalBytes > MAX_SKILL_BYTES) {
          throw new SkillInstallError(
            `Skill exceeds ${MAX_SKILL_BYTES} extracted bytes`
          )
        }
      }
    }
  }
  await visit(root)
}

export async function findSkillCandidate(
  extractedDirectory: string,
  requestedSubdirectory: string | null
): Promise<string> {
  if (requestedSubdirectory !== null) {
    assertSafeRelativePath(requestedSubdirectory)
    const archiveRoot = await unwrapSingleDirectory(extractedDirectory)
    const candidate = path.resolve(archiveRoot, requestedSubdirectory)
    assertPathInside(archiveRoot, candidate)
    if (!(await isDirectory(candidate))) {
      throw new SkillInstallError(
        `GitHub skill directory not found: ${requestedSubdirectory}`
      )
    }
    await readSkillManifest(candidate)
    return candidate
  }

  if (await pathExists(path.join(extractedDirectory, 'SKILL.md'))) {
    return extractedDirectory
  }
  const unwrapped = await unwrapSingleDirectory(extractedDirectory)
  if (await pathExists(path.join(unwrapped, 'SKILL.md'))) {
    return unwrapped
  }

  const manifests = await findFilesNamed(extractedDirectory, 'SKILL.md')
  if (manifests.length === 0) {
    throw new SkillInstallError('Downloaded archive does not contain SKILL.md')
  }
  if (manifests.length > 1) {
    throw new SkillInstallError(
      `Downloaded archive contains multiple skills: ${manifests
        .map((manifest) =>
          path.relative(extractedDirectory, path.dirname(manifest))
        )
        .join(', ')}`
    )
  }
  return path.dirname(manifests[0]!)
}

export async function containsSkillManifest(
  directory: string
): Promise<boolean> {
  return (await findFilesNamed(directory, 'SKILL.md', 1)).length > 0
}

export async function collectRegularFiles(
  directory: string
): Promise<string[]> {
  const files: string[] = []
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await visit(entryPath)
      } else if (entry.isFile()) {
        files.push(entryPath)
      }
    }
  }
  await visit(directory)
  return files
}

export function assertSafeRelativePath(value: string): void {
  const normalized = value.replace(/\\/g, '/')
  const segments = normalized.split('/')
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    segments.includes('..')
  ) {
    throw new SkillInstallError(`Unsafe archive path: ${value}`)
  }
}

export async function readFilePrefix(
  filePath: string,
  length: number
): Promise<Buffer> {
  const file = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await file.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch {
    return false
  }
}

async function findFilesNamed(
  directory: string,
  fileName: string,
  limit = Number.POSITIVE_INFINITY
): Promise<string[]> {
  const matches: string[] = []
  const visit = async (current: string): Promise<void> => {
    if (matches.length >= limit) return
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (matches.length >= limit) return
      const entryPath = path.join(current, entry.name)
      if (entry.isSymbolicLink()) {
        throw new SkillInstallError(
          `Symbolic links are not allowed: ${entryPath}`
        )
      }
      if (entry.isDirectory()) {
        await visit(entryPath)
      } else if (entry.isFile() && entry.name === fileName) {
        matches.push(entryPath)
      }
    }
  }
  await visit(directory)
  return matches
}

async function unwrapSingleDirectory(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true })
  const visibleEntries = entries.filter((entry) => !entry.name.startsWith('.'))
  if (visibleEntries.length === 1 && visibleEntries[0]!.isDirectory()) {
    return path.join(directory, visibleEntries[0]!.name)
  }
  return directory
}

function assertPathInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SkillInstallError(`Path escapes skill source: ${target}`)
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}
