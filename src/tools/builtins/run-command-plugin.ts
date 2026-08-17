import { z } from 'zod'

import type {
  ExtensionDescriptor,
  ExtensionModule,
  ExtensionRegistrationApi,
} from '../../extensions/extension-contracts.ts'
import type { PortalExtensionRegistration } from '../../extensions/portal-hooks.ts'
import { portalBeforeStopHook } from '../../extensions/portal-hooks.ts'
import {
  commandJobService,
  commandOutputService,
  type CommandJobService,
  type CommandOutputService,
} from '../../cli-commands/core/command-services.ts'
import type {
  CommandContribution,
  CommandExecutionContext,
  CommandResult,
  PreparedCommandInvocation,
} from '../../cli-commands/core/command-contracts.ts'
import {
  commandContributions,
  commandHandlerBindings,
} from '../../cli-commands/core/command-plan.ts'
import {
  RunCommandEncodingError,
  RunCommandJobManager,
  type RunCommandInput,
  type RunCommandJobService,
  type RunCommandResult,
} from '../../processes/run-command-job-manager.ts'
import {
  getDefaultShell,
  getSupportedShells,
} from '../../platform/platform-defaults.ts'
import { throwIfAborted } from '../../runtime/runtime-cancellation.ts'
import {
  toolContributions,
  toolHandlerBindings,
  type ToolHandlerContext,
  type ToolResult,
} from '../tool-host.ts'
import {
  surfaceFeatureActivationBindings,
  surfaceFeatureContributions,
} from '../../surfaces/surface-extension.ts'
import {
  MCP_JOB_MANAGEMENT_FEATURE_ID,
  MCP_SURFACE_ID,
  type McpJobManagementFeature,
} from '../../mcp-server/mcp-surface-contracts.ts'

const RUN_COMMAND_ID = 'portal.tool.run-command'
const RUN_COMMAND_HANDLER_ID = `${RUN_COMMAND_ID}.handler`
const RUN_COMMAND_COMMAND_ID = `${RUN_COMMAND_ID}.command`
const RUN_COMMAND_COMMAND_HANDLER_ID = `${RUN_COMMAND_COMMAND_ID}.handler`
const RUN_COMMAND_BEFORE_STOP_HANDLER_ID = `${RUN_COMMAND_ID}.before-stop`
const RUN_COMMAND_MCP_FEATURE_ACTIVATOR_ID = `${MCP_JOB_MANAGEMENT_FEATURE_ID}.activator`
const COMMAND_CAPABILITIES = Object.freeze([
  'portal.command.job.read',
  'portal.command.job.manage',
])
const CONTINUE: CommandResult = Object.freeze({ disposition: 'continue' })

const supportedShells = getSupportedShells()
const defaultShell = getDefaultShell()
const runCommandInput = z
  .object({
    command: z.string().min(1),
    cwd: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    shell: z.enum(supportedShells).optional(),
  })
  .strict()

export const runCommandContribution = Object.freeze({
  id: RUN_COMMAND_ID,
  descriptor: Object.freeze({
    name: 'run_command',
    description: 'Run a shell command and return its output and status.',
    inputFormat: 'json' as const,
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        command: Object.freeze({
          type: 'string',
          description: 'Command to execute',
        }),
        cwd: Object.freeze({
          type: 'string',
          description: 'Optional working directory for the command',
        }),
        timeoutMs: Object.freeze({
          type: 'number',
          description:
            'Optional timeout in milliseconds. When omitted, the command has no timeout.',
        }),
        shell: Object.freeze({
          type: 'string',
          enum: Object.freeze([...supportedShells]),
          description: `Optional shell to use. Defaults to ${defaultShell}.`,
        }),
      }),
      required: Object.freeze(['command']),
    }),
  }),
  requiredCapabilities: Object.freeze([]),
  handlerBindingId: RUN_COMMAND_HANDLER_ID,
})

export const runCommandDescriptor: ExtensionDescriptor = Object.freeze({
  id: RUN_COMMAND_ID,
  version: '1.0.0',
  dependencies: Object.freeze(['portal.commands']),
  capabilities: COMMAND_CAPABILITIES,
})

const runCommandCommand: CommandContribution = Object.freeze({
  id: RUN_COMMAND_COMMAND_ID,
  primaryName: '/job',
  aliases: Object.freeze([]),
  usage: '/job [stop <job-id>]',
  description: 'List or stop running command jobs.',
  routes: Object.freeze([
    Object.freeze({
      id: 'root',
      path: Object.freeze([]),
      availability: 'always',
      positionals: Object.freeze([]),
      options: Object.freeze([]),
      constraints: Object.freeze([]),
      help: Object.freeze([
        Object.freeze({
          usage: '[stop <job-id>]',
          description: 'List or stop running command jobs.',
        }),
      ]),
    }),
    Object.freeze({
      id: 'stop',
      path: Object.freeze(['stop']),
      availability: 'always',
      positionals: Object.freeze([
        Object.freeze({ name: 'job-id', cardinality: 'required' }),
      ]),
      options: Object.freeze([]),
      constraints: Object.freeze([]),
      help: Object.freeze([
        Object.freeze({
          usage: 'stop <job-id>',
          description: 'Stop a running command job.',
        }),
      ]),
    }),
  ]),
})

