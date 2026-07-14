import os from 'os'
import { spawn } from 'child_process'
import {
  PortalAbortError,
  throwIfAborted,
} from '../../runtime/runtime-cancellation.ts'
import {
  assignPidToJob,
  closeJob,
  createJob,
} from '../../platform/win32-process-job.ts'
import { Tool, defineToolMetadata } from '../core/tool-definition.ts'
import type {
  ToolExecutionOptions,
  ToolOutput,
  ToolProgressEvent,
} from '../core/tool-definition.ts'

type RunCommandShell = 'powershell' | 'cmd' | 'bash' | 'sh'
type RunCommandOutputStream = 'stdout' | 'stderr'

interface RunCommandInput {
  command: string
  cwd?: string
  timeoutMs?: number
  shell?: RunCommandShell
}

interface RunCommandResult {
  command: string
  cwd: string
  shell: string
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
}

const MAX_OUTPUT_BUFFER_BYTES = 1024 * 1024 * 4

class RunCommandEncodingError extends Error {
  public constructor(shell: RunCommandShell, stream: RunCommandOutputStream) {
    super(
      `run_command ${stream} from ${shell} is not valid UTF-8 text. Configure the command to emit UTF-8 and retry.`
    )
    this.name = 'RunCommandEncodingError'
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

function formatDisplayResult(result: RunCommandResult): string {
  const lines = [
    `exitCode: ${String(result.exitCode)}`,
    `timedOut: ${result.timedOut ? 'yes' : 'no'} · truncated: ${result.truncated ? 'yes' : 'no'}`,
  ]
  const stderrLine = result.stderr
    .split(/\r?\n/)
    .find((line) => line.trim() !== '')
  if (stderrLine !== undefined) {
    lines.push(`stderr: ${stderrLine}`)
  }
  return lines.join('\n')
}

@defineToolMetadata({
  name: 'run_command',
  description: [
    'Execute a local shell command and return structured stdout, stderr, exit code, and timeout information.',
    '',
    'Prefer run_command for local file, directory, and project inspection.',
    'Use run_command for shell inspection, verification, builds, tests, and other command-line tasks.',
    'On Windows, the default shell is PowerShell.',
    'Command stdout and stderr must be valid UTF-8 text; non-UTF-8 output is rejected.',
    'Windows PowerShell uses UTF-8 settings scoped only to the spawned process.',
    '',
    'Common Windows PowerShell templates:',
    '- Read a file: Get-Content -LiteralPath "C:\\path\\file.txt" -Encoding UTF8 -TotalCount 200',
    '- Read a line range: $lines = Get-Content -LiteralPath "C:\\path\\file.txt" -Encoding UTF8; $lines[99..149]',
    '- List a directory: Get-ChildItem -LiteralPath "C:\\path" | Select-Object Mode,Length,LastWriteTime,Name',
    '- List recursively: Get-ChildItem -LiteralPath "C:\\path" -Recurse -Depth 2 | Select-Object FullName',
    '- Find files: Get-ChildItem -LiteralPath "C:\\path" -Recurse -Filter "*.ts" | Select-Object -ExpandProperty FullName',
    '- Search text with ripgrep: rg -n --hidden --glob "!node_modules" "pattern" "C:\\path"',
    '',
    'Keep command output bounded. Use Select-Object -First, -TotalCount, rg -m, or targeted paths when possible.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command to execute' },
      cwd: {
        type: 'string',
        description: 'Optional working directory for the command',
      },
      timeoutMs: {
        type: 'number',
        description:
          'Optional timeout in milliseconds. When omitted, the command has no timeout.',
      },
      shell: {
        type: 'string',
        enum: ['powershell', 'cmd', 'bash', 'sh'],
        description:
          'Optional shell to use. Defaults to powershell on Windows and bash elsewhere.',
      },
    },
    required: ['command'],
  },
  examples: [
    {
      params: {
        command:
          'Get-Content -LiteralPath "C:\\Users\\XXX\\portal\\package.json" -Encoding UTF8 -TotalCount 120',
        shell: 'powershell',
      },
    },
  ],
})
class RunCommandTool extends Tool<RunCommandInput, ToolOutput> {
  public async call(
    input: RunCommandInput,
    options: ToolExecutionOptions = {}
  ): Promise<ToolOutput> {
    throwIfAborted(options.signal)
    const timeoutMs =
      typeof input.timeoutMs === 'number'
        ? Math.max(1, Math.trunc(input.timeoutMs))
        : undefined
    const shell = input.shell ?? getDefaultShell()
    const shellCommand = getShellCommand(shell, input.command)
    reportProgress(options.onProgress, {
      type: 'start',
      startedAt: Date.now(),
    })

    let result: RunCommandResult
    try {
      result = await startRunCommandJob({
        command: input.command,
        cwd: input.cwd,
        shell,
        shellCommand,
        timeoutMs,
        signal: options.signal,
        onProgress: options.onProgress,
      })
    } catch (error) {
      if (error instanceof RunCommandEncodingError) {
        return `[ERROR] ${error.message}`
      }
      throw error
    }

    return {
      result: { ...result },
      outcome:
        result.exitCode === 0 && result.timedOut === false
          ? 'success'
          : 'error',
      displayText: formatDisplayResult(result),
    }
  }
}

