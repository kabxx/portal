import { Command, CommanderError } from 'commander'
import { stdin, stderr, stdout } from 'node:process'
import type { Readable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'

import { createPortalExecSession } from './portal-exec-session.ts'
import {
  ExecUsageError,
  parseExecTimeoutSeconds,
  resolveExecTask,
} from './exec-input.ts'
import type {
  ExecProgressEvent,
  PortalExecSession,
  PortalExecSessionFactory,
} from './exec-types.ts'

export const EXEC_EXIT_SUCCESS = 0
export const EXEC_EXIT_RUNTIME_ERROR = 1
export const EXEC_EXIT_USAGE = 2
export const EXEC_EXIT_TIMEOUT = 124
export const EXEC_EXIT_INTERRUPTED = 130
export const MAX_EXEC_STDIN_BYTES = 4 * 1024 * 1024

interface ExecCommandOptions {
  provider?: string
  model?: string
  option?: string
  timeout?: string
  dataDir?: string
  browserExecutablePath?: string
}

interface TextWriter {
  write(text: string): unknown
}

export interface ExecCliDependencies {
  cwd?: string
  input?: Readable & { isTTY?: boolean }
  output?: TextWriter
  errorOutput?: TextWriter
  createSession?: PortalExecSessionFactory
  addSigintListener?: (listener: () => void) => () => void
}

export async function runExecCli(
  argv: readonly string[],
  dependencies: ExecCliDependencies = {}
): Promise<number> {
  const input = dependencies.input ?? stdin
  const output = dependencies.output ?? stdout
  const errorOutput = dependencies.errorOutput ?? stderr
  const parsed = parseExecArguments(argv, output, errorOutput)
  if (typeof parsed === 'number') return parsed

  let timeoutSeconds: number | null
  try {
    timeoutSeconds = parseExecTimeoutSeconds(parsed.options.timeout)
  } catch (error) {
    writeError(errorOutput, error)
    return EXEC_EXIT_USAGE
  }

  const provider = parsed.options.provider?.trim() ?? ''
  if (provider === '') {
    writeError(
      errorOutput,
      new ExecUsageError(
        '--provider is required. Use /providers or portal plugins list to inspect enabled providers.'
      )
    )
    return EXEC_EXIT_USAGE
  }

  const controller = new AbortController()
  let interrupted = false
  let timedOut = false
  const removeSigintListener = (
    dependencies.addSigintListener ?? addProcessSigintListener
  )(() => {
    interrupted = true
    controller.abort(new Error('Interrupted.'))
  })
  const timer =
    timeoutSeconds === null
      ? null
      : setTimeout(() => {
          timedOut = true
          controller.abort(new Error('Timed out.'))
        }, timeoutSeconds * 1000)

  let session: PortalExecSession | null = null
  let exitCode = EXEC_EXIT_SUCCESS
  try {
    const stdinIsTty = input.isTTY === true
    const stdinText = stdinIsTty
      ? ''
      : await readStream(input, controller.signal)
    const task = resolveExecTask(parsed.prompt, stdinText, stdinIsTty)
    session = await (dependencies.createSession ?? createPortalExecSession)({
      cwd: dependencies.cwd ?? process.cwd(),
      ...(parsed.options.dataDir === undefined
        ? {}
        : { dataDirectory: parsed.options.dataDir }),
      ...(parsed.options.browserExecutablePath === undefined
        ? {}
        : { browserExecutablePath: parsed.options.browserExecutablePath }),
      provider,
      model: parsed.options.model ?? null,
      option: parsed.options.option ?? null,
      signal: controller.signal,
      onProgress: (event) => writeProgress(errorOutput, event),
    })
    const assistant = await session.run(task, controller.signal)
    output.write(assistant.endsWith('\n') ? assistant : `${assistant}\n`)
  } catch (error) {
    exitCode = interrupted
      ? EXEC_EXIT_INTERRUPTED
      : timedOut
        ? EXEC_EXIT_TIMEOUT
        : error instanceof ExecUsageError
          ? EXEC_EXIT_USAGE
          : EXEC_EXIT_RUNTIME_ERROR
    if (!interrupted) writeError(errorOutput, error)
  } finally {
    if (timer !== null) clearTimeout(timer)
    removeSigintListener()
    if (session !== null) {
      try {
        await session.close()
      } catch (error) {
        if (exitCode === EXEC_EXIT_SUCCESS) {
          exitCode = EXEC_EXIT_RUNTIME_ERROR
        }
        writeError(errorOutput, error)
      }
    }
  }
  return exitCode
}

function parseExecArguments(
  argv: readonly string[],
  output: TextWriter,
  errorOutput: TextWriter
): { prompt: string[]; options: ExecCommandOptions } | number {
  let prompt: string[] = []
  const program = new Command()
    .name('portal exec')
    .description('Run one Portal agent task without starting the TUI.')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => output.write(text),
      writeErr: (text) => errorOutput.write(text),
    })
    .argument('[prompt...]', 'task to send to the agent')
    .requiredOption('--provider <provider>', 'web AI provider')
    .option('--model <key>', 'provider model key')
    .option('--option <key>', 'provider model option')
    .option('--timeout <seconds>', 'hard timeout for the complete command')
    .option('--data-dir <path>', 'Portal data directory')
    .option('--browser-executable-path <path>', 'browser executable path')
    .action((value: string[] | undefined) => {
      prompt = value ?? []
    })

  try {
    program.parse(['node', 'portal exec', ...argv])
  } catch (error) {
    if (
      error instanceof CommanderError &&
      error.code === 'commander.helpDisplayed'
    ) {
      return EXEC_EXIT_SUCCESS
    }
    return EXEC_EXIT_USAGE
  }
  return { prompt, options: program.opts<ExecCommandOptions>() }
}

async function readStream(
  stream: Readable,
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted()
  const chunks: Buffer[] = []
  let totalBytes = 0
  const stopReading = () => {
    const reason =
      signal.reason instanceof Error
        ? signal.reason
        : new Error('Input reading was aborted.')
    stream.destroy(reason)
  }
  signal.addEventListener('abort', stopReading, { once: true })
  try {
    for await (const chunk of stream) {
      signal.throwIfAborted()
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      totalBytes += buffer.length
      if (totalBytes > MAX_EXEC_STDIN_BYTES) {
        stream.destroy()
        throw new ExecUsageError(
          `Piped stdin exceeds the ${MAX_EXEC_STDIN_BYTES}-byte limit.`
        )
      }
      chunks.push(buffer)
    }
    signal.throwIfAborted()
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    signal.removeEventListener('abort', stopReading)
  }
}

function writeProgress(output: TextWriter, event: ExecProgressEvent): void {
  switch (event.type) {
    case 'status':
      output.write(`${stripVTControlCharacters(event.message)}\n`)
      break
    case 'warning':
      output.write(`warning: ${stripVTControlCharacters(event.message)}\n`)
      break
    case 'tool':
      output.write(`tool: ${stripVTControlCharacters(event.name)}\n`)
      break
  }
}

function writeError(output: TextWriter, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  output.write(`error: ${stripVTControlCharacters(message)}\n`)
}

function addProcessSigintListener(listener: () => void): () => void {
  process.once('SIGINT', listener)
  return () => process.off('SIGINT', listener)
}
