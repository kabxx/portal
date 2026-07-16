/**
 * Windows-native browser launch helpers using koffi FFI.
 * - Job Object: browser killed when this process exits
 * - Window: minimized on launch, terminal focus restored
 */

import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import koffi from 'koffi'
import type { LibraryHandle } from 'koffi'
import { assignPidToJob, closeJob, createJob } from './win32-process-job.ts'
import { sleepAsync } from '../shared/sleep.ts'

const isWin32 = process.platform === 'win32'

let user32: LibraryHandle | null = null

let _ShowWindowAsync: ((hwnd: number, cmd: number) => boolean) | null = null
let _SetForegroundWindow: ((hwnd: number) => boolean) | null = null
let _GetForegroundWindow: (() => number) | null = null
let _GetWindowThreadProcessId:
  | ((hwnd: number, processId: [number | null]) => number)
  | null = null

function ensureUser32() {
  if (user32 !== null) return
  if (!isWin32) return
  user32 = koffi.load('user32.dll')
  _ShowWindowAsync = user32.func('ShowWindowAsync', 'bool', ['size_t', 'int'])
  _SetForegroundWindow = user32.func('SetForegroundWindow', 'bool', ['size_t'])
  _GetForegroundWindow = user32.func('GetForegroundWindow', 'size_t', [])
  _GetWindowThreadProcessId = user32.func('GetWindowThreadProcessId', 'uint', [
    'size_t',
    koffi.out(koffi.pointer('uint')),
  ]) as (hwnd: number, processId: [number | null]) => number
}

export interface Win32BrowserProcess {
  process: ChildProcess
  close(): void
}

export interface Win32BrowserJobOperations {
  createJob(): number | null
  assignPidToJob(job: number, pid: number): boolean
  closeJob(job: number): void
}

const defaultJobOperations: Win32BrowserJobOperations = {
  createJob,
  assignPidToJob,
  closeJob,
}

export async function launchWin32BrowserMinimized(
  browserExe: string,
  browserArgs: string[],
  jobOperations: Win32BrowserJobOperations = defaultJobOperations
): Promise<Win32BrowserProcess> {
  ensureUser32()

  const job = jobOperations.createJob()
  if (job === null) {
    throw new Error('Failed to create Windows Job Object')
  }

  // Save current foreground window so we can restore focus
  const fgWindow = _GetForegroundWindow!()

  // Launch browser via Node's spawn
  const proc = spawn(browserExe, browserArgs, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  proc.unref()

  try {
    await waitForSpawn(proc)
  } catch (error) {
    try {
      jobOperations.closeJob(job)
    } catch {
      // Preserve the spawn error.
    }
    throw error
  }

  const pid = proc.pid
  if (pid === undefined) {
    try {
      jobOperations.closeJob(job)
    } catch {
      // Preserve the missing PID error.
    }
    throw new Error('Browser spawn succeeded but returned no PID')
  }

  if (!jobOperations.assignPidToJob(job, pid)) {
    try {
      jobOperations.closeJob(job)
    } catch {
      // Preserve the assignment error.
    }
    if (proc.exitCode === null) {
      proc.kill()
    }
    throw new Error('Failed to assign browser process to Windows Job Object')
  }

  let closed = false
  const close = () => {
    if (closed) {
      return
    }
    closed = true
    try {
      jobOperations.closeJob(job)
    } catch {
      // The direct process termination below remains available.
    }
    if (proc.exitCode === null) {
      proc.kill()
    }
  }

  void minimizeBrowserWindow(proc, fgWindow).catch(() => {})

  return { process: proc, close }
}

async function waitForSpawn(proc: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      proc.off('error', onError)
      resolve()
    }
    const onError = (error: Error) => {
      proc.off('spawn', onSpawn)
      reject(error)
    }
    proc.once('spawn', onSpawn)
    proc.once('error', onError)
  })
}

async function minimizeBrowserWindow(
  proc: ChildProcess,
  fgWindow: number
): Promise<void> {
  let minimizedWindow = 0
  try {
    for (let i = 0; i < 40 && proc.exitCode === null; i++) {
      const current = _GetForegroundWindow!()
      const processId: [number | null] = [null]
      const ownsWindow =
        current !== 0 &&
        current !== fgWindow &&
        proc.pid !== undefined &&
        _GetWindowThreadProcessId!(current, processId) !== 0 &&
        processId[0] === proc.pid
      if (ownsWindow) {
        _ShowWindowAsync!(current, 7) // SW_SHOWMINNOACTIVE
        minimizedWindow = current
        break
      }
      await sleepAsync(250)
    }
  } finally {
    if (minimizedWindow !== 0 && fgWindow !== 0) {
      _SetForegroundWindow!(fgWindow)
    }
  }
}
