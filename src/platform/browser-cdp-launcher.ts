import fs from 'fs'
import { spawn } from 'child_process'
import { chromium } from 'playwright'
import type { BrowserContext, BrowserType } from 'playwright'
import { sleepAsync } from '../shared/sleep.ts'
import { launchWin32BrowserMinimized } from './win32-minimized-browser-launcher.ts'
import type { BrowserEngine } from './platform-defaults.ts'

export interface BrowserLaunch {
  context: BrowserContext
  close(): Promise<void>
}

const BROWSER_CLOSE_TIMEOUT_MS = 3000
const BROWSER_STARTUP_TIMEOUT_MS = 60_000

export interface BrowserLaunchOptions {
  startupTimeoutMs?: number
  closeTimeoutMs?: number
}

function resolveBrowserType(browserEngine: BrowserEngine): BrowserType {
  if (browserEngine !== 'chromium') {
    throw new Error(`Unsupported browser engine: ${browserEngine}`)
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
  ]
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

  if (!fs.existsSync(browserExecutablePath)) {
    throw new Error(
      `Browser executable not found at path: ${browserExecutablePath}`
    )
  }

  if (!fs.existsSync(browserUserDataDir)) {
    fs.mkdirSync(browserUserDataDir, { recursive: true })
  }

  const browserArguments = buildBrowserLaunchArguments(
    browserUserDataDir,
    browserRemoteDebuggingPort
  )
  let browserProcess = null as ReturnType<typeof spawn> | null
  let windowsBrowserProcess = null as Awaited<
    ReturnType<typeof launchWin32BrowserMinimized>
  > | null

  if (process.platform === 'win32') {
    windowsBrowserProcess = await launchWin32BrowserMinimized(
      browserExecutablePath,
      browserArguments
    )
  } else {
    browserProcess = spawn(browserExecutablePath, browserArguments, {
      stdio: 'ignore',
    })
    browserProcess.unref()
  }

  let lastError: unknown = null
  const startupDeadline = Date.now() + startupTimeoutMs
  while (Date.now() < startupDeadline) {
    try {
      const remainingMs = Math.max(1, startupDeadline - Date.now())
      const browser = await browserType.connectOverCDP(
        `http://localhost:${browserRemoteDebuggingPort}`,
        { timeout: remainingMs }
      )
      const context = browser.contexts()[0]!
      return {
        context,
        close: async () => {
          await withTimeout(browser.close(), closeTimeoutMs).catch(() => {})
          if (browserProcess !== null && !browserProcess.killed) {
            browserProcess.kill()
          }
          windowsBrowserProcess?.close()
        },
      }
    } catch (error) {
      lastError = error
      const remainingMs = startupDeadline - Date.now()
      if (remainingMs > 0) {
        await sleepAsync(Math.min(1000, remainingMs))
      }
    }
  }

  if (browserProcess !== null) {
    browserProcess.kill()
  }
  windowsBrowserProcess?.close()
  throw lastError instanceof Error
    ? lastError
    : new Error('Failed to connect to the browser over CDP.')
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
