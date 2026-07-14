import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { RunCommandTool } from '../../../src/tools/builtins/run-command-tool.ts'
import { RunCommandJobManager } from '../../../src/processes/run-command-job-manager.ts'
import { PortalAbortError } from '../../../src/runtime/runtime-cancellation.ts'
import type { ToolProgressEvent } from '../../../src/tools/core/tool-definition.ts'

function testShell(): 'cmd' | 'sh' {
  return os.platform() === 'win32' ? 'cmd' : 'sh'
}

function scriptShell(): 'powershell' | 'sh' {
  return os.platform() === 'win32' ? 'powershell' : 'sh'
}

function echoCommand(): string {
  return os.platform() === 'win32' ? 'echo ok' : 'printf ok'
}

function quoteShellArg(value: string): string {
  return os.platform() === 'win32'
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'"'"'`)}'`
}

function nodeCommand(script: string): string {
  const invocation = `${quoteShellArg(process.execPath)} -e ${quoteShellArg(script)}`
  return os.platform() === 'win32' ? `& ${invocation}` : invocation
}

function markerCommand(
  ready: string,
  finished: string
): {
  command: string
  shell: 'powershell' | 'sh'
} {
  if (os.platform() === 'win32') {
    const quotePowerShell = (value: string) =>
      `'${value.replaceAll("'", "''")}'`
    return {
      command: [
        `Set-Content -LiteralPath ${quotePowerShell(ready)} -Value ready`,
        'Start-Sleep -Milliseconds 200',
        `Set-Content -LiteralPath ${quotePowerShell(finished)} -Value finished`,
        'Start-Sleep -Milliseconds 800',
      ].join('; '),
      shell: 'powershell',
    }
  }
  return {
    command: nodeCommand(
      `const fs=require("fs");fs.writeFileSync(${JSON.stringify(ready)},"ready");setTimeout(()=>fs.writeFileSync(${JSON.stringify(finished)},"finished"),200);setTimeout(()=>{},1000)`
    ),
    shell: 'sh',
  }
}

async function waitForFile(filePath: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for file: ${filePath}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function windowsCodePage(): string | null {
  const result = spawnSync(
    process.env.ComSpec || 'cmd.exe',
    ['/d', '/s', '/c', 'chcp'],
    { windowsHide: true }
  )
  return result.stdout.toString('ascii').match(/\d+/)?.[0] ?? null
}

function createRunCommandTool(): RunCommandTool {
  return new RunCommandTool({} as any, {
    runCommandJobs: new RunCommandJobManager(),
  })
}

test('RunCommandTool does not advertise a default timeout', () => {
  const tool = createRunCommandTool()
  const schema = tool.metadata.inputSchema as {
    properties?: {
      timeoutMs?: {
        default?: unknown
      }
    }
  }

  assert.equal(schema.properties?.timeoutMs?.default, undefined)
  assert.match(tool.prompt, /valid UTF-8 text/i)
  assert.match(tool.prompt, /-Encoding UTF8/)
})

test('RunCommandTool requires the portal shared job manager', async () => {
  const tool = new RunCommandTool({} as any)

  await assert.rejects(
    tool.call({ command: echoCommand(), shell: testShell() }),
    /shared job manager/
  )
})

test(
  'RunCommandTool uses process-local UTF-8 for Windows PowerShell output',
  { skip: os.platform() !== 'win32' },
  async () => {
    const tool = createRunCommandTool()
    const codePageBefore = windowsCodePage()

    const output = await tool.call({
      command: "Write-Output '中文测试'",
      shell: 'powershell',
    })
    if (typeof output === 'string') assert.fail(output)
    const result = output.result as {
      exitCode: number | null
      stdout: string
      stderr: string
    }

    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout.trim(), '中文测试')
    assert.equal(result.stderr, '')
    assert.equal(windowsCodePage(), codePageBefore)
  }
)

test(
  'RunCommandTool preserves Windows PowerShell failure status and UTF-8 stderr',
  { skip: os.platform() !== 'win32' },
  async () => {
    const tool = createRunCommandTool()
    const output = await tool.call({
      command: "Write-Error '中文错误'",
      shell: 'powershell',
    })
    if (typeof output === 'string') assert.fail(output)
    const result = output.result as {
      exitCode: number | null
      stderr: string
    }

    assert.equal(result.exitCode, 1)
    assert.match(result.stderr, /中文错误/)
  }
)

test('RunCommandTool rejects non-UTF-8 stdout and stderr', async () => {
  const tool = createRunCommandTool()

  for (const stream of ['stdout', 'stderr'] as const) {
    const command =
      os.platform() === 'win32'
        ? `[Console]::OpenStandard${stream === 'stdout' ? 'Output' : 'Error'}().WriteByte(255)`
        : `printf '\\377'${stream === 'stderr' ? ' >&2' : ''}`
    const output = await tool.call({
      command,
      shell: os.platform() === 'win32' ? 'powershell' : 'sh',
    })

    assert.equal(typeof output, 'string')
    assert.match(String(output), new RegExp(`${stream}.*not valid UTF-8`, 'i'))
    assert.doesNotMatch(String(output), /�/)
  }
})

