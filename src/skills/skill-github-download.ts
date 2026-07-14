import { mkdir } from 'fs/promises'
import path from 'path'
import type { AbortOptions } from '../runtime/runtime-cancellation.ts'
import { throwIfAborted } from '../runtime/runtime-cancellation.ts'
import { fetchSkillHttp, writeSkillHttpResponse } from './skill-http.ts'
import { assertSafeRelativePath, SkillInstallError } from './skill-files.ts'
import { DEFAULT_SKILL_POLICY, type SkillPolicy } from './skill-policy.ts'

const MAX_GITHUB_API_RESPONSE_BYTES = 10 * 1024 * 1024
const GITHUB_RETRY_DELAYS_MS = [250, 1000, 3000, 5000] as const
const GITHUB_API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'portal-skill-installer',
  'X-GitHub-Api-Version': '2022-11-28',
}
const GITHUB_RAW_API_HEADERS = {
  ...GITHUB_API_HEADERS,
  Accept: 'application/vnd.github.raw',
}

export interface ParsedGitHubUrl {
  owner: string
  repository: string
  kind: string | undefined
  reference: string | undefined
  relativeParts: string[]
}

export interface GitHubDirectoryTarget {
  owner: string
  repository: string
  reference: string
  directory: string
}

interface GitHubContentEntry {
  name: string
  type: 'file' | 'dir'
  size: number
  downloadUrl: string | null
  apiUrl: string
}

export function parseGitHubUrl(sourceUrl: URL): ParsedGitHubUrl | null {
  if (
    !['github.com', 'www.github.com'].includes(sourceUrl.hostname.toLowerCase())
  ) {
    return null
  }

  let parts: string[]
  try {
    parts = sourceUrl.pathname
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part))
  } catch {
    throw new SkillInstallError('Invalid encoded GitHub URL')
  }
  const owner = parts[0]
  const rawRepository = parts[1]
  if (owner === undefined || rawRepository === undefined) return null

  const repository = rawRepository.replace(/\.git$/i, '')
  if (
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(repository)
  ) {
    throw new SkillInstallError('Invalid GitHub repository URL')
  }
  return {
    owner,
    repository,
    kind: parts[2],
    reference: parts[3],
    relativeParts: parts.slice(4),
  }
}

export function resolveGitHubDirectoryTarget(
  sourceUrl: URL
): GitHubDirectoryTarget | null {
  const github = parseGitHubUrl(sourceUrl)
  if (
    github === null ||
    github.kind !== 'tree' ||
    github.reference === undefined ||
    github.relativeParts.length === 0
  ) {
    return null
  }
  return {
    owner: github.owner,
    repository: github.repository,
    reference: github.reference,
    directory: github.relativeParts.join('/'),
  }
}

export async function downloadGitHubDirectory(
  target: GitHubDirectoryTarget,
  destination: string,
  options: AbortOptions,
  policy: SkillPolicy = DEFAULT_SKILL_POLICY
): Promise<void> {
  assertSafeRelativePath(target.directory)
  let entriesSeen = 0
  let declaredBytes = 0
  let downloadedBytes = 0
  let preferApiDownloads = false

  const visit = async (
    remoteDirectory: string,
    localDirectory: string
  ): Promise<void> => {
    throwIfAborted(options.signal)
    await mkdir(localDirectory, { recursive: true })
    const entries = await listGitHubDirectory(
      target,
      remoteDirectory,
      options.signal,
      policy
    )

    for (const entry of entries) {
      throwIfAborted(options.signal)
      entriesSeen += 1
      if (entriesSeen > policy.maxFiles) {
        throw new SkillInstallError(
          `GitHub skill contains more than ${policy.maxFiles} entries`
        )
      }
      assertSafeGitHubEntryName(entry.name)
      const localPath = path.join(localDirectory, entry.name)
      if (entry.type === 'dir') {
        await visit(path.posix.join(remoteDirectory, entry.name), localPath)
        continue
      }

      declaredBytes += entry.size
      if (declaredBytes > policy.maxDownloadBytes) {
        throw downloadLimitError(policy)
      }
      const remainingBytes = policy.maxDownloadBytes - downloadedBytes
      const rawUrl = validateGitHubFileUrl(
        entry.downloadUrl,
        'raw.githubusercontent.com'
      )
      const apiUrl = validateGitHubFileUrl(entry.apiUrl, 'api.github.com')

      if (preferApiDownloads) {
        try {
          downloadedBytes += await downloadGitHubFile(
            apiUrl,
            localPath,
            remainingBytes,
            options.signal,
            GITHUB_RAW_API_HEADERS,
            policy,
            GITHUB_RETRY_DELAYS_MS
          )
          continue
        } catch (error) {
          throwIfAborted(options.signal)
          if (!(error instanceof SkillInstallError)) throw error
          preferApiDownloads = false
        }
      }

      try {
        downloadedBytes += await downloadGitHubFile(
          rawUrl,
          localPath,
          remainingBytes,
          options.signal,
          {},
          policy,
          []
        )
      } catch (error) {
        throwIfAborted(options.signal)
        if (!(error instanceof SkillInstallError)) throw error
        preferApiDownloads = true
        downloadedBytes += await downloadGitHubFile(
          apiUrl,
          localPath,
          remainingBytes,
          options.signal,
          GITHUB_RAW_API_HEADERS,
          policy,
          GITHUB_RETRY_DELAYS_MS
        )
      }
    }
  }

  await visit(target.directory, destination)
}