function reportProgress(
  reporter: ToolExecutionOptions['onProgress'],
  event: ToolProgressEvent
): void {
  try {
    reporter?.(event)
  } catch {
    // Progress is display-only and must not change command execution.
  }
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  state: { size: number; truncated: boolean },
  streamState: { truncated: boolean }
): void {
  if (state.size >= MAX_OUTPUT_BUFFER_BYTES) {
    state.truncated = true
    streamState.truncated = true
    return
  }

  const remaining = MAX_OUTPUT_BUFFER_BYTES - state.size
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

function startRunCommandJob({
  command,
  cwd,
  shell,
  shellCommand,
  timeoutMs,
  signal,
  onProgress,
}: {
  command: string
  cwd: string | undefined
  shell: RunCommandShell
  shellCommand: ReturnType<typeof getShellCommand>
  timeoutMs: number | undefined
  signal: AbortSignal | undefined
  onProgress: ToolExecutionOptions['onProgress']
}): Promise<RunCommandResult> {
  throwIfAborted(signal)

  return new Promise<RunCommandResult>((resolve, reject) => {
    const child = spawn(shellCommand.file, shellCommand.args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const outputState = { size: 0, truncated: false }
    const stdoutState = { truncated: false }
    const stderrState = { truncated: false }
    const stdoutDecoder = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    })
    const stderrDecoder = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    })
    let timedOut = false
    let settled = false
    let processJob: number | null = null

    if (child.pid !== undefined) {
      let job: number | null = null
      try {
        job = createJob()
        if (job !== null) {
          if (assignPidToJob(job, child.pid)) {
            processJob = job
            job = null
          } else {
            try {
              closeJob(job)
            } catch {
              // Fall back to child.kill when Job Object assignment is unavailable.
            }
            job = null
          }
        }
      } catch {
        if (job !== null) {
          try {
            closeJob(job)
          } catch {
            // Ignore cleanup failures; the child kill fallback still applies.
          }
        }
        processJob = null
      }
    }

    const closeProcessJob = () => {
      if (processJob === null) {
        return
      }
      const job = processJob
      processJob = null
      try {
        closeJob(job)
      } catch {
        // child.kill below remains the fallback when the handle cannot close.
      }
    }

    const terminateChild = () => {
      closeProcessJob()
      if (!child.killed) {
        child.kill()
      }
    }

    const timeout =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            terminateChild()
          }, timeoutMs)

    const cleanup = () => {
      if (timeout !== undefined) {
        clearTimeout(timeout)
      }
      signal?.removeEventListener('abort', onAbort)
    }

    const fail = (error: unknown) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      terminateChild()
      reject(error)
    }

    const onAbort = () => {
      let reason: unknown = new PortalAbortError('Operation aborted.')
      try {
        throwIfAborted(signal)
      } catch (error) {
        reason = error
      }
      fail(reason)
    }

    const handleOutput = (stream: RunCommandOutputStream, chunk: Buffer) => {
      if (settled) {
        return
      }
      const chunks = stream === 'stdout' ? stdoutChunks : stderrChunks
      const streamState = stream === 'stdout' ? stdoutState : stderrState
      const decoder = stream === 'stdout' ? stdoutDecoder : stderrDecoder

      appendBounded(chunks, chunk, outputState, streamState)
      try {
        const text = decoder.decode(chunk, { stream: true })
        if (text) {
          reportProgress(onProgress, { type: 'output', stream, text })
        }
      } catch {
        fail(new RunCommandEncodingError(shell, stream))
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      handleOutput('stdout', chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      handleOutput('stderr', chunk)
    })

    const finish = (exitCode: number | null) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      try {
        let finalStdout: string
        try {
          finalStdout = stdoutDecoder.decode()
        } catch {
          throw new RunCommandEncodingError(shell, 'stdout')
        }
        if (finalStdout) {
          reportProgress(onProgress, {
            type: 'output',
            stream: 'stdout',
            text: finalStdout,
          })
        }
        let finalStderr: string
        try {
          finalStderr = stderrDecoder.decode()
        } catch {
          throw new RunCommandEncodingError(shell, 'stderr')
        }
        if (finalStderr) {
          reportProgress(onProgress, {
            type: 'output',
            stream: 'stderr',
            text: finalStderr,
          })
        }
        closeProcessJob()
        resolve({
          command,
          cwd: cwd ?? process.cwd(),
          shell,
          exitCode,
          stdout: decodeUtf8Output(
            stdoutChunks,
            shell,
            'stdout',
            stdoutState.truncated
          ),
          stderr: decodeUtf8Output(
            stderrChunks,
            shell,
            'stderr',
            stderrState.truncated
          ),
          timedOut,
          truncated: outputState.truncated,
        })
      } catch (error) {
        terminateChild()
        reject(error)
      }
    }

    if (signal?.aborted === true) {
      onAbort()
    } else {
      signal?.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', (error) => {
      handleOutput('stderr', Buffer.from(String(error)))
      finish(null)
    })
    child.on('close', (code) => {
      finish(code)
    })
  })
}

export { RunCommandTool }
