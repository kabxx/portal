import { spawn } from 'node:child_process'

import {
  assignPidToJob,
  closeJob,
  createJob,
} from '../platform/win32-process-job.ts'
import { isAbortError } from '../runtime/runtime-cancellation.ts'

const MAX_OUTPUT_BYTES = 1024 * 1024

export async function runHookCommand(
  command: readonly string[],
  input: unknown,
  options: {
    cwd: string
    timeoutMs: number
    maxOutputBytes?: number
    signal?: AbortSignal
  }
): Promise<string> {
  const [file, ...args] = command
  if (file === undefined) throw new Error('Hook command is empty')
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let job: number | null = null
    if (process.platform === 'win32' && child.pid !== undefined) {
      job = createJob()
      if (job !== null && !assignPidToJob(job, child.pid)) {
        closeJob(job)
        job = null
      }
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let settled = false

    const terminate = () => {
      if (job !== null) {
        closeJob(job)
        job = null
      } else if (child.pid !== undefined && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          child.kill()
        }
      } else {
        child.kill()
      }
    }
    const finish = (error?: unknown, output?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (job !== null) {
        closeJob(job)
        job = null
      }
      error === undefined ? resolve(output ?? '') : reject(error)
    }
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > maxOutputBytes) {
        terminate()
        finish(new Error(`Hook output exceeded ${maxOutputBytes} bytes`))
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.once('error', (error) => finish(error))
    child.once('close', (code, signal) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim()
        finish(
          new Error(
            `Hook command exited with ${code ?? signal}${detail ? `: ${detail}` : ''}`
          )
        )
        return
      }
      finish(undefined, Buffer.concat(stdout).toString('utf8'))
    })
    const onAbort = () => {
      terminate()
      const reason = options.signal?.reason
      finish(
        reason instanceof Error || isAbortError(reason)
          ? reason
          : new Error('Hook command cancelled')
      )
    }
    const timer = setTimeout(() => {
      terminate()
      finish(new Error(`Hook command timed out after ${options.timeoutMs}ms`))
    }, options.timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted === true) {
      onAbort()
      return
    }
    child.stdin.end(`${JSON.stringify(input)}\n`)
  })
}
