import fs from 'fs'
import { spawn } from 'child_process'
import { chromium } from 'playwright'
import type { BrowserContext, BrowserType } from 'playwright'
import { sleepAsync } from '../shared/sleep.ts'
import { launchWin32BrowserMinimized } from './win32-minimized-browser-launcher.ts'

export interface BrowserLaunch {
  context: BrowserContext
  close(): Promise<void>
}

const BROWSER_CLOSE_TIMEOUT_MS = 3000

function resolveBrowserType(browserName: string): BrowserType {
  switch (browserName) {
    case 'chromium':
    case 'chrome':
    case 'edge':
      return chromium
    default:
      throw new Error(`Unsupported browser for CDP launch: ${browserName}`)
  }
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
  browserName: string,
  browserExecutablePath: string,
  browserRemoteDebuggingPort: number,
  browserUserDataDir: string
): Promise<BrowserLaunch> {
  const browserType = resolveBrowserType(browserName)

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
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const browser = await browserType.connectOverCDP(
        `http://localhost:${browserRemoteDebuggingPort}`
      )
      const context = browser.contexts()[0]!
      return {
        context,
        close: async () => {
          await withTimeout(browser.close(), BROWSER_CLOSE_TIMEOUT_MS).catch(
            () => {}
          )
          if (browserProcess !== null && !browserProcess.killed) {
            browserProcess.kill()
          }
          windowsBrowserProcess?.close()
        },
      }
    } catch (error) {
      lastError = error
      await sleepAsync(1000)
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
