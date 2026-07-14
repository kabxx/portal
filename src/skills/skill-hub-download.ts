import path from 'path'
import type { AbortOptions } from '../runtime/runtime-cancellation.ts'
import { fetchSkillHttp, writeSkillHttpResponse } from './skill-http.ts'
import { SkillInstallError } from './skill-files.ts'
import { validateSkillName } from './skill-manifest.ts'
import { DEFAULT_SKILL_POLICY, type SkillPolicy } from './skill-policy.ts'

const MAX_HUB_METADATA_BYTES = 1024 * 1024
const HUB_JSON_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'portal-skill-installer',
}
const HUB_DOWNLOAD_HEADERS = {
  Accept: 'application/zip, application/octet-stream',
  'User-Agent': 'portal-skill-installer',
}

export function parseSkillRegistryUrl(value: string): URL {
  let registryUrl: URL
  try {
    registryUrl = new URL(value)
  } catch {
    throw new SkillInstallError(`Invalid skill registry URL: ${value}`)
  }
  if (!['http:', 'https:'].includes(registryUrl.protocol)) {
    throw new SkillInstallError(
      `Unsupported skill registry protocol: ${registryUrl.protocol}`
    )
  }
  registryUrl.search = ''
  registryUrl.hash = ''
  return registryUrl
}

export async function downloadSkillFromHub(
  slug: string,
  registryUrl: URL,
  directory: string,
  options: AbortOptions,
  policy: SkillPolicy = DEFAULT_SKILL_POLICY
): Promise<string> {
  assertValidHubSlug(slug)
  const apiBase = await discoverApiBase(registryUrl, options, policy)
  const metadataUrl = appendUrlPath(
    apiBase,
    `skills/${encodeURIComponent(slug)}`
  )
  const metadataResponse = await fetchSkillHttp(metadataUrl, {
    signal: options.signal,
    headers: HUB_JSON_HEADERS,
    timeoutMs: policy.downloadTimeoutMs,
    maxRedirects: policy.maxRedirects,
  })
  const metadata = await readJsonResponse(
    metadataResponse,
    'Skill registry metadata request'
  )
  const version = parseLatestVersion(metadata, slug)

  const downloadUrl = appendUrlPath(apiBase, 'download')
  downloadUrl.searchParams.set('slug', slug)
  downloadUrl.searchParams.set('version', version)
  const downloadResponse = await fetchSkillHttp(downloadUrl, {
    signal: options.signal,
    headers: HUB_DOWNLOAD_HEADERS,
    timeoutMs: policy.downloadTimeoutMs,
    maxRedirects: policy.maxRedirects,
  })
  if (!downloadResponse.ok) {
    throw new SkillInstallError(
      `Skill registry download failed with HTTP ${downloadResponse.status} ${downloadResponse.statusText}`
    )
  }
  const contentType = (
    downloadResponse.headers.get('content-type') ?? ''
  ).toLowerCase()
  if (contentType.includes('text/html') || contentType.includes('json')) {
    await downloadResponse.body?.cancel().catch(() => {})
    throw new SkillInstallError(
      'Skill registry returned metadata instead of a skill archive'
    )
  }

  const destination = path.join(directory, 'skill.zip')
  await writeSkillHttpResponse(downloadResponse, destination, {
    signal: options.signal,
    maxBytes: policy.maxDownloadBytes,
  })
  return destination
}

async function discoverApiBase(
  registryUrl: URL,
  options: AbortOptions,
  policy: SkillPolicy
): Promise<URL> {
  const discoveryUrl = appendUrlPath(registryUrl, '.well-known/clawhub.json')
  const response = await fetchSkillHttp(discoveryUrl, {
    signal: options.signal,
    headers: HUB_JSON_HEADERS,
    timeoutMs: policy.downloadTimeoutMs,
    maxRedirects: policy.maxRedirects,
  })
  const document = await readJsonResponse(
    response,
    'Skill registry discovery request'
  )
  if (!isRecord(document) || typeof document.apiBase !== 'string') {
    throw new SkillInstallError(
      'Skill registry discovery response requires string apiBase'
    )
  }

  let apiBase: URL
  try {
    apiBase = new URL(document.apiBase, ensureDirectoryUrl(registryUrl))
  } catch {
    throw new SkillInstallError(
      'Skill registry discovery response contains an invalid apiBase'
    )
  }
  if (!['http:', 'https:'].includes(apiBase.protocol)) {
    throw new SkillInstallError(
      `Unsupported skill registry API protocol: ${apiBase.protocol}`
    )
  }
  apiBase.search = ''
  apiBase.hash = ''
  return apiBase
}

async function readJsonResponse(
  response: Response,
  operation: string
): Promise<unknown> {
  if (!response.ok) {
    throw new SkillInstallError(
      `${operation} failed with HTTP ${response.status} ${response.statusText}`
    )
  }
  const text = await response.text()
  if (Buffer.byteLength(text) > MAX_HUB_METADATA_BYTES) {
    throw new SkillInstallError(
      `${operation} exceeds ${MAX_HUB_METADATA_BYTES} bytes`
    )
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new SkillInstallError(`${operation} returned invalid JSON`)
  }
}

function parseLatestVersion(document: unknown, requestedSlug: string): string {
  if (!isRecord(document)) {
    throw new SkillInstallError('Skill registry metadata must be a JSON object')
  }
  const skill = document.skill
  if (!isRecord(skill) || skill.slug !== requestedSlug) {
    throw new SkillInstallError(
      `Skill registry metadata does not match requested skill: ${requestedSlug}`
    )
  }
  const latestVersion = document.latestVersion
  if (!isRecord(latestVersion) || typeof latestVersion.version !== 'string') {
    throw new SkillInstallError(
      'Skill registry metadata does not include a latest version'
    )
  }
  const version = latestVersion.version.trim()
  if (
    version === '' ||
    version.length > 128 ||
    /[\u0000-\u001F]/.test(version)
  ) {
    throw new SkillInstallError('Skill registry returned an invalid version')
  }
  return version
}

function assertValidHubSlug(slug: string): void {
  try {
    validateSkillName(slug)
  } catch (error) {
    throw new SkillInstallError(
      error instanceof Error ? error.message : String(error)
    )
  }
}

function appendUrlPath(baseUrl: URL, relativePath: string): URL {
  return new URL(relativePath, ensureDirectoryUrl(baseUrl))
}

function ensureDirectoryUrl(value: URL): URL {
  const result = new URL(value)
  if (!result.pathname.endsWith('/')) {
    result.pathname += '/'
  }
  result.search = ''
  result.hash = ''
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