export interface RunCommandPluginOptions {
  readonly jobService?: RunCommandJobService
  readonly commandService?: CommandJobService
}

/** The run_command package owns process, Tool, Command, and job lifecycle. */
export class RunCommandPlugin {
  readonly #jobs: RunCommandJobService
  readonly #commandJobs: CommandJobService
  #closePromise: Promise<void> | null = null

  public constructor(options: RunCommandPluginOptions = {}) {
    this.#jobs = options.jobService ?? new RunCommandJobManager()
    this.#commandJobs =
      options.commandService ?? createCommandJobService(this.#jobs)
  }

  public get jobService(): RunCommandJobService {
    return this.#jobs
  }

  public get registration(): PortalExtensionRegistration {
    const module: ExtensionModule = Object.freeze({
      register: (api: ExtensionRegistrationApi): void => {
        api.provide(commandJobService, {
          dependencies: Object.freeze([]),
          create: async (context) => {
            context.scope.defer('run_command jobs', async () => {
              await this.#startClose()
            })
            return this.#commandJobs
          },
        })
        api.contribute(toolContributions, {
          id: runCommandContribution.id,
          value: runCommandContribution,
          requiredServices: Object.freeze([]),
          requiredCapabilities: Object.freeze([]),
        })
        api.bind(toolHandlerBindings, {
          id: runCommandContribution.handlerBindingId,
          targetId: runCommandContribution.id,
          binding: async (input, context) =>
            await executeRunCommand(this.#jobs, input, context),
        })
        api.contribute(commandContributions, {
          id: runCommandCommand.id,
          value: runCommandCommand,
          requiredServices: Object.freeze([
            commandOutputService,
            commandJobService,
          ]),
          requiredCapabilities: COMMAND_CAPABILITIES,
        })
        api.bind(commandHandlerBindings, {
          id: RUN_COMMAND_COMMAND_HANDLER_ID,
          targetId: runCommandCommand.id,
          binding: runCommandCommandHandler,
        })
        api.contribute(surfaceFeatureContributions, {
          id: MCP_JOB_MANAGEMENT_FEATURE_ID,
          value: Object.freeze({
            id: MCP_JOB_MANAGEMENT_FEATURE_ID,
            targetSurfaceId: MCP_SURFACE_ID,
            activationBindingId: RUN_COMMAND_MCP_FEATURE_ACTIVATOR_ID,
          }),
          requiredServices: Object.freeze([commandJobService]),
          requiredCapabilities: Object.freeze([]),
        })
        api.bind(surfaceFeatureActivationBindings, {
          id: RUN_COMMAND_MCP_FEATURE_ACTIVATOR_ID,
          targetId: MCP_JOB_MANAGEMENT_FEATURE_ID,
          binding: async (context): Promise<McpJobManagementFeature> =>
            await context.services.get(commandJobService),
        })
        api.handle(portalBeforeStopHook, {
          id: RUN_COMMAND_BEFORE_STOP_HANDLER_ID,
          handler: async () => {
            await this.#startClose()
          },
          requiredServices: Object.freeze([]),
          requiredCapabilities: Object.freeze([]),
        })
      },
    })
    return Object.freeze({ descriptor: runCommandDescriptor, module })
  }

  public beginShutdown(): void {
    void this.#startClose().catch(() => undefined)
  }

  public async close(): Promise<void> {
    await this.#startClose()
  }

  #startClose(): Promise<void> {
    this.#closePromise ??= this.#jobs.stopAll()
    return this.#closePromise
  }
}

export async function executeRunCommand(
  jobs: RunCommandJobService,
  input: Record<string, unknown> | string,
  context: ToolHandlerContext
): Promise<ToolResult> {
  let parsed: RunCommandInput
  try {
    const raw = runCommandInput.parse(input)
    parsed = {
      command: raw.command,
      ...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
      ...(raw.timeoutMs === undefined ? {} : { timeoutMs: raw.timeoutMs }),
      ...(raw.shell === undefined ? {} : { shell: raw.shell }),
    }
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error))
  }
  try {
    const job = jobs.start(parsed, context.onProgress)
    let stopPromise: Promise<unknown> | null = null
    const stopOnAbort = () => {
      stopPromise ??= jobs.stop(job.id)
    }
    if (context.signal.aborted) stopOnAbort()
    else context.signal.addEventListener('abort', stopOnAbort, { once: true })
    let result: RunCommandResult
    try {
      result = await job.wait(context.signal)
    } finally {
      context.signal.removeEventListener('abort', stopOnAbort)
      if (context.signal.aborted) {
        await (stopPromise ?? jobs.stop(job.id))
      }
    }
    return {
      status: commandSucceeded(result) ? 'success' : 'error',
      output: { ...result },
      displayText: formatDisplayResult(result),
    }
  } catch (error) {
    if (error instanceof RunCommandEncodingError) {
      return errorResult(error.message)
    }
    throw error
  }
}