test('RunCommandTool does not register a timeout when timeoutMs is omitted', async () => {
  const tool = createRunCommandTool()
  const originalSetTimeout = globalThis.setTimeout
  let timerCount = 0

  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    timerCount += 1
    return originalSetTimeout(...args)
  }) as typeof setTimeout

  try {
    const output = await tool.call({
      command: echoCommand(),
      shell: testShell(),
    })
    if (typeof output === 'string') assert.fail('expected structured output')
    const result = output.result as {
      stdout: string
      timedOut: boolean
    }

    assert.equal(result.stdout.trim(), 'ok')
    assert.equal(result.timedOut, false)
    assert.equal(output.outcome, 'success')
    assert.match(output.displayText, /exitCode: 0/)
    assert.equal(timerCount, 0)
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
})

test('RunCommandTool marks nonzero command exits as errors', async () => {
  const tool = createRunCommandTool()
  const output = await tool.call({
    command: os.platform() === 'win32' ? 'exit /b 2' : 'exit 2',
    shell: testShell(),
  })

  if (typeof output === 'string') assert.fail(output)
  assert.equal(output.outcome, 'error')
  assert.equal(output.result.exitCode, 2)
})

test('RunCommandTool registers a timeout when timeoutMs is provided', async () => {
  const tool = createRunCommandTool()
  const originalSetTimeout = globalThis.setTimeout
  let timerCount = 0

  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    timerCount += 1
    return originalSetTimeout(...args)
  }) as typeof setTimeout

  try {
    const output = await tool.call({
      command: echoCommand(),
      shell: testShell(),
      timeoutMs: 1000,
    })
    if (typeof output === 'string') assert.fail('expected structured output')
    const result = output.result as {
      stdout: string
      timedOut: boolean
    }

    assert.equal(result.stdout.trim(), 'ok')
    assert.equal(result.timedOut, false)
    assert.equal(timerCount, 1)
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
})

test('RunCommandTool emits start and UTF-8 stdout/stderr progress events', async () => {
  const tool = createRunCommandTool()
  const events: ToolProgressEvent[] = []
  const command =
    os.platform() === 'win32'
      ? 'echo first & echo problem 1>&2'
      : "printf 'first\\n'; printf 'problem\\n' >&2"

  const output = await tool.call(
    { command, shell: testShell() },
    { onProgress: (event) => events.push(event) }
  )

  assert.equal(typeof output === 'string', false)
  assert.equal(events[0]?.type, 'start')
  const stdout = events
    .filter(
      (event): event is Extract<ToolProgressEvent, { type: 'output' }> =>
        event.type === 'output' && event.stream === 'stdout'
    )
    .map((event) => event.text)
    .join('')
  const stderr = events
    .filter(
      (event): event is Extract<ToolProgressEvent, { type: 'output' }> =>
        event.type === 'output' && event.stream === 'stderr'
    )
    .map((event) => event.text)
    .join('')

  assert.match(stdout, /first/)
  assert.match(stderr, /problem/)
})

test('RunCommandTool keeps UTF-8 code points intact across output chunks', async () => {
  const tool = createRunCommandTool()
  const outputChunks: string[] = []
  const command =
    os.platform() === 'win32'
      ? '[Console]::OpenStandardOutput().Write([byte[]](228,184),0,2); Start-Sleep -Milliseconds 20; [Console]::OpenStandardOutput().Write([byte[]](173,10),0,2)'
      : `"${process.execPath}" -e "process.stdout.write(Buffer.from([228,184]));setTimeout(()=>process.stdout.write(Buffer.from([173,10])),20)"`

  await tool.call(
    { command, shell: scriptShell() },
    {
      onProgress: (event) => {
        if (event.type === 'output' && event.stream === 'stdout') {
          outputChunks.push(event.text)
        }
      },
    }
  )

  assert.equal(outputChunks.join(''), '中\n')
})

test('RunCommandTool aborts its waiter but leaves the job running', async () => {
  const manager = new RunCommandJobManager()
  const tool = new RunCommandTool({} as any, { runCommandJobs: manager })
  const controller = new AbortController()
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'portal-run-command-'))
  const ready = path.join(tempDir, 'ready.txt')
  const finished = path.join(tempDir, 'finished.txt')

  try {
    const running = tool.call(markerCommand(ready, finished), {
      signal: controller.signal,
    })
    await waitForFile(ready)
    controller.abort(new PortalAbortError('cancel command waiter'))
    await assert.rejects(running, PortalAbortError)

    assert.equal(manager.list().length, 1)
    await waitForFile(finished)
  } finally {
    await manager.stopAll()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('RunCommandTool returns an error result when its job is stopped', async () => {
  const manager = new RunCommandJobManager()
  const tool = new RunCommandTool({} as any, { runCommandJobs: manager })
  const tempDir = mkdtempSync(
    path.join(os.tmpdir(), 'portal-run-command-stop-')
  )
  const ready = path.join(tempDir, 'ready.txt')
  const finished = path.join(tempDir, 'finished.txt')

  try {
    const running = tool.call(markerCommand(ready, finished))
    await waitForFile(ready)
    const [job] = manager.list()
    assert.ok(job)
    assert.equal(await manager.stop(job.id), 'stopped')

    const output = await running
    if (typeof output === 'string') assert.fail(output)
    assert.equal(output.outcome, 'error')
    assert.equal(
      (output.result as { terminationReason: string }).terminationReason,
      'user'
    )
  } finally {
    await manager.stopAll()
    rmSync(tempDir, { recursive: true, force: true })
  }
})
