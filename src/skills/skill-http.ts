import { open, unlink } from 'fs/promises'
import type { AbortOptions } from '../runtime/runtime-cancellation.ts'
import { throwIfAborted } from '../runtime/runtime-cancellation.ts'
import { sleepWithAbortAsync } from '../shared/sleep.ts'
import { SkillInstallError } from './skill-files.ts'

export const MAX_SKILL_DOWNLOAD_BYTES = 100 * 1024 * 1024

const MAX_REDIRECTS = 5
const DOWNLOAD_TIMEOUT_MS = 60000
const DEFAULT_RETRY_DELAYS_MS = [250, 1000] as const
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504])

interface SkillHttpOptions extends AbortOptions {
  headers?: Record<string, string>
  retryDelays?: readonly number[]
}

interface WriteResponseOptions extends AbortOptions {
  maxBytes: number
  limitMessage?: string
}

export async function fetchSkillHttp(
  sourceUrl: URL,
  options: SkillHttpOptions = {}
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  const signal =
    options.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([options.signal, timeoutSignal])
  const retryDelays = options.retryDelays ?? DEFAULT_RETRY_DELAYS_MS
  let currentUrl = sourceUrl

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    assertRequestActive(currentUrl, timeoutSignal, options.signal)
    const response = await fetchWithRetries(
      currentUrl,
      signal,
      timeoutSignal,
      options.signal,
      options.headers ?? {},
      retryDelays
    )
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response
    }

    const location = response.headers.get('location')
    if (location === null) return response
    if (redirect === MAX_REDIRECTS) {
      throw new SkillInstallError(
        `Skill download exceeded ${MAX_REDIRECTS} redirects`
      )
    }
    await response.body?.cancel().catch(() => {})
    currentUrl = new URL(location, currentUrl)
    if (!['http:', 'https:'].includes(currentUrl.protocol)) {
      throw new SkillInstallError(
        `Skill download redirected to unsupported protocol: ${currentUrl.protocol}`
      )
    }
  }
  throw new SkillInstallError('Skill download redirect handling failed')
}

export async function writeSkillHttpResponse(
  response: Response,
  destination: string,
  options: WriteResponseOptions
): Promise<number> {
  if (response.body === null) {
    throw new SkillInstallError(
      'Skill download returned an empty response body'
    )
  }
  const contentLength = parseContentLength(response)
  const limitMessage =
    options.limitMessage ?? `Skill download exceeds ${options.maxBytes} bytes`
  if (contentLength !== null && contentLength > options.maxBytes) {
    throw new SkillInstallError(limitMessage)
  }

  const file = await open(destination, 'wx')
  const reader = response.body.getReader()
  let downloadedBytes = 0
  let completed = false
  try {
    while (true) {
      throwIfAborted(options.signal)
      const { done, value } = await reader.read()
      if (done) break
      downloadedBytes += value.byteLength
      if (downloadedBytes > options.maxBytes) {
        throw new SkillInstallError(limitMessage)
      }
      await file.write(value)
    }
    completed = true
  } catch (error) {
    throwIfAborted(options.signal)
    if (error instanceof SkillInstallError) throw error
    throw new SkillInstallError(
      `Skill download failed while reading the response: ${describeError(error)}`
    )
  } finally {
    await file.close()
    await reader.cancel().catch(() => {})
    if (!completed) {
      await unlink(destination).catch(() => {})
    }
  }
  return downloadedBytes
}

async function fetchWithRetries(
  sourceUrl: URL,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
  userSignal: AbortSignal | undefined,
  headers: Record<string, string>,
  retryDelays: readonly number[]
): Promise<Response> {
  const attempts = retryDelays.length + 1
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    assertRequestActive(sourceUrl, timeoutSignal, userSignal)
    try {
      const response = await fetch(sourceUrl, {
        redirect: 'manual',
        signal,
        headers,
      })
      if (
        attempt < attempts - 1 &&
        RETRYABLE_HTTP_STATUSES.has(response.status)
      ) {
        await response.body?.cancel().catch(() => {})
        await waitBeforeRetry(
          retryDelays[attempt]!,
          sourceUrl,
          signal,
          timeoutSignal,
          userSignal
        )
        continue
      }
      return response
    } catch (error) {
      throwIfAborted(userSignal)
      if (timeoutSignal.aborted) throw requestTimeoutError(sourceUrl)
      lastError = error
      if (attempt >= attempts - 1) break
      await waitBeforeRetry(
        retryDelays[attempt]!,
        sourceUrl,
        signal,
        timeoutSignal,
        userSignal
      )
    }
  }

  throw new SkillInstallError(
    `Network request failed after ${attempts} attempts: ${formatSafeUrl(sourceUrl)} (${describeError(lastError)})`
  )
}

async function waitBeforeRetry(
  delayMs: number,
  sourceUrl: URL,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
  userSignal?: AbortSignal
): Promise<void> {
  try {
    await sleepWithAbortAsync(delayMs, signal)
  } catch {
    throwIfAborted(userSignal)
    if (timeoutSignal.aborted) throw requestTimeoutError(sourceUrl)
    throw new SkillInstallError(
      `Network request interrupted before retry: ${formatSafeUrl(sourceUrl)}`
    )
  }
}

function assertRequestActive(
  sourceUrl: URL,
  timeoutSignal: AbortSignal,
  userSignal?: AbortSignal
): void {
  throwIfAborted(userSignal)
  if (timeoutSignal.aborted) throw requestTimeoutError(sourceUrl)
}

function requestTimeoutError(sourceUrl: URL): SkillInstallError {
  return new SkillInstallError(
    `Network request timed out after ${DOWNLOAD_TIMEOUT_MS} ms: ${formatSafeUrl(sourceUrl)}`
  )
}

function parseContentLength(response: Response): number | null {
  const value = response.headers.get('content-length')
  if (value === null || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function formatSafeUrl(sourceUrl: URL): string {
  const safeUrl = new URL(sourceUrl)
  safeUrl.username = ''
  safeUrl.password = ''
  safeUrl.search = ''
  safeUrl.hash = ''
  return safeUrl.href
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as Error & { cause?: unknown }).cause
  return cause instanceof Error
    ? `${error.message}: ${cause.message}`
    : error.message
}
