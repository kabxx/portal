import os from 'node:os'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import {
  assignPidToJob,
  closeJob,
  createJob,
} from '../platform/win32-process-job.ts'
import {
  PortalAbortError,
  throwIfAborted,
} from '../runtime/runtime-cancellation.ts'

export type RunCommandShell = 'powershell' | 'cmd' | 'bash' | 'sh'
export type RunCommandOutputStream = 'stdout' | 'stderr'
export type RunCommandJobState = 'running' | 'stopping'
export type RunCommandTerminationReason =
  | 'timeout'
  | 'user'
  | 'shutdown'
  | 'encoding_error'
  | null

export interface RunCommandInput {
  command: string
  cwd?: string
  timeoutMs?: number
  shell?: RunCommandShell
}

export interface RunCommandResult {
  command: string
  cwd: string
  shell: string
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
  terminationReason: RunCommandTerminationReason
}

export type RunCommandProgressEvent =
  | { type: 'start'; startedAt: number }
  | {
      type: 'output'
      stream: RunCommandOutputStream
      text: string
    }

export interface RunCommandJobSnapshot {
  id: string
  pid: number | null
  command: string
  cwd: string
  shell: RunCommandShell
  startedAt: number
  state: RunCommandJobState
}

export interface RunCommandJobHandle {
  id: string
  wait(signal?: AbortSignal): Promise<RunCommandResult>
}

export type RunCommandStopResult = 'stopped' | 'not_found' | 'timeout'

export interface RunCommandJobService {
  start(
    input: RunCommandInput,
    onProgress?: (event: RunCommandProgressEvent) => void
  ): RunCommandJobHandle
  list(): RunCommandJobSnapshot[]
  stop(id: string): Promise<RunCommandStopResult>
  beginShutdown(): void
  stopAll(): Promise<void>
}

const MAX_OUTPUT_BUFFER_BYTES = 1024 * 1024 * 4
const TERMINATION_GRACE_MS = 250
const TERMINATION_SETTLE_TIMEOUT_MS = 3000

export interface RunCommandJobManagerOptions {
  maxOutputBufferBytes?: number
  terminationGraceMs?: number
  terminationSettleTimeoutMs?: number
}

interface ResolvedRunCommandJobManagerOptions {
  maxOutputBufferBytes: number
  terminationGraceMs: number
  terminationSettleTimeoutMs: number
}

export class RunCommandEncodingError extends Error {
  public constructor(shell: RunCommandShell, stream: RunCommandOutputStream) {
    super(
      `run_command ${stream} from ${shell} is not valid UTF-8 text. Configure the command to emit UTF-8 and retry.`
    )
    this.name = 'RunCommandEncodingError'
  }
}

export class RunCommandJobManager implements RunCommandJobService {
  private readonly jobs = new Map<string, ManagedRunCommandJob>()
  private nextId = 1
  private accepting = true
  private readonly options: ResolvedRunCommandJobManagerOptions

  public constructor(options: RunCommandJobManagerOptions = {}) {
    this.options = {
      maxOutputBufferBytes:
        options.maxOutputBufferBytes ?? MAX_OUTPUT_BUFFER_BYTES,
      terminationGraceMs: options.terminationGraceMs ?? TERMINATION_GRACE_MS,
      terminationSettleTimeoutMs:
        options.terminationSettleTimeoutMs ?? TERMINATION_SETTLE_TIMEOUT_MS,
    }
  }

  public start(
    input: RunCommandInput,
    onProgress?: (event: RunCommandProgressEvent) => void
  ): RunCommandJobHandle {
    if (!this.accepting) {
      throw new Error(
        'run_command is unavailable while portal is shutting down.'
      )
    }

    const id = `job-${this.nextId}`
    this.nextId += 1
    const job = new ManagedRunCommandJob(id, input, this.options, onProgress)
    this.jobs.set(id, job)
    void job.completion
      .catch(() => {})
      .finally(() => {
        if (this.jobs.get(id) === job) {
          this.jobs.delete(id)
        }
      })

    return {
      id,
      wait: async (signal) => await job.wait(signal),
    }
  }

  public list(): RunCommandJobSnapshot[] {
    return [...this.jobs.values()]
      .map((job) => job.snapshot())
      .sort((left, right) => left.startedAt - right.startedAt)
  }

  public async stop(id: string): Promise<RunCommandStopResult> {
    const job = this.jobs.get(id)
    if (job === undefined) {
      return 'not_found'
    }
    return await job.stop('user')
  }

