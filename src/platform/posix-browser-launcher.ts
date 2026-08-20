import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import {
  toBrowserProcessTreeCleanupError,
  type BrowserProcess,
} from './browser-process.ts'

const PROCESS_GROUP_POLL_INTERVAL_MS = 25

export interface PosixBrowserLaunchOptions {
  cleanupTimeoutMs: number
  termGraceMs?: number
  signal?: AbortSignal
  startupDeadline?: number
}

export function launchPosixBrowser(
  executable: string,
  args: string[],
  options: PosixBrowserLaunchOptions
): BrowserProcess {
  throwIfLaunchCancelled(options)
  const child = spawn(executable, args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.unref()

  const pid = child.pid
  let closePromise: Promise<void> | null = null
  const browserProcess: BrowserProcess = {
    process: child,
    browserPid: pid ?? 0,
    close: (deadline = Date.now() + options.cleanupTimeoutMs) => {
      closePromise ??= closePosixProcessTree(child, pid, options, deadline)
      return closePromise
    },
  }
  child.once('exit', () => {
    void browserProcess.close().catch(() => {})
  })
  return browserProcess
}

async function closePosixProcessTree(
  child: ChildProcess,
  pid: number | undefined,
  options: PosixBrowserLaunchOptions,
  deadline: number
): Promise<void> {
  if (pid === undefined) {
    return
  }

  const termGraceMs = Math.min(
    options.termGraceMs ?? 1000,
    options.cleanupTimeoutMs
  )

  try {
    if (processGroupExists(pid)) {
      signalProcessGroup(pid, 'SIGTERM')
      await waitForProcessGroupExit(
        pid,
        Math.min(deadline, Date.now() + termGraceMs)
      )
    }
    if (processGroupExists(pid)) {
      signalProcessGroup(pid, 'SIGKILL')
      await waitForProcessGroupExit(pid, deadline)
    }
    if (processGroupExists(pid)) {
      throw new Error(`POSIX browser process group ${pid} did not exit.`)
    }
    await waitForChildSettlement(child, deadline)
  } catch (error) {
    throw toBrowserProcessTreeCleanupError(error)
  }
}

function throwIfLaunchCancelled(options: PosixBrowserLaunchOptions): void {
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new DOMException('The operation was aborted.', 'AbortError')
  }
  if (
    options.startupDeadline !== undefined &&
    Date.now() >= options.startupDeadline
  ) {
    throw new Error('Timed out before starting the browser process.')
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (!isNoSuchProcess(error)) {
      throw error
    }
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return isPermissionDenied(error)
  }
}

async function waitForProcessGroupExit(
  pid: number,
  deadline: number
): Promise<void> {
  while (processGroupExists(pid) && Date.now() < deadline) {
    await delay(PROCESS_GROUP_POLL_INTERVAL_MS)
  }
}

async function waitForChildSettlement(
  child: ChildProcess,
  deadline: number
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }

  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) {
    throw new Error('POSIX browser root process was not reaped before timeout.')
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const onExit = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(
        new Error('POSIX browser root process was not reaped before timeout.')
      )
    }, remainingMs)

    child.once('exit', onExit)
    child.once('error', onError)
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit()
    }
  })
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH'
}

function isPermissionDenied(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EPERM'
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}
