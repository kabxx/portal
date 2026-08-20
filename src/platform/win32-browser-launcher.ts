import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  getAbortError,
  throwIfAborted,
} from '../runtime/runtime-cancellation.ts'
import {
  BrowserProcessTreeCleanupError,
  type BrowserProcess,
  toBrowserProcessTreeCleanupError,
} from './browser-process.ts'
import {
  assignPidToJob,
  closeJob,
  createJob,
  getJobActiveProcessCount,
  isPidInJob,
  terminateJob,
} from './win32-process-job.ts'

export type Win32BrowserProcess = BrowserProcess

export interface Win32BrowserJobOperations {
  createJob(): number | null
  assignPidToJob(job: number, pid: number): boolean
  isPidInJob(job: number, pid: number): boolean
  terminateJob(job: number, exitCode?: number): boolean
  getJobActiveProcessCount(job: number): number | null
  closeJob(job: number): void
}

export interface Win32BrowserLaunchOptions {
  cleanupTimeoutMs?: number
  helperCommand?: string
  helperArguments?: string[]
  signal?: AbortSignal
  startupDeadline?: number
}

const HELPER_HANDSHAKE_TIMEOUT_MS = 5000
const CLEANUP_POLL_INTERVAL_MS = 25

const defaultJobOperations: Win32BrowserJobOperations = {
  createJob,
  assignPidToJob,
  isPidInJob,
  terminateJob,
  getJobActiveProcessCount,
  closeJob,
}

export async function launchWin32Browser(
  browserExecutable: string,
  browserArguments: string[],
  jobOperations: Win32BrowserJobOperations = defaultJobOperations,
  options: Win32BrowserLaunchOptions = {}
): Promise<Win32BrowserProcess> {
  throwIfAborted(options.signal)
  throwIfStartupDeadlineExpired(options.startupDeadline)
  const job = jobOperations.createJob()
  if (job === null) {
    throw new Error('Failed to create Windows Job Object.')
  }

  const helperCommand = options.helperCommand ?? process.execPath
  const helperArguments =
    options.helperArguments ?? resolveWin32BrowserHelperArguments()
  const helper = spawn(helperCommand, helperArguments, {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  })
  let cleanup: ((deadline?: number) => Promise<void>) | null = null

  try {
    await waitForHelperMessage(
      helper,
      (message) => message.type === 'ready',
      options
    )
    throwIfAborted(options.signal)
    throwIfStartupDeadlineExpired(options.startupDeadline)
    const helperPid = helper.pid
    if (helperPid === undefined) {
      throw new Error('Windows browser helper returned no PID.')
    }
    if (!jobOperations.assignPidToJob(job, helperPid)) {
      throw new Error(
        'Failed to assign Windows browser helper to the Job Object.'
      )
    }
    if (!jobOperations.isPidInJob(job, helperPid)) {
      throw new Error(
        'Windows browser helper Job Object membership could not be verified.'
      )
    }

    cleanup = createWin32ProcessTreeCleanup(
      helper,
      job,
      jobOperations,
      options.cleanupTimeoutMs
    )
    helper.once('exit', () => {
      void cleanup?.().catch(() => {})
    })
    const attemptId = randomUUID()
    const launched = waitForHelperMessage(
      helper,
      (message) =>
        (message.type === 'launched' || message.type === 'failed') &&
        message.attemptId === attemptId,
      options
    )
    let result: HelperMessage
    try {
      await sendHelperMessage(
        helper,
        {
          type: 'launch',
          attemptId,
          browserExecutable,
          browserArguments,
        },
        options
      )
      result = await launched
    } catch (error) {
      void launched.catch(() => {})
      throw error
    }
    if (result.type === 'failed') {
      throw new Error(`Windows browser helper failed: ${result.message}`)
    }
    if (result.type !== 'launched') {
      throw new Error('Windows browser helper returned an invalid response.')
    }
    helper.unref()
    helper.channel?.unref()
    return {
      process: helper,
      browserPid: result.pid,
      close: cleanup,
    }
  } catch (error) {
    if (cleanup !== null) {
      try {
        await cleanup()
      } catch (cleanupError) {
        throw toBrowserProcessTreeCleanupError(cleanupError)
      }
    } else {
      await terminateUnassignedHelper(helper)
      try {
        jobOperations.closeJob(job)
      } catch {
        // Preserve the launch error; no browser was allowed to start.
      }
    }
    throw error
  }
}

