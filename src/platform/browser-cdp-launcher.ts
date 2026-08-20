import fs from 'fs'
import net from 'node:net'
import type { ChildProcess } from 'child_process'
import { chromium } from 'playwright'
import type { BrowserContext, BrowserType } from 'playwright'
import {
  getAbortError,
  throwIfAborted,
} from '../runtime/runtime-cancellation.ts'
import { ensurePrivateDirectorySync } from '../shared/private-files.ts'
import type { BrowserProcess } from './browser-process.ts'
import { BrowserProcessTreeCleanupError } from './browser-process.ts'
import { launchPosixBrowser } from './posix-browser-launcher.ts'
import { launchWin32Browser } from './win32-browser-launcher.ts'
import type { BrowserEngine } from './platform-defaults.ts'

export interface BrowserLaunch {
  context: BrowserContext
  disconnected: Promise<void>
  remoteDebuggingPort?: number
  close(): Promise<void>
}

export interface BrowserConnectionEvents {
  once(event: 'disconnected', listener: () => void): unknown
  off(event: 'disconnected', listener: () => void): unknown
  isConnected(): boolean
}

export interface BrowserConnection {
  close(): Promise<void>
}

export interface BrowserRuntimeConnection
  extends BrowserConnection, BrowserConnectionEvents {
  contexts(): BrowserContext[]
}

export interface BrowserConnector<
  TBrowser extends BrowserConnection = BrowserRuntimeConnection,
> {
  connectOverCDP(
    endpoint: string,
    options: { timeout: number }
  ): Promise<TBrowser>
}

export interface BrowserProcessFailureMonitor {
  failure: Promise<never>
  close(): void
}

const BROWSER_CLOSE_TIMEOUT_MS = 3000
const BROWSER_STARTUP_TIMEOUT_MS = 60_000
const MAX_DYNAMIC_CDP_BIND_ATTEMPTS = 3
const MAX_BROWSER_STARTUP_LOG_BYTES = 64 * 1024
const PROFILE_SINGLETON_ERROR =
  /ProcessSingleton.*profile directory|profile directory.*ProcessSingleton/i
const CDP_BIND_ERROR =
  /(?:address|bind|listen).*(?:already in use|in use|eaddrinuse)|eaddrinuse/i

type BrowserStartupErrorCode = 'CDP_BIND' | 'PROFILE_IN_USE'

export class BrowserStartupError extends Error {
  public constructor(
    public readonly code: BrowserStartupErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'BrowserStartupError'
  }
}

interface BrowserLaunchDependencies {
  connector: BrowserConnector<BrowserRuntimeConnection>
  launchProcess(
    executable: string,
    args: string[],
    cleanupTimeoutMs: number,
    startupDeadline: number,
    signal?: AbortSignal
  ): Promise<BrowserProcess>
  reserveDynamicPort(
    startupDeadline: number,
    signal?: AbortSignal
  ): Promise<number>
}

export const browserLaunchTestExtensions = Symbol(
  'portal.browser-launch-test-extensions'
)

export interface BrowserLaunchOptions {
  startupTimeoutMs?: number
  closeTimeoutMs?: number
  signal?: AbortSignal
  [browserLaunchTestExtensions]?: Partial<BrowserLaunchDependencies>
}

export function createBrowserDisconnectSignal(
  browser: BrowserConnectionEvents,
  isClosing: () => boolean
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    const onDisconnected = () => {
      if (settled) {
        return
      }
      settled = true
      if (!isClosing()) {
        resolve()
      }
    }

    browser.once('disconnected', onDisconnected)
    if (!browser.isConnected()) {
      browser.off('disconnected', onDisconnected)
      onDisconnected()
    }
  })
}

function createBrowserProcessExitSignal(
  child: ChildProcess,
  isClosing: () => boolean
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    const onExit = () => {
      if (settled) {
        return
      }
      settled = true
      child.off('exit', onExit)
      if (!isClosing()) {
        resolve()
      }
    }

    child.once('exit', onExit)
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit()
    }
  })
}