  public beginShutdown(): void {
    this.accepting = false
  }

  public async stopAll(): Promise<void> {
    this.beginShutdown()
    await Promise.allSettled(
      [...this.jobs.values()].map(async (job) => {
        await job.stop('shutdown')
      })
    )
  }
}

class ManagedRunCommandJob {
  public readonly completion: Promise<RunCommandResult>

  private readonly child: ChildProcess
  private readonly startedAt = Date.now()
  private readonly cwd: string
  private readonly shell: RunCommandShell
  private readonly command: string
  private readonly stdoutChunks: Buffer[] = []
  private readonly stderrChunks: Buffer[] = []
  private readonly outputState = { size: 0, truncated: false }
  private readonly stdoutState = { truncated: false }
  private readonly stderrState = { truncated: false }
  private readonly stdoutDecoder = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  })
  private readonly stderrDecoder = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  })
  private readonly progressReporters = new Set<
    (event: RunCommandProgressEvent) => void
  >()
  private readonly platform = os.platform()
  private processJob: number | null = null
  private timeout: ReturnType<typeof setTimeout> | null = null
  private terminationPromise: Promise<void> | null = null
  private terminationReason: RunCommandTerminationReason = null
  private encodingError: RunCommandEncodingError | null = null
  private stdoutDecoderFailed = false
  private stderrDecoderFailed = false
  private settled = false
  private resolveCompletion!: (result: RunCommandResult) => void
  private rejectCompletion!: (error: unknown) => void

  public constructor(
    private readonly id: string,
    input: RunCommandInput,
    private readonly options: ResolvedRunCommandJobManagerOptions,
    onProgress?: (event: RunCommandProgressEvent) => void
  ) {
    this.command = input.command
    this.cwd = input.cwd ?? process.cwd()
    this.shell = input.shell ?? getDefaultShell()
    if (onProgress !== undefined) {
      this.progressReporters.add(onProgress)
    }

    this.completion = new Promise<RunCommandResult>((resolve, reject) => {
      this.resolveCompletion = resolve
      this.rejectCompletion = reject
    })

    const shellCommand = getShellCommand(this.shell, input.command)
    this.child = spawn(shellCommand.file, shellCommand.args, {
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      windowsHide: true,
      detached: this.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.attachWindowsJob()
    this.attachProcessEvents()
    this.report({ type: 'start', startedAt: this.startedAt })

    if (typeof input.timeoutMs === 'number') {
      const timeoutMs = Math.max(1, Math.trunc(input.timeoutMs))
      this.timeout = setTimeout(() => {
        void this.requestTermination('timeout')
      }, timeoutMs)
    }
  }

  public snapshot(): RunCommandJobSnapshot {
    return {
      id: this.id,
      pid: this.child.pid ?? null,
      command: this.command,
      cwd: this.cwd,
      shell: this.shell,
      startedAt: this.startedAt,
      state:
        this.terminationReason === null && !this.settled
          ? 'running'
          : 'stopping',
    }
  }

  public async wait(signal?: AbortSignal): Promise<RunCommandResult> {
    throwIfAborted(signal)

    return await new Promise<RunCommandResult>((resolve, reject) => {
      let waiterSettled = false
      const settle = (callback: () => void) => {
        if (waiterSettled) {
          return
        }
        waiterSettled = true
        signal?.removeEventListener('abort', onAbort)
        this.progressReporters.clear()
        callback()
      }
      const onAbort = () => {
        let reason: unknown = new PortalAbortError('Operation aborted.')
        try {
          throwIfAborted(signal)
        } catch (error) {
          reason = error
        }
        settle(() => reject(reason))
      }

      this.completion.then(
        (result) => settle(() => resolve(result)),
        (error) => settle(() => reject(error))
      )
      if (signal?.aborted === true) {
        onAbort()
      } else {
        signal?.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  public async stop(
    reason: Exclude<
      RunCommandTerminationReason,
      'timeout' | 'encoding_error' | null
    >
  ): Promise<RunCommandStopResult> {
    if (this.settled) {
      await waitForSettlement(
        this.completion,
        this.options.terminationSettleTimeoutMs
      )
      return 'not_found'
    }
    await this.requestTermination(reason)
    return (await waitForSettlement(
      this.completion,
      this.options.terminationSettleTimeoutMs
    ))
      ? 'stopped'
      : 'timeout'
  }

  private attachWindowsJob(): void {
    if (this.platform !== 'win32' || this.child.pid === undefined) {
      return
    }

    let job: number | null = null
    try {
      job = createJob()
      if (job !== null && assignPidToJob(job, this.child.pid)) {
        this.processJob = job
        job = null
      }
    } catch {
      // taskkill is used if the Job Object cannot be created or assigned.
    } finally {
      if (job !== null) {
        try {
          closeJob(job)
        } catch {
          // The process-tree fallback remains available.
        }
      }
    }
  }

  private attachProcessEvents(): void {
    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.handleOutput('stdout', chunk)
    })
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.handleOutput('stderr', chunk)
    })
    this.child.on('error', (error) => {
      this.handleOutput('stderr', Buffer.from(String(error)))
      void this.finish(null)
    })
    this.child.on('close', (code) => {
      void this.finish(code)
    })
  }

  private handleOutput(stream: RunCommandOutputStream, chunk: Buffer): void {
    const chunks = stream === 'stdout' ? this.stdoutChunks : this.stderrChunks
    const streamState =
      stream === 'stdout' ? this.stdoutState : this.stderrState
    appendBounded(
      chunks,
      chunk,
      this.outputState,
      streamState,
      this.options.maxOutputBufferBytes
    )

    const decoderFailed =
      stream === 'stdout' ? this.stdoutDecoderFailed : this.stderrDecoderFailed
    if (decoderFailed) {
      return
    }

    const decoder =
      stream === 'stdout' ? this.stdoutDecoder : this.stderrDecoder
    try {
      const text = decoder.decode(chunk, { stream: true })
      if (text) {
        this.report({ type: 'output', stream, text })
      }
    } catch {
      if (stream === 'stdout') {
        this.stdoutDecoderFailed = true
      } else {
        this.stderrDecoderFailed = true
      }
      this.encodingError ??= new RunCommandEncodingError(this.shell, stream)
      void this.requestTermination('encoding_error')
    }
  }

  private async finish(exitCode: number | null): Promise<void> {
    if (this.settled) {
      return
    }
    this.settled = true
    if (this.timeout !== null) {
      clearTimeout(this.timeout)
      this.timeout = null
    }

    this.flushDecoder('stdout')
    this.flushDecoder('stderr')
    await this.cleanupProcessTreeAfterRootExit()

    if (this.encodingError !== null) {
      this.rejectCompletion(this.encodingError)
      return
    }

    try {
      this.resolveCompletion({
        command: this.command,
        cwd: this.cwd,
        shell: this.shell,
        exitCode,
        stdout: decodeUtf8Output(
          this.stdoutChunks,
          this.shell,
          'stdout',
          this.stdoutState.truncated
        ),
        stderr: decodeUtf8Output(
          this.stderrChunks,
          this.shell,
          'stderr',
          this.stderrState.truncated
        ),
        timedOut: this.terminationReason === 'timeout',
        truncated: this.outputState.truncated,
        terminationReason: this.terminationReason,
      })
    } catch (error) {
      this.rejectCompletion(error)
    }
  }

  private flushDecoder(stream: RunCommandOutputStream): void {
    const failed =
      stream === 'stdout' ? this.stdoutDecoderFailed : this.stderrDecoderFailed
    if (failed) {
      return
    }
    const decoder =
      stream === 'stdout' ? this.stdoutDecoder : this.stderrDecoder
    try {
      const text = decoder.decode()
      if (text) {
        this.report({ type: 'output', stream, text })
      }
    } catch {
      this.encodingError ??= new RunCommandEncodingError(this.shell, stream)
    }
  }

  private async requestTermination(
    reason: Exclude<RunCommandTerminationReason, null>
  ): Promise<void> {
    if (this.settled) {
      return
    }
    if (this.terminationReason === null) {
      this.terminationReason = reason
    }
    this.terminationPromise ??= this.terminateProcessTree()
    await this.terminationPromise
  }

  private async terminateProcessTree(): Promise<void> {
    if (this.processJob !== null) {
      const job = this.processJob
      this.processJob = null
      try {
        closeJob(job)
      } catch {
        if (this.platform === 'win32' && this.child.pid !== undefined) {
          await terminateWindowsProcessTree(
            this.child.pid,
            this.options.terminationSettleTimeoutMs
          )
        }
      }
    } else if (this.platform === 'win32' && this.child.pid !== undefined) {
      await terminateWindowsProcessTree(
        this.child.pid,
        this.options.terminationSettleTimeoutMs
      )
    } else if (this.child.pid !== undefined) {
      await terminatePosixProcessGroup(
        this.child.pid,
        this.options.terminationGraceMs,
        this.options.terminationSettleTimeoutMs
      )
    }

    if (!this.child.killed) {
      try {
        this.child.kill()
      } catch {
        // The root process may already have exited.
      }
    }
  }

  private async cleanupProcessTreeAfterRootExit(): Promise<void> {
    if (this.terminationPromise !== null) {
      await this.terminationPromise
      return
    }
    if (this.processJob !== null) {
      const job = this.processJob
      this.processJob = null
      try {
        closeJob(job)
      } catch {
        // The root process has already exited; no further fallback is reliable.
      }
      return
    }
    if (this.platform !== 'win32' && this.child.pid !== undefined) {
      await terminatePosixProcessGroup(
        this.child.pid,
        this.options.terminationGraceMs,
        this.options.terminationSettleTimeoutMs
      )
    }
  }

  private report(event: RunCommandProgressEvent): void {
    for (const reporter of this.progressReporters) {
      try {
        reporter(event)
      } catch {
        // Progress is display-only and must not change command execution.
      }
    }
  }
}

function getDefaultShell(): RunCommandShell {
  return os.platform() === 'win32' ? 'powershell' : 'bash'
}

function buildPowerShellUtf8Command(command: string): string {
  const commandWithStatus = `${command}\n$global:__portalRunCommandSucceeded = $?`
  const encodedCommand = Buffer.from(commandWithStatus, 'utf16le').toString(
    'base64'
  )

  return [
    '$__portalUtf8Encoding = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding = $__portalUtf8Encoding',
    '[Console]::InputEncoding = $__portalUtf8Encoding',
    '$OutputEncoding = $__portalUtf8Encoding',
    "$PSDefaultParameterValues['*:Encoding'] = 'utf8'",
    '$global:__portalRunCommandSucceeded = $true',
    `$__portalEncodedCommand = '${encodedCommand}'`,
    '$__portalCommand = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($__portalEncodedCommand))',
    '& ([ScriptBlock]::Create($__portalCommand))',
    'if (-not $global:__portalRunCommandSucceeded) { exit 1 }',
  ].join('; ')
}

function getShellCommand(shell: RunCommandShell, command: string) {
  switch (shell) {
    case 'powershell':
      return {
        file: 'powershell.exe',
        args: [
          '-NoLogo',
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          buildPowerShellUtf8Command(command),
        ],
      }
    case 'cmd':
      return {
        file: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', command],
      }
    case 'bash':
      return {
        file: process.env.SHELL || '/bin/bash',
        args: ['-lc', command],
      }
    case 'sh':
      return {
        file: '/bin/sh',
        args: ['-c', command],
      }
  }
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  state: { size: number; truncated: boolean },
  streamState: { truncated: boolean },
  maxOutputBufferBytes: number
): void {
  if (state.size >= maxOutputBufferBytes) {
    state.truncated = true
    streamState.truncated = true
    return
  }

  const remaining = maxOutputBufferBytes - state.size
  if (chunk.length > remaining) {
    chunks.push(chunk.subarray(0, remaining))
    state.size += remaining
    state.truncated = true
    streamState.truncated = true
    return
  }

  chunks.push(chunk)
  state.size += chunk.length
}

function decodeUtf8Output(
  chunks: Buffer[],
  shell: RunCommandShell,
  stream: RunCommandOutputStream,
  truncated: boolean
): string {
  try {
    const decoder = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    })
    return decoder.decode(Buffer.concat(chunks), { stream: truncated })
  } catch {
    throw new RunCommandEncodingError(shell, stream)
  }
}

async function terminateWindowsProcessTree(
  pid: number,
  timeoutMs: number
): Promise<void> {
  await new Promise<void>((resolve) => {
    execFile(
      'taskkill.exe',
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: timeoutMs },
      () => resolve()
    )
  })
}

async function terminatePosixProcessGroup(
  pid: number,
  graceMs: number,
  settleTimeoutMs: number
): Promise<void> {
  if (!processGroupExists(pid)) {
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    return
  }
  await delay(graceMs)
  if (!processGroupExists(pid)) {
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    return
  }
  const deadline = Date.now() + settleTimeoutMs
  while (processGroupExists(pid) && Date.now() < deadline) {
    await delay(25)
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitForSettlement(
  promise: Promise<unknown>,
  timeoutMs: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}