interface ReadyMessage {
  type: 'ready'
}

interface LaunchedMessage {
  type: 'launched'
  attemptId: string
  pid: number
}

interface FailedMessage {
  type: 'failed'
  attemptId: string
  message: string
}

type HelperMessage = ReadyMessage | LaunchedMessage | FailedMessage

function resolveWin32BrowserHelperArguments(): string[] {
  const compiled = new URL('./win32-browser-helper.js', import.meta.url)
  if (existsSync(compiled)) {
    return [fileURLToPath(compiled)]
  }
  const source = new URL('./win32-browser-helper.ts', import.meta.url)
  return ['--import', 'tsx', fileURLToPath(source)]
}

async function waitForHelperMessage(
  helper: ChildProcess,
  accept: (message: HelperMessage) => boolean,
  options: Pick<Win32BrowserLaunchOptions, 'signal' | 'startupDeadline'> = {}
): Promise<HelperMessage> {
  return await new Promise<HelperMessage>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      helper.off('message', onMessage)
      helper.off('error', onError)
      helper.off('exit', onExit)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onMessage = (value: unknown) => {
      const message = parseHelperMessage(value)
      if (message === null || !accept(message) || settled) return
      settled = true
      cleanup()
      resolve(message)
    }
    const onError = (error: Error) => fail(error)
    const onAbort = () => fail(getAbortError(options.signal))
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const status =
        signal === null ? `exit code ${String(code)}` : `signal ${signal}`
      fail(new Error(`Windows browser helper exited during ${status}.`))
    }
    const waitDeadline = Math.min(
      Date.now() + HELPER_HANDSHAKE_TIMEOUT_MS,
      options.startupDeadline ?? Number.POSITIVE_INFINITY
    )
    const remainingMs = waitDeadline - Date.now()
    const timer = setTimeout(
      () => {
        fail(new Error('Timed out waiting for the Windows browser helper.'))
      },
      Math.max(0, remainingMs)
    )

    helper.on('message', onMessage)
    helper.once('error', onError)
    helper.once('exit', onExit)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) {
      onAbort()
    } else if (remainingMs <= 0) {
      fail(new Error('Timed out waiting for the Windows browser helper.'))
    } else if (helper.exitCode !== null || helper.signalCode !== null) {
      onExit(helper.exitCode, helper.signalCode)
    }
  })
}

function parseHelperMessage(value: unknown): HelperMessage | null {
  if (value === null || typeof value !== 'object' || !('type' in value)) {
    return null
  }
  const type = value.type
  if (type === 'ready') return { type }
  if (!('attemptId' in value) || typeof value.attemptId !== 'string') {
    return null
  }
  const attemptId = value.attemptId
  if (type === 'launched') {
    if (!('pid' in value)) return null
    const pid = value.pid
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0
      ? { type, attemptId, pid }
      : null
  }
  if (type === 'failed') {
    if (!('message' in value)) return null
    const message = value.message
    return typeof message === 'string' ? { type, attemptId, message } : null
  }
  return null
}

async function sendHelperMessage(
  helper: ChildProcess,
  message: {
    type: 'launch'
    attemptId: string
    browserExecutable: string
    browserArguments: string[]
  },
  options: Pick<Win32BrowserLaunchOptions, 'signal' | 'startupDeadline'> = {}
): Promise<void> {
  throwIfAborted(options.signal)
  throwIfStartupDeadlineExpired(options.startupDeadline)
  const operation = new Promise<void>((resolve, reject) => {
    helper.send(message, (error) => {
      if (error === null) resolve()
      else reject(error)
    })
  })
  await raceHelperOperation(operation, options)
}