export function createBrowserProcessFailureMonitor(
  child: ChildProcess
): BrowserProcessFailureMonitor {
  let settled = false
  let rejectFailure!: (error: Error) => void
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject
  })
  const onError = (error: Error) => {
    if (!settled) {
      settled = true
      rejectFailure(
        new Error(`Browser process failed during startup: ${error.message}`, {
          cause: error,
        })
      )
    }
  }
  const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) => {
    if (!settled) {
      settled = true
      const status =
        exitSignal === null
          ? `exit code ${String(code)}`
          : `signal ${exitSignal}`
      rejectFailure(
        new Error(`Browser exited while connecting to CDP (${status}).`)
      )
    }
  }
  const close = () => {
    child.off('error', onError)
    child.off('exit', onExit)
  }

  child.once('error', onError)
  child.once('exit', onExit)
  if (child.exitCode !== null || child.signalCode !== null) {
    onExit(child.exitCode, child.signalCode)
  }

  return { failure, close }
}

function resolveBrowserType(browserEngine: BrowserEngine): BrowserType {
  if (browserEngine !== 'chromium') {
    throw new Error(`Unsupported browser engine: ${String(browserEngine)}`)
  }
  return chromium
}

export function buildBrowserLaunchArguments(
  browserUserDataDir: string,
  browserRemoteDebuggingPort: number
): string[] {
  if (browserRemoteDebuggingPort <= 0) {
    throw new Error('Chromium requires an actual non-zero CDP port.')
  }
  return [
    `--remote-debugging-port=${browserRemoteDebuggingPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${browserUserDataDir}`,
    '--homepage=about:blank',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-popup-blocking',
    '--disable-extensions',
    '--disable-sync',
    '--password-store=basic',
    '--use-mock-keychain',
  ]
}

export async function waitForBrowserDevToolsEndpoint(
  child: ChildProcess,
  configuredPort: number,
  startupDeadline: number,
  signal?: AbortSignal
): Promise<string> {
  throwIfAborted(signal)
  const stderr = child.stderr
  if (stderr === null) {
    throw new Error('Browser process stderr is unavailable.')
  }

  return await new Promise<string>((resolve, reject) => {
    let logs = ''
    let settled = false
    const remainingMs = Math.max(0, startupDeadline - Date.now())

    const cleanup = () => {
      clearTimeout(timer)
      stderr.off('data', onData)
      child.off('error', onError)
      child.off('close', onClose)
      signal?.removeEventListener('abort', onAbort)
    }
    const fail = (error: Error) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(error)
    }
    const succeed = (endpoint: string) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(endpoint)
    }
    const onData = (chunk: Buffer | string) => {
      logs += chunk.toString()
      if (Buffer.byteLength(logs) > MAX_BROWSER_STARTUP_LOG_BYTES) {
        logs = logs.slice(-MAX_BROWSER_STARTUP_LOG_BYTES)
      }
      const diagnostic = classifyBrowserStartupLog(logs, configuredPort)
      if (diagnostic !== null) {
        fail(diagnostic)
        return
      }
      const match = logs.match(/DevTools listening on ([^\r\n]+)/)
      if (match === null) {
        return
      }
      try {
        succeed(validateBrowserDevToolsEndpoint(match[1]!, configuredPort))
      } catch (error) {
        fail(
          error instanceof Error
            ? error
            : new Error('Chromium reported an invalid CDP endpoint.')
        )
      }
    }
    const onError = (error: Error) => {
      fail(
        new Error(`Failed to start browser process: ${error.message}`, {
          cause: error,
        })
      )
    }
    const onClose = (
      code: number | null,
      exitSignal: NodeJS.Signals | null
    ) => {
      const status =
        exitSignal === null
          ? `exit code ${String(code)}`
          : `signal ${exitSignal}`
      const diagnostic = classifyBrowserStartupLog(logs, configuredPort)
      if (diagnostic !== null) {
        fail(diagnostic)
        return
      }
      fail(new Error(`Browser exited before CDP was ready (${status}).`))
    }
    const onAbort = () => {
      fail(getAbortError(signal))
    }
    const timer = setTimeout(() => {
      fail(new Error('Timed out waiting for the browser CDP endpoint.'))
    }, remainingMs)

    stderr.on('data', onData)
    child.once('error', onError)
    child.once('close', onClose)
    signal?.addEventListener('abort', onAbort, { once: true })

    if (signal?.aborted) {
      onAbort()
    } else if (
      (child.exitCode !== null || child.signalCode !== null) &&
      stderr.closed
    ) {
      queueMicrotask(() => onClose(child.exitCode, child.signalCode))
    }
  })
}

