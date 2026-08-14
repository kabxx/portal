import {
  RunCommandEncodingError,
  type RunCommandInput,
  type RunCommandResult,
} from '../../processes/run-command-job-manager.ts'
import { throwIfAborted } from '../../runtime/runtime-cancellation.ts'
import {
  createToolError,
  Tool,
  defineToolMetadata,
} from '../core/tool-definition.ts'
import type {
  ToolExecutionOptions,
  ToolOutput,
} from '../core/tool-definition.ts'
import {
  getDefaultShell,
  getSupportedShells,
} from '../../platform/platform-defaults.ts'

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
  if (stderrLine !== undefined) {
    lines.push(`stderr: ${stderrLine}`)
  }
  return lines.join('\n')
}

const defaultShell = getDefaultShell()
const supportedShells = getSupportedShells()

@defineToolMetadata({
  name: 'run_command',
  description: 'Run a shell command and return its output and status.',
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
        enum: supportedShells,
        description: `Optional shell to use. Defaults to ${defaultShell}.`,
      },
    },
    required: ['command'],
  },
})
class RunCommandTool extends Tool<RunCommandInput, ToolOutput> {
  public async call(
    input: RunCommandInput,
    options: ToolExecutionOptions = {}
  ): Promise<ToolOutput> {
    throwIfAborted(options.signal)
    const jobs = this.services.runCommandJobs
    if (jobs === undefined) {
      throw new Error('run_command requires a shared job manager.')
    }

    let result: RunCommandResult
    try {
      const job = jobs.start(input, options.onProgress)
      result = await job.wait(options.signal)
    } catch (error) {
      if (error instanceof RunCommandEncodingError) {
        return createToolError(error.message)
      }
      throw error
    }

    return {
      result: { ...result },
      outcome:
        result.exitCode === 0 &&
        result.timedOut === false &&
        result.terminationReason === null
          ? 'success'
          : 'error',
      displayText: formatDisplayResult(result),
    }
  }
}

export { RunCommandTool }
