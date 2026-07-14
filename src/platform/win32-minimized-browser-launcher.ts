/**
 * Windows-native browser launch helpers using koffi FFI.
 * - Job Object: browser killed when this process exits
 * - Window: minimized on launch, terminal focus restored
 */

import { spawn } from 'child_process'
import koffi from 'koffi'
import type { LibraryHandle } from 'koffi'
import { assignPidToJob, closeJob, createJob } from './win32-process-job.ts'
import { sleepAsync } from '../shared/sleep.ts'

const isWin32 = process.platform === 'win32'

let user32: LibraryHandle | null = null

let _ShowWindowAsync: ((hwnd: number, cmd: number) => boolean) | null = null
let _SetForegroundWindow: ((hwnd: number) => boolean) | null = null
let _GetForegroundWindow: (() => number) | null = null

function ensureUser32() {
  if (user32 !== null) return
  if (!isWin32) return
  user32 = koffi.load('user32.dll')
  _ShowWindowAsync = user32.func('ShowWindowAsync', 'bool', ['size_t', 'int'])
  _SetForegroundWindow = user32.func('SetForegroundWindow', 'bool', ['size_t'])
  _GetForegroundWindow = user32.func('GetForegroundWindow', 'size_t', [])
}

export async function launchWin32BrowserMinimized(
  browserExe: string,
  browserArgs: string[]
): Promise<{ pid: number; close(): void }> {
  ensureUser32()

  const job = createJob()
  if (job === null) {
    throw new Error('Failed to create Windows Job Object')
  }

  // Save current foreground window so we can restore focus
  const fgWindow = _GetForegroundWindow!()

  // Launch browser via Node's spawn
  const proc = spawn(browserExe, browserArgs, {
    stdio: 'ignore',
    windowsHide: true,
  })
  proc.unref()

  const pid = proc.pid
  if (pid === undefined) {
    throw new Error('Browser spawn succeeded but returned no PID')
  }

  assignPidToJob(job, pid)
  let closed = false
  const close = () => {
    if (closed) {
      return
    }
    closed = true
    closeJob(job)
    if (!proc.killed) {
      proc.kill()
    }
  }

  // Wait for browser to steal foreground focus, then minimize it
  for (let i = 0; i < 40; i++) {
    const current = _GetForegroundWindow!()
    if (current !== 0 && current !== fgWindow) {
      _ShowWindowAsync!(current, 7) // SW_SHOWMINNOACTIVE
      break
    }
    await sleepAsync(250)
  }

  // Restore original foreground window
  if (fgWindow !== 0) {
    _SetForegroundWindow!(fgWindow)
  }

  return { pid, close }
}
