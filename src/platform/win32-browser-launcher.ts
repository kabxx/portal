import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { assignPidToJob, closeJob, createJob } from './win32-process-job.ts'

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

export async function launchWin32Browser(
  browserExe: string,
  browserArgs: string[],
  jobOperations: Win32BrowserJobOperations = defaultJobOperations
): Promise<Win32BrowserProcess> {
  const job = jobOperations.createJob()
  if (job === null) {
    throw new Error('Failed to create Windows Job Object')
  }

  const process = spawn(browserExe, browserArgs, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  process.unref()

  try {
    await waitForSpawn(process)
  } catch (error) {
    try {
      jobOperations.closeJob(job)
    } catch {
      // Preserve the spawn error.
    }
    throw error
  }

  const pid = process.pid
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
    if (process.exitCode === null) {
      process.kill()
    }
    throw new Error('Failed to assign browser process to Windows Job Object')
  }

  let closed = false
  return {
    process,
    close: () => {
      if (closed) {
        return
      }
      closed = true
      try {
        jobOperations.closeJob(job)
      } catch {
        // The direct process termination below remains available.
      }
      if (process.exitCode === null) {
        process.kill()
      }
    },
  }
}

async function waitForSpawn(process: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      process.off('error', onError)
      resolve()
    }
    const onError = (error: Error) => {
      process.off('spawn', onSpawn)
      reject(error)
    }
    process.once('spawn', onSpawn)
    process.once('error', onError)
  })
}