function createWin32ProcessTreeCleanup(
  helper: ChildProcess,
  job: number,
  jobOperations: Win32BrowserJobOperations,
  cleanupTimeoutMs = 3000
): (deadline?: number) => Promise<void> {
  let closePromise: Promise<void> | null = null
  return (deadline = Date.now() + cleanupTimeoutMs) => {
    closePromise ??= closeWin32ProcessTree(helper, job, jobOperations, deadline)
    return closePromise
  }
}

async function closeWin32ProcessTree(
  helper: ChildProcess,
  job: number,
  jobOperations: Win32BrowserJobOperations,
  deadline: number
): Promise<void> {
  let failure: unknown = null
  try {
    const active = jobOperations.getJobActiveProcessCount(job)
    if (active === null) {
      throw new Error('Failed to query the Windows browser Job Object.')
    }
    if (active > 0 && !jobOperations.terminateJob(job)) {
      throw new Error('Failed to terminate the Windows browser Job Object.')
    }
    await waitForEmptyJob(job, jobOperations, deadline)
    await waitForChildExit(helper, deadline)
  } catch (error) {
    failure = error
  } finally {
    try {
      jobOperations.closeJob(job)
    } catch (error) {
      failure ??= error
    }
  }
  if (failure !== null) {
    throw new BrowserProcessTreeCleanupError(
      'Windows browser process tree cleanup could not be verified.',
      failure instanceof Error ? { cause: failure } : undefined
    )
  }
}

async function raceHelperOperation<T>(
  operation: Promise<T>,
  options: Pick<Win32BrowserLaunchOptions, 'signal' | 'startupDeadline'>
): Promise<T> {
  throwIfAborted(options.signal)
  throwIfStartupDeadlineExpired(options.startupDeadline)
  let timer: ReturnType<typeof setTimeout> | null = null
  let onAbort: (() => void) | null = null
  try {
    const races: Promise<T>[] = [operation]
    if (options.startupDeadline !== undefined) {
      const remainingMs = options.startupDeadline - Date.now()
      races.push(
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  'Timed out while starting the Windows browser helper.'
                )
              ),
            Math.max(0, remainingMs)
          )
        })
      )
    }
    if (options.signal !== undefined) {
      races.push(
        new Promise<never>((_, reject) => {
          onAbort = () => reject(getAbortError(options.signal))
          options.signal?.addEventListener('abort', onAbort, { once: true })
          if (options.signal?.aborted) onAbort()
        })
      )
    }
    return await Promise.race(races)
  } finally {
    if (timer !== null) clearTimeout(timer)
    if (onAbort !== null) {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }
}

function throwIfStartupDeadlineExpired(deadline?: number): void {
  if (deadline !== undefined && Date.now() >= deadline) {
    throw new Error('Timed out before starting the Windows browser helper.')
  }
}

async function waitForEmptyJob(
  job: number,
  jobOperations: Win32BrowserJobOperations,
  deadline: number
): Promise<void> {
  while (Date.now() <= deadline) {
    const active = jobOperations.getJobActiveProcessCount(job)
    if (active === 0) return
    if (active === null) {
      throw new Error('Failed to query the Windows browser Job Object.')
    }
    await delay(CLEANUP_POLL_INTERVAL_MS)
  }
  throw new Error('Timed out waiting for the Windows browser Job Object.')
}

async function waitForChildExit(
  child: ChildProcess,
  deadline: number
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const remainingMs = Math.max(0, deadline - Date.now())
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      child.off('exit', onExit)
    }
    const onExit = () => {
      cleanup()
      resolve()
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for the browser helper to exit.'))
    }, remainingMs)
    child.once('exit', onExit)
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit()
    }
  })
}

async function terminateUnassignedHelper(helper: ChildProcess): Promise<void> {
  if (helper.exitCode !== null || helper.signalCode !== null) return
  helper.kill('SIGKILL')
  await waitForChildExit(helper, Date.now() + 1000).catch(() => {})
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}