async function listGitHubDirectory(
  target: GitHubDirectoryTarget,
  directory: string,
  signal: AbortSignal | undefined,
  policy: SkillPolicy
): Promise<GitHubContentEntry[]> {
  const encodedDirectory = directory
    .split('/')
    .map(encodeURIComponent)
    .join('/')
  const apiUrl = new URL(
    `https://api.github.com/repos/${target.owner}/${target.repository}/contents/${encodedDirectory}`
  )
  apiUrl.searchParams.set('ref', target.reference)
  const response = await fetchSkillHttp(apiUrl, {
    signal,
    headers: GITHUB_API_HEADERS,
    retryDelays: GITHUB_RETRY_DELAYS_MS,
    timeoutMs: policy.downloadTimeoutMs,
    maxRedirects: policy.maxRedirects,
  })
  assertGitHubResponse(response, 'skill directory request')

  const text = await response.text()
  if (Buffer.byteLength(text) > MAX_GITHUB_API_RESPONSE_BYTES) {
    throw new SkillInstallError('GitHub skill directory listing is too large')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new SkillInstallError('GitHub skill directory returned invalid JSON')
  }
  if (!Array.isArray(value)) {
    throw new SkillInstallError('GitHub tree URL does not point to a directory')
  }
  if (value.length >= 1000) {
    throw new SkillInstallError(
      'GitHub skill directory has too many entries for the Contents API'
    )
  }
  return value.map(parseGitHubContentEntry)
}

async function downloadGitHubFile(
  sourceUrl: URL,
  destination: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
  headers: Record<string, string>,
  policy: SkillPolicy,
  retryDelays?: readonly number[]
): Promise<number> {
  const response = await fetchSkillHttp(sourceUrl, {
    signal,
    headers,
    ...(retryDelays === undefined ? {} : { retryDelays }),
    timeoutMs: policy.downloadTimeoutMs,
    maxRedirects: policy.maxRedirects,
  })
  assertGitHubResponse(response, 'skill file download')
  return await writeSkillHttpResponse(response, destination, {
    signal,
    maxBytes,
    limitMessage: downloadLimitError(policy).message,
  })
}

function assertGitHubResponse(response: Response, operation: string): void {
  if (response.ok) return
  if (
    response.status === 403 &&
    response.headers.get('x-ratelimit-remaining') === '0'
  ) {
    throw new SkillInstallError(
      `GitHub API rate limit exceeded during ${operation}`
    )
  }
  throw new SkillInstallError(
    `GitHub ${operation} failed with HTTP ${response.status} ${response.statusText}`
  )
}

function parseGitHubContentEntry(value: unknown): GitHubContentEntry {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    (value.type !== 'file' && value.type !== 'dir') ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    !(typeof value.download_url === 'string' || value.download_url === null) ||
    typeof value.url !== 'string'
  ) {
    throw new SkillInstallError(
      'GitHub skill directory contains an unsupported entry'
    )
  }
  return {
    name: value.name,
    type: value.type,
    size: value.size,
    downloadUrl: value.download_url,
    apiUrl: value.url,
  }
}

function assertSafeGitHubEntryName(name: string): void {
  assertSafeRelativePath(name)
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    /[<>:"/\\|?*\u0000-\u001F]/.test(name) ||
    /[. ]$/.test(name)
  ) {
    throw new SkillInstallError(`Unsupported GitHub skill entry name: ${name}`)
  }
}

function validateGitHubFileUrl(
  value: string | null,
  expectedHost: string
): URL {
  if (value === null) {
    throw new SkillInstallError('GitHub did not provide a skill file URL')
  }
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== expectedHost
  ) {
    throw new SkillInstallError('GitHub returned an unsupported skill file URL')
  }
  return url
}

function downloadLimitError(policy: SkillPolicy): SkillInstallError {
  return new SkillInstallError(
    `GitHub skill exceeds ${policy.maxDownloadBytes} downloaded bytes`
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