function commandSucceeded(result: RunCommandResult): boolean {
  return (
    result.exitCode === 0 &&
    result.timedOut === false &&
    result.terminationReason === null
  )
}

function formatDisplayResult(result: RunCommandResult): string {
  const lines = [
    `exitCode: ${String(result.exitCode)}`,
    `timedOut: ${result.timedOut ? 'yes' : 'no'} | truncated: ${result.truncated ? 'yes' : 'no'}`,
  ]
  if (result.terminationReason !== null) {
    lines.push(`terminated: ${result.terminationReason}`)
  }
  const stderrLine = result.stderr
    .split(/\r?\n/)
    .find((line) => line.trim() !== '')
  if (stderrLine !== undefined) lines.push(`stderr: ${stderrLine}`)
  return lines.join('\n')
}

function errorResult(message: string): ToolResult {
  return {
    status: 'error',
    output: { message },
    displayText: message,
  }
}

function createCommandJobService(
  jobs: RunCommandJobService
): CommandJobService {
  const service: CommandJobService = {
    list: () => jobs.list().map((job) => Object.freeze({ ...job })),
    stop: async (id, signal) => {
      throwIfAborted(signal)
      const result = await raceWithAbort(jobs.stop(id), signal)
      return result === 'not_found' ? 'not-found' : result
    },
  }
  return Object.freeze(service)
}

async function runCommandCommandHandler(
  invocation: Readonly<PreparedCommandInvocation>,
  context: CommandExecutionContext
): Promise<CommandResult> {
  const output = await context.services.get(commandOutputService)
  const jobs = await context.services.get(commandJobService)
  if (invocation.routeId === 'root') {
    const rows = jobs.list()
    if (rows.length === 0) {
      return write(
        output,
        'warning',
        '/job',
        'No run_command jobs are running.'
      )
    }
    return write(output, 'info', '/job', formatJobs(rows))
  }
  const id = scalar(invocation.arguments.positionals['job-id'] ?? null) ?? ''
  const result = await jobs.stop(id, context.signal)
  if (result === 'not-found') {
    return write(
      output,
      'warning',
      '/job stop',
      `Unknown or finished job: ${id}`
    )
  }
  if (result === 'timeout') {
    return write(
      output,
      'warning',
      '/job stop',
      `Timed out waiting for ${id} to stop.`
    )
  }
  return write(output, 'success', '/job stop', `Stopped ${id}.`)
}

function write(
  output: CommandOutputService,
  level: 'info' | 'success' | 'warning',
  title: string,
  body: string | readonly string[]
): CommandResult {
  output.write({ level, title, body })
  return CONTINUE
}

function scalar(value: string | readonly string[] | null): string | null {
  return typeof value === 'string' ? value : null
}

function formatJobs(
  jobs: readonly {
    id: string
    pid: number | null
    state: string
    startedAt: number
    shell: string
    cwd: string
    command: string
  }[]
): string[] {
  const now = Date.now()
  return [
    'Jobs:',
    ...jobs.flatMap((job, index) => {
      const lines = [
        `${job.id}  pid=${job.pid}  ${job.state}  ${Math.max(0, Math.floor((now - job.startedAt) / 1000))}s  ${job.shell}`,
        `  cwd: ${sanitize(job.cwd)}`,
        `  command: ${sanitize(job.command)}`,
      ]
      return index === jobs.length - 1 ? lines : [...lines, '']
    }),
  ]
}

function sanitize(value: string): string {
  const normalized = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0
      return code < 32 || (code >= 127 && code <= 159) ? ' ' : character
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized.length <= 120
    ? normalized
    : `${normalized.slice(0, 117)}...`
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  let remove = () => {}
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('run_command operation canceled.')
      )
    signal.addEventListener('abort', onAbort, { once: true })
    remove = () => signal.removeEventListener('abort', onAbort)
  })
  void operation.catch(() => undefined)
  try {
    return await Promise.race([operation, aborted])
  } finally {
    remove()
  }
}
