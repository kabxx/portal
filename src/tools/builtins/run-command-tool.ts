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
const isWindows = defaultShell === 'powershell'

const runCommandDescription = [
  'Execute a local shell command and return structured stdout, stderr, exit code, and timeout information.',
  '',
  'Prefer run_command for local file, directory, and project inspection.',
  'Use run_command for shell inspection, verification, builds, tests, and other command-line tasks.',
  `The default shell is ${defaultShell}; available shells are ${supportedShells.join(', ')}.`,
  'Command stdout and stderr must be valid UTF-8 text; non-UTF-8 output is rejected.',
  ...(isWindows
    ? [
        'Windows PowerShell uses UTF-8 settings scoped only to the spawned process.',
      ]
    : []),
  'If the current turn is cancelled, the command keeps running as a portal job until it exits, times out, is stopped with /job stop, or portal shuts down.',
  '',
  ...(isWindows
    ? [
        'Common Windows PowerShell templates:',
        '- Read a file: Get-Content -LiteralPath "C:\\path\\file.txt" -Encoding UTF8 -TotalCount 200',
        '- Read a line range: $lines = Get-Content -LiteralPath "C:\\path\\file.txt" -Encoding UTF8; $lines[99..149]',
        '- List a directory: Get-ChildItem -LiteralPath "C:\\path" | Select-Object Mode,Length,LastWriteTime,Name',
        '- List recursively: Get-ChildItem -LiteralPath "C:\\path" -Recurse -Depth 2 | Select-Object FullName',
        '- Find files: Get-ChildItem -LiteralPath "C:\\path" -Recurse -Filter "*.ts" | Select-Object -ExpandProperty FullName',
        '- Search text with ripgrep: rg -n --hidden --glob "!node_modules" "pattern" "C:\\path"',
        '',
        'Keep command output bounded. Use Select-Object -First, -TotalCount, rg -m, or targeted paths when possible.',
      ]
    : [
        'Common POSIX shell templates:',
        '- Show the current directory: pwd',
        '- List a directory: ls -la',
        '- Find files: find . -maxdepth 2 -type f',
        '- Search text with ripgrep: rg -n --hidden --glob "!node_modules" "pattern" .',
        '',
        'Keep command output bounded. Use head, rg -m, or targeted paths when possible.',
      ]),
].join('\n')

const runCommandExample = isWindows
  ? {
      command:
        'Get-Content -LiteralPath "C:\\Users\\XXX\\portal\\package.json" -Encoding UTF8 -TotalCount 120',
      shell: 'powershell',
    }
  : {
      command: "sed -n '1,120p' package.json",
      shell: defaultShell,
    }

@defineToolMetadata({
  name: 'run_command',
  description: runCommandDescription,
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
  examples: [
    {
      params: runCommandExample,
    },
  ],
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
