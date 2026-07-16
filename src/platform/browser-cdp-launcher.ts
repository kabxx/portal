import fs from 'fs'
import net from 'node:net'
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, BrowserType } from 'playwright'
import {
  getAbortError,
  throwIfAborted,
} from '../runtime/runtime-cancellation.ts'
import { launchWin32BrowserMinimized } from './win32-minimized-browser-launcher.ts'
import type { BrowserEngine } from './platform-defaults.ts'

export interface BrowserLaunch {
  context: BrowserContext
  disconnected: Promise<void>
  close(): Promise<void>
}

export interface BrowserConnectionEvents {
  once(event: 'disconnected', listener: () => void): unknown
  off(event: 'disconnected', listener: () => void): unknown
  isConnected(): boolean
}

export interface BrowserConnector {
  connectOverCDP(
    endpoint: string,
    options: { timeout: number }
  ): Promise<Browser>
}

export interface BrowserProcessFailureMonitor {
  failure: Promise<never>
  close(): void
}

interface BrowserProcess {
  process: ChildProcess
  close(): void
}

const BROWSER_CLOSE_TIMEOUT_MS = 3000
const BROWSER_STARTUP_TIMEOUT_MS = 60_000
const MAX_BROWSER_STARTUP_LOG_BYTES = 64 * 1024
const PROFILE_SINGLETON_ERROR =
  'Failed to create a ProcessSingleton for your profile directory.'

export interface BrowserLaunchOptions {
  startupTimeoutMs?: number
  closeTimeoutMs?: number
  signal?: AbortSignal
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
  return [
    `--remote-debugging-port=${browserRemoteDebuggingPort}`,
    `--user-data-dir=${browserUserDataDir}`,
    '--homepage=about:blank',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-popup-blocking',
    '--enable-automation',
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
      child.off('exit', onExit)
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
      if (logs.includes(PROFILE_SINGLETON_ERROR)) {
        fail(
          new Error(
            'Browser profile is already in use by another Chromium process.'
          )
        )
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
    const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) => {
      const status =
        exitSignal === null
          ? `exit code ${String(code)}`
          : `signal ${exitSignal}`
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
    child.once('exit', onExit)
    signal?.addEventListener('abort', onAbort, { once: true })

    if (signal?.aborted) {
      onAbort()
    } else if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode)
    }
  })
}

export async function connectBrowserOverCDP(
  connector: BrowserConnector,
  endpoint: string,
  startupDeadline: number,
  signal?: AbortSignal,
  processFailure?: Promise<never>
): Promise<Browser> {
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
    throw error
  }
}

export async function launchBrowser(
  browserEngine: BrowserEngine,
  browserExecutablePath: string,
  browserRemoteDebuggingPort: number,
  browserUserDataDir: string,
  options: BrowserLaunchOptions = {}
): Promise<BrowserLaunch> {
  const browserType = resolveBrowserType(browserEngine)
  const startupTimeoutMs =
    options.startupTimeoutMs ?? BROWSER_STARTUP_TIMEOUT_MS
  const closeTimeoutMs = options.closeTimeoutMs ?? BROWSER_CLOSE_TIMEOUT_MS
  const signal = options.signal
  const startupDeadline = Date.now() + startupTimeoutMs

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
    await assertBrowserPortAvailable(browserRemoteDebuggingPort, signal)
  }

  if (!fs.existsSync(browserUserDataDir)) {
    fs.mkdirSync(browserUserDataDir, { recursive: true })
  }

  const browserArguments = buildBrowserLaunchArguments(
    browserUserDataDir,
    browserRemoteDebuggingPort
  )
  const browserProcess = await launchBrowserProcess(
    browserExecutablePath,
    browserArguments
  )
  let browser: Browser | null = null

  try {
    const endpoint = await waitForBrowserDevToolsEndpoint(
      browserProcess.process,
      browserRemoteDebuggingPort,
      startupDeadline,
      signal
    )
    browserProcess.process.stderr?.resume()
    const processFailure = createBrowserProcessFailureMonitor(
      browserProcess.process
    )
    let connectedBrowser: Browser
    try {
      connectedBrowser = await connectBrowserOverCDP(
        browserType,
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
    ])
    return {
      context,
      disconnected,
      close: () => {
        if (closePromise !== null) {
          return closePromise
        }
        closing = true
        closePromise = (async () => {
          await withTimeout(connectedBrowser.close(), closeTimeoutMs).catch(
            () => {}
          )
          browserProcess.close()
        })()
        return closePromise
      },
    }
  } catch (error) {
    browserProcess.process.stderr?.resume()
    if (browser !== null) {
      await withTimeout(browser.close(), closeTimeoutMs).catch(() => {})
    }
    browserProcess.close()
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
  if (configuredPort !== 0 && endpointPort !== configuredPort) {
    throw new Error(
      `Chromium reported CDP port ${endpointPort}, expected ${configuredPort}.`
    )
  }
  return endpoint.href
}

async function assertBrowserPortAvailable(
  port: number,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal)
  const server = net.createServer()
  server.unref()

  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        server.off('error', onError)
        server.off('listening', onListening)
        signal?.removeEventListener('abort', onAbort)
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
              `Browser remote debugging port ${port} is already in use.`
            )
          )
          return
        }
        if (error.code === 'EACCES') {
          reject(
            new Error(`Browser remote debugging port ${port} is not permitted.`)
          )
          return
        }
        reject(error)
      }
      const onListening = () => {
        cleanup()
        resolve()
      }
      const onAbort = () => {
        cleanup()
        server.close(() => {})
        reject(getAbortError(signal))
      }

      server.once('error', onError)
      server.once('listening', onListening)
      signal?.addEventListener('abort', onAbort, { once: true })
      server.listen({
        host: '127.0.0.1',
        port,
        exclusive: true,
      })
      if (signal?.aborted) {
        onAbort()
      }
    })
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

async function launchBrowserProcess(
  executable: string,
  args: string[]
): Promise<BrowserProcess> {
  if (process.platform === 'win32') {
    return await launchWin32BrowserMinimized(executable, args)
  }

  const child = spawn(executable, args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.unref()
  let closed = false
  return {
    process: child,
    close: () => {
      if (closed) {
        return
      }
      closed = true
      if (child.pid === undefined) {
        return
      }
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    },
  }
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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
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
