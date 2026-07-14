import { spawn } from 'child_process'
import { mkdir } from 'fs/promises'
import path from 'path'
import { path7za } from '7zip-bin'
import { createExtractorFromFile } from 'node-unrar-js'
import {
  PortalAbortError,
  throwIfAborted,
} from '../runtime/runtime-cancellation.ts'
import {
  assertSafeRelativePath,
  collectRegularFiles,
  containsSkillManifest,
  inspectSkillTree,
  readFilePrefix,
  SkillInstallError,
} from './skill-files.ts'
import { DEFAULT_SKILL_POLICY, type SkillPolicy } from './skill-policy.ts'

const MAX_7ZIP_OUTPUT_BYTES = 16 * 1024 * 1024
const RAR4_SIGNATURE = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])
const RAR5_SIGNATURE = Buffer.from([
  0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00,
])

export async function isSupportedArchive(filePath: string): Promise<boolean> {
  const lowerName = filePath.toLowerCase()
  if (
    ['.zip', '.7z', '.rar', '.tar', '.tgz', '.tar.gz'].some((extension) =>
      lowerName.endsWith(extension)
    )
  ) {
    return true
  }

  const prefix = await readFilePrefix(filePath, 512)
  return (
    prefix.subarray(0, 2).equals(Buffer.from([0x50, 0x4b])) ||
    prefix.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])) ||
    prefix
      .subarray(0, 6)
      .equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) ||
    isRarPrefix(prefix) ||
    prefix.subarray(257, 262).toString('ascii') === 'ustar'
  )
}

export async function extractSkillArchive(
  archivePath: string,
  destination: string,
  signal: AbortSignal | undefined,
  policy: SkillPolicy = DEFAULT_SKILL_POLICY,
  depth = 0
): Promise<string> {
  await mkdir(destination, { recursive: true })
  if (await isRarArchive(archivePath)) {
    await extractRarArchive(archivePath, destination, signal, policy)
  } else {
    await validateSevenZipArchive(archivePath, signal, policy)
    await runSevenZip(
      ['x', '-y', '-bd', '-bb0', `-o${destination}`, archivePath],
      signal
    )
  }
  await inspectSkillTree(destination, signal, policy)

  if (depth >= 2 || (await containsSkillManifest(destination))) {
    return destination
  }

  const files = await collectRegularFiles(destination)
  if (files.length === 1 && (await isSupportedArchive(files[0]!))) {
    return await extractSkillArchive(
      files[0]!,
      path.join(destination, 'expanded'),
      signal,
      policy,
      depth + 1
    )
  }
  return destination
}

async function isRarArchive(filePath: string): Promise<boolean> {
  if (filePath.toLowerCase().endsWith('.rar')) return true
  return isRarPrefix(await readFilePrefix(filePath, 8))
}

function isRarPrefix(prefix: Buffer): boolean {
  return (
    prefix.subarray(0, RAR4_SIGNATURE.length).equals(RAR4_SIGNATURE) ||
    prefix.subarray(0, RAR5_SIGNATURE.length).equals(RAR5_SIGNATURE)
  )
}

async function extractRarArchive(
  archivePath: string,
  destination: string,
  signal: AbortSignal | undefined,
  policy: SkillPolicy
): Promise<void> {
  throwIfAborted(signal)
  const extractor = await createExtractorFromFile({
    filepath: archivePath,
    targetPath: destination,
  })
  const headers = [...extractor.getFileList().fileHeaders]
  let fileCount = 0
  let totalSize = 0
  for (const header of headers) {
    assertSafeRelativePath(header.name)
    if (header.flags.encrypted) {
      throw new SkillInstallError(
        `Password-protected RAR entries are not supported: ${header.name}`
      )
    }
    if (!header.flags.directory) {
      fileCount += 1
      totalSize += Math.max(0, header.unpSize)
    }
  }
  enforceArchiveLimits(fileCount, totalSize, policy)

  throwIfAborted(signal)
  for (const extractedFile of extractor.extract().files) {
    void extractedFile
  }
  throwIfAborted(signal)
}

async function validateSevenZipArchive(
  archivePath: string,
  signal: AbortSignal | undefined,
  policy: SkillPolicy
): Promise<void> {
  const output = await runSevenZip(['l', '-slt', '-ba', archivePath], signal)
  const blocks = output
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
  let fileCount = 0
  let totalSize = 0

  for (const block of blocks) {
    const fields = new Map<string, string>()
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf(' = ')
      if (separator > 0) {
        fields.set(line.slice(0, separator), line.slice(separator + 3))
      }
    }
    const entryPath = fields.get('Path')
    if (entryPath === undefined) continue
    assertSafeRelativePath(entryPath)
    if (fields.get('Folder') !== '+') {
      fileCount += 1
      const size = Number(fields.get('Size') ?? '0')
      if (Number.isFinite(size) && size > 0) totalSize += size
    }
  }

  enforceArchiveLimits(fileCount, totalSize, policy)
}

function enforceArchiveLimits(
  fileCount: number,
  totalSize: number,
  policy: SkillPolicy
): void {
  if (fileCount > policy.maxFiles) {
    throw new SkillInstallError(
      `Archive contains more than ${policy.maxFiles} files`
    )
  }
  if (totalSize > policy.maxExtractedBytes) {
    throw new SkillInstallError(
      `Archive expands beyond ${policy.maxExtractedBytes} bytes`
    )
  }
}

async function runSevenZip(
  args: readonly string[],
  signal: AbortSignal | undefined
): Promise<string> {
  throwIfAborted(signal)
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(path7za, [...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let settled = false
    let aborted = false

    const append = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_7ZIP_OUTPUT_BYTES) {
        child.kill()
        if (!settled) {
          settled = true
          reject(new SkillInstallError('Archive tool output exceeded limit'))
        }
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk))

    const onAbort = () => {
      aborted = true
      child.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (settled) return
      settled = true
      if (aborted) {
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new PortalAbortError('Archive operation cancelled')
        )
        return
      }
      if (code !== 0) {
        reject(
          new SkillInstallError(
            `Archive operation failed (${String(code)}): ${Buffer.concat(stderr).toString('utf8').trim()}`
          )
        )
        return
      }
      resolve(Buffer.concat(stdout).toString('utf8'))
    })
  })
}