function classifyBrowserStartupLog(
  logs: string,
  configuredPort: number
): BrowserStartupError | null {
  if (PROFILE_SINGLETON_ERROR.test(logs)) {
    return new BrowserStartupError(
      'PROFILE_IN_USE',
      'Browser profile is already in use by another Chromium process.'
    )
  }
  if (CDP_BIND_ERROR.test(logs)) {
    return new BrowserStartupError(
      'CDP_BIND',
      `Browser remote debugging port ${configuredPort} is already in use.`
    )
  }
  return null
}

export async function connectBrowserOverCDP<TBrowser extends BrowserConnection>(
  connector: BrowserConnector<TBrowser>,
  endpoint: string,
  startupDeadline: number,
  signal?: AbortSignal,
  processFailure?: Promise<never>
): Promise<TBrowser> {
  throwIfAborted(signal)
  const remainingMs = startupDeadline - Date.now()
  if (remainingMs <= 0) {
    throw new Error('Timed out before connecting to the browser over CDP.')
  }

  const connection = connector.connectOverCDP(endpoint, {
    timeout: remainingMs,
  })
  try {
    return await raceStartupOperation(
      connection,
      remainingMs,
      'Timed out connecting to the browser over CDP.',
      signal,
      processFailure
    )
  } catch (error) {
    void connection.then(
      async (lateBrowser) => {
        await lateBrowser.close().catch(() => {})
      },
      () => {}
    )
    throw sanitizeBrowserConnectionError(error)
  }
}

export function sanitizeBrowserConnectionError(error: unknown): unknown {
  if (!(error instanceof Error) || error.name === 'AbortError') {
    return error
  }
  const message = error.message.replace(
    /(wss?:\/\/(?:localhost|127\.0\.0\.1|\[?::1\]?):\d+\/devtools\/browser\/)[^\s'"\\]+/giu,
    '$1[redacted]'
  )
  if (message === error.message) {
    return error
  }
  const sanitized = new Error(message)
  sanitized.name = error.name
  return sanitized
}

export async function launchBrowser(
  browserEngine: BrowserEngine,
  browserExecutablePath: string,
  browserRemoteDebuggingPort: number,
  browserUserDataDir: string,
  options: BrowserLaunchOptions = {}
): Promise<BrowserLaunch> {
  const connector = resolveBrowserType(browserEngine)
  const startupTimeoutMs =
    options.startupTimeoutMs ?? BROWSER_STARTUP_TIMEOUT_MS
  const closeTimeoutMs = options.closeTimeoutMs ?? BROWSER_CLOSE_TIMEOUT_MS
  const signal = options.signal
  const startupDeadline = Date.now() + startupTimeoutMs
  const testExtensions = options[browserLaunchTestExtensions]
  const dependencies: BrowserLaunchDependencies = {
    connector: testExtensions?.connector ?? connector,
    launchProcess:
      testExtensions?.launchProcess ??
      (async (executable, args, cleanupTimeoutMs, deadline, launchSignal) =>
        await launchBrowserProcess(
          executable,
          args,
          cleanupTimeoutMs,
          deadline,
          launchSignal
        )),
    reserveDynamicPort:
      testExtensions?.reserveDynamicPort ??
      (async (deadline, reserveSignal) =>
        await reserveDynamicBrowserPort(reserveSignal, deadline)),
  }

  throwIfAborted(signal)
  if (
    !Number.isSafeInteger(browserRemoteDebuggingPort) ||
    browserRemoteDebuggingPort < 0 ||
    browserRemoteDebuggingPort > 65_535
  ) {
    throw new Error(
      `Invalid browser remote debugging port: ${browserRemoteDebuggingPort}`
    )
  }
  if (!fs.existsSync(browserExecutablePath)) {
    throw new Error(
      `Browser executable not found at path: ${browserExecutablePath}`
    )
  }

  if (browserRemoteDebuggingPort !== 0) {
    await assertBrowserPortAvailable(
      browserRemoteDebuggingPort,
      startupDeadline,
      signal
    )
  }

  ensurePrivateDirectorySync(browserUserDataDir)

  const dynamicPort = browserRemoteDebuggingPort === 0
  const maxAttempts = dynamicPort ? MAX_DYNAMIC_CDP_BIND_ATTEMPTS : 1
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(signal)
    if (Date.now() >= startupDeadline) {
      throw new Error('Timed out before starting the browser process.')
    }
    const actualPort = dynamicPort
      ? await dependencies.reserveDynamicPort(startupDeadline, signal)
      : browserRemoteDebuggingPort
    throwIfAborted(signal)
    if (Date.now() >= startupDeadline) {
      throw new Error('Timed out before starting the browser process.')
    }

    try {
      return await launchBrowserAttempt(
        dependencies,
        browserExecutablePath,
        actualPort,
        browserUserDataDir,
        startupDeadline,
        closeTimeoutMs,
        signal
      )
    } catch (error) {
      if (
        !dynamicPort ||
        !(error instanceof BrowserStartupError) ||
        error.code !== 'CDP_BIND' ||
        attempt === maxAttempts
      ) {
        throw error
      }
    }
  }

  throw new Error('Browser startup attempts were exhausted.')
}

