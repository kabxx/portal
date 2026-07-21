import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { RunCommandTool } from '../../../src/tools/builtins/run-command-tool.ts'
import { getDefaultShell } from '../../../src/platform/platform-defaults.ts'
import { RunCommandJobManager } from '../../../src/processes/run-command-job-manager.ts'
import { PortalAbortError } from '../../../src/runtime/runtime-cancellation.ts'
import type { ToolProgressEvent } from '../../../src/tools/core/tool-definition.ts'
import { createProviderAdapterStub } from '../../helpers/fakes.ts'

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
  return new RunCommandTool(createProviderAdapterStub(), {
    runCommandJobs: new RunCommandJobManager(),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object.`)
  }
  return value
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Expected ${label} to be a string.`)
  }
  return value
}

function assertTimingMetadata(result: Record<string, unknown>): void {
  assert.equal(typeof result.durationMs, 'number')
  assert.equal(Number.isInteger(result.durationMs), true)
  assert.ok(Number(result.durationMs) >= 0)
  const finishedAt = requireString(result.finishedAt, 'finishedAt')
  assert.equal(new Date(finishedAt).toISOString(), finishedAt)
}

test('RunCommandTool does not advertise a default timeout', () => {
  const tool = createRunCommandTool()
  const schema = requireRecord(tool.metadata.inputSchema, 'input schema')
  const properties = requireRecord(schema.properties, 'schema properties')
  const timeout = requireRecord(properties.timeoutMs, 'timeout schema')

  assert.equal(timeout.default, undefined)
  assert.match(tool.prompt, /valid UTF-8 text/i)
  if (getDefaultShell() === 'powershell') {
    assert.match(tool.prompt, /-Encoding UTF8/)
    assert.match(tool.prompt, /Get-Command rg -ErrorAction SilentlyContinue/)
    assert.match(tool.prompt, /ripgrep when available/)
    assert.match(tool.prompt, /without ripgrep: Get-ChildItem.*Select-String/)
    assert.match(tool.prompt, /Select-Object -First 200/)
  } else {
    assert.doesNotMatch(tool.prompt, /Get-Content|C:\\/)
    assert.match(tool.prompt, /command -v rg >\/dev\/null 2>&1/)
    assert.match(tool.prompt, /ripgrep when available/)
    assert.match(tool.prompt, /without ripgrep: grep -R/)
    assert.match(tool.prompt, /head -n 200/)
  }
})

test('RunCommandTool requires the portal shared job manager', async () => {
  const tool = new RunCommandTool(createProviderAdapterStub())

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
    const result = output.result

    assert.equal(result.exitCode, 0)
    assert.equal(requireString(result.stdout, 'stdout').trim(), '中文测试')
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
    const result = output.result

    assert.equal(result.exitCode, 1)
    assert.match(requireString(result.stderr, 'stderr'), /中文错误/)
  }
)

test('RunCommandTool rejects non-UTF-8 stdout and stderr', async () => {
  const tool = createRunCommandTool()

  for (const stream of ['stdout', 'stderr']) {
    const command =
      os.platform() === 'win32'
        ? `[Console]::OpenStandard${stream === 'stdout' ? 'Output' : 'Error'}().WriteByte(255)`
        : `printf '\\377'${stream === 'stderr' ? ' >&2' : ''}`
    const output = await tool.call({
      command,
      shell: os.platform() === 'win32' ? 'powershell' : 'sh',
    })

    assert.equal(output.outcome, 'error')
    assert.match(
      String(output.result.message),
      new RegExp(`${stream}.*not valid UTF-8`, 'i')
    )
    assert.doesNotMatch(String(output.result.message), /�/)
  }
})

test('RunCommandTool does not register a timeout when timeoutMs is omitted', async (t) => {
  const tool = createRunCommandTool()
  const setTimeoutMock = t.mock.method(globalThis, 'setTimeout')

  try {
    const output = await tool.call({
      command: echoCommand(),
      shell: testShell(),
    })
    const result = output.result

    assert.equal(requireString(result.stdout, 'stdout').trim(), 'ok')
    assert.equal(result.timedOut, false)
    assertTimingMetadata(result)
    assert.equal(output.outcome, 'success')
    assert.match(output.displayText, /exitCode: 0/)
    assert.doesNotMatch(output.displayText, /durationMs|finishedAt/)
    assert.equal(setTimeoutMock.mock.callCount(), 0)
  } finally {
    setTimeoutMock.mock.restore()
  }
})

test('RunCommandTool marks nonzero command exits as errors', async () => {
  const tool = createRunCommandTool()
  const output = await tool.call({
    command: os.platform() === 'win32' ? 'exit /b 2' : 'exit 2',
    shell: testShell(),
  })

  assert.equal(output.outcome, 'error')
  assert.equal(output.result.exitCode, 2)
  assertTimingMetadata(output.result)
})

test('RunCommandTool registers a timeout when timeoutMs is provided', async (t) => {
  const tool = createRunCommandTool()
  const setTimeoutMock = t.mock.method(globalThis, 'setTimeout')

  try {
    const output = await tool.call({
      command: echoCommand(),
      shell: testShell(),
      timeoutMs: 1000,
    })
    const result = output.result

    assert.equal(requireString(result.stdout, 'stdout').trim(), 'ok')
    assert.equal(result.timedOut, false)
    assert.equal(setTimeoutMock.mock.callCount(), 1)
  } finally {
    setTimeoutMock.mock.restore()
  }
})

test('RunCommandTool emits start and UTF-8 stdout/stderr progress events', async () => {
  const tool = createRunCommandTool()
  const events: ToolProgressEvent[] = []
  const command =
    os.platform() === 'win32'
      ? 'echo first & echo problem 1>&2'
      : "printf 'first\\n'; printf 'problem\\n' >&2"

  await tool.call(
    { command, shell: testShell() },
    { onProgress: (event) => events.push(event) }
  )

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
  const tool = new RunCommandTool(createProviderAdapterStub(), {
    runCommandJobs: manager,
  })
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
  const tool = new RunCommandTool(createProviderAdapterStub(), {
    runCommandJobs: manager,
  })
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
    assert.equal(output.outcome, 'error')
    assert.equal(output.result.terminationReason, 'user')
    assertTimingMetadata(output.result)
  } finally {
    await manager.stopAll()
    rmSync(tempDir, { recursive: true, force: true })
  }
})