async function launchBrowserAttempt(
  dependencies: BrowserLaunchDependencies,
  browserExecutablePath: string,
  actualPort: number,
  browserUserDataDir: string,
  startupDeadline: number,
  closeTimeoutMs: number,
  signal?: AbortSignal
): Promise<BrowserLaunch> {
  const browserArguments = buildBrowserLaunchArguments(
    browserUserDataDir,
    actualPort
  )
  const browserProcess = await dependencies.launchProcess(
    browserExecutablePath,
    browserArguments,
    closeTimeoutMs,
    startupDeadline,
    signal
  )
  let browser: BrowserRuntimeConnection | null = null

  try {
    const endpoint = await waitForBrowserDevToolsEndpoint(
      browserProcess.process,
      actualPort,
      startupDeadline,
      signal
    )
    browserProcess.process.stderr?.resume()
    const processFailure = createBrowserProcessFailureMonitor(
      browserProcess.process
    )
    let connectedBrowser: BrowserRuntimeConnection
    try {
      connectedBrowser = await connectBrowserOverCDP(
        dependencies.connector,
        endpoint,
        startupDeadline,
        signal,
        processFailure.failure
      )
    } finally {
      processFailure.close()
    }
    browser = connectedBrowser
    const context = connectedBrowser.contexts()[0]
    if (context === undefined) {
      throw new Error('Browser connected over CDP without a default context.')
    }

    let closing = false
    let closePromise: Promise<void> | null = null
    const disconnected = Promise.race([
      createBrowserDisconnectSignal(connectedBrowser, () => closing),
      createBrowserProcessExitSignal(browserProcess.process, () => closing),
    ]).then(async () => await browserProcess.close(Date.now() + closeTimeoutMs))
    return {
      context,
      disconnected,
      remoteDebuggingPort: actualPort,
      close: () => {
        if (closePromise !== null) {
          return closePromise
        }
        closing = true
        closePromise = (async () => {
          const closeDeadline = Date.now() + closeTimeoutMs
          await Promise.all([
            withDeadline(connectedBrowser.close(), closeDeadline).catch(
              () => {}
            ),
            browserProcess.close(closeDeadline),
          ])
        })()
        return closePromise
      },
    }
  } catch (error) {
    browserProcess.process.stderr?.resume()
    const closeDeadline = Date.now() + closeTimeoutMs
    const browserClose =
      browser === null
        ? Promise.resolve()
        : withDeadline(browser.close(), closeDeadline).catch(() => {})
    try {
      await Promise.all([browserClose, browserProcess.close(closeDeadline)])
    } catch (cleanupError) {
      if (cleanupError instanceof BrowserProcessTreeCleanupError) {
        throw cleanupError
      }
      throw new BrowserProcessTreeCleanupError(
        'Browser process tree cleanup could not be verified after startup failed.',
        {
          cause: new AggregateError([error, cleanupError]),
        }
      )
    }
    throw error
  }
}

function validateBrowserDevToolsEndpoint(
  rawEndpoint: string,
  configuredPort: number
): string {
  let endpoint: URL
  try {
    endpoint = new URL(rawEndpoint.trim())
  } catch (error) {
    throw new Error('Chromium reported an invalid CDP WebSocket URL.', {
      cause: error,
    })
  }

  if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') {
    throw new Error('Chromium reported a non-WebSocket CDP endpoint.')
  }
  const hostname = endpoint.hostname.toLowerCase()
  if (
    hostname !== 'localhost' &&
    hostname !== '127.0.0.1' &&
    hostname !== '::1' &&
    hostname !== '[::1]'
  ) {
    throw new Error('Chromium reported a non-loopback CDP endpoint.')
  }
  const endpointPort = Number(endpoint.port)
  if (!Number.isSafeInteger(endpointPort) || endpointPort <= 0) {
    throw new Error('Chromium reported a CDP endpoint without a valid port.')
  }
  if (endpointPort !== configuredPort) {
    throw new Error(
      `Chromium reported CDP port ${endpointPort}, expected ${configuredPort}.`
    )
  }
  return endpoint.href
}

async function assertBrowserPortAvailable(
  port: number,
  startupDeadline: number,
  signal?: AbortSignal
): Promise<void> {
  await reserveLoopbackPort(port, startupDeadline, signal)
}

export async function reserveDynamicBrowserPort(
  signal?: AbortSignal,
  startupDeadline = Number.POSITIVE_INFINITY
): Promise<number> {
  return await reserveLoopbackPort(0, startupDeadline, signal)
}

async function reserveLoopbackPort(
  requestedPort: number,
  startupDeadline: number,
  signal?: AbortSignal
): Promise<number> {
  throwIfAborted(signal)
  if (Date.now() >= startupDeadline) {
    throw new Error('Timed out while reserving a browser CDP port.')
  }
  const server = net.createServer()
  server.unref()
  let actualPort = 0
  const probeController = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  const onCallerAbort = () => probeController.abort(getAbortError(signal))
  signal?.addEventListener('abort', onCallerAbort, { once: true })

  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        server.off('error', onError)
        server.off('listening', onListening)
        probeController.signal.removeEventListener('abort', onProbeAbort)
      }
      const onError = (error: NodeJS.ErrnoException) => {
        cleanup()
        if (signal?.aborted) {
          reject(getAbortError(signal))
          return
        }
        if (error.code === 'EADDRINUSE') {
          reject(
            new Error(
              `Browser remote debugging port ${requestedPort} is already in use.`
            )
          )
          return
        }
        if (error.code === 'EACCES') {
          reject(
            new Error(
              `Browser remote debugging port ${requestedPort} is not permitted.`
            )
          )
          return
        }
        reject(error)
      }
      const onListening = () => {
        cleanup()
        const address = server.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('Browser CDP port probe returned no TCP address.'))
          return
        }
        actualPort = address.port
        resolve()
      }
      const onProbeAbort = () => {
        cleanup()
        reject(
          signal?.aborted
            ? getAbortError(signal)
            : new Error('Timed out while reserving a browser CDP port.')
        )
      }

      server.once('error', onError)
      server.once('listening', onListening)
      probeController.signal.addEventListener('abort', onProbeAbort, {
        once: true,
      })
      if (Number.isFinite(startupDeadline)) {
        timer = setTimeout(
          () => probeController.abort(),
          Math.max(0, startupDeadline - Date.now())
        )
      }
      server.listen({
        host: '127.0.0.1',
        port: requestedPort,
        exclusive: true,
        signal: probeController.signal,
      })
      if (signal?.aborted) {
        onCallerAbort()
      }
    })
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
    signal?.removeEventListener('abort', onCallerAbort)
    probeController.abort()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  if (actualPort <= 0) {
    throw new Error('Browser CDP port probe did not allocate a valid port.')
  }
  return actualPort
}

async function launchBrowserProcess(
  executable: string,
  args: string[],
  cleanupTimeoutMs: number,
  startupDeadline: number,
  signal?: AbortSignal
): Promise<BrowserProcess> {
  if (process.platform === 'win32') {
    return await launchWin32Browser(executable, args, undefined, {
      cleanupTimeoutMs,
      startupDeadline,
      ...(signal === undefined ? {} : { signal }),
    })
  }
  return launchPosixBrowser(executable, args, {
    cleanupTimeoutMs,
    startupDeadline,
    ...(signal === undefined ? {} : { signal }),
  })
}

async function raceStartupOperation<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  signal?: AbortSignal,
  processFailure?: Promise<never>
): Promise<T> {
  throwIfAborted(signal)
  let timer: ReturnType<typeof setTimeout> | null = null
  let onAbort: (() => void) | null = null
  try {
    const cancellation =
      signal === undefined
        ? null
        : new Promise<never>((_, reject) => {
            onAbort = () => reject(getAbortError(signal))
            signal.addEventListener('abort', onAbort, { once: true })
            if (signal.aborted) {
              onAbort()
            }
          })
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
      }),
      ...(cancellation === null ? [] : [cancellation]),
      ...(processFailure === undefined ? [] : [processFailure]),
    ])
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
    if (onAbort !== null) {
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

async function withDeadline<T>(
  promise: Promise<T>,
  deadline: number
): Promise<T> {
  const timeoutMs = Math.max(0, deadline - Date.now())
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms.`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}
