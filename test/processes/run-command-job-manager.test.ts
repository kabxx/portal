import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { RunCommandJobManager } from '../../src/processes/run-command-job-manager.ts'

function quoteShellArg(value: string): string {
  return os.platform() === 'win32'
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'"'"'`)}'`
}

function nodeCommand(script: string): {
  command: string
  shell: 'powershell' | 'sh'
} {
  const invocation = `${quoteShellArg(process.execPath)} -e ${quoteShellArg(script)}`
  return {
    command: os.platform() === 'win32' ? `& ${invocation}` : invocation,
    shell: os.platform() === 'win32' ? 'powershell' : 'sh',
  }
}

function markerCommand(
  ready: string,
  finished?: string
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
        ...(finished === undefined
          ? []
          : [
              'Start-Sleep -Milliseconds 200',
              `Set-Content -LiteralPath ${quotePowerShell(finished)} -Value finished`,
            ]),
        'Start-Sleep -Seconds 5',
      ].join('; '),
      shell: 'powershell',
    }
  }
  return {
    command: nodeCommand(
      `const fs=require("fs");fs.writeFileSync(${JSON.stringify(ready)},"ready");${finished === undefined ? '' : `setTimeout(()=>fs.writeFileSync(${JSON.stringify(finished)},"finished"),200);`}setTimeout(()=>{},5000)`
    ).command,
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

test('RunCommandJobManager lists active jobs and removes completed jobs', async () => {
  const manager = new RunCommandJobManager()
  const input =
    os.platform() === 'win32'
      ? {
          command: 'Start-Sleep -Milliseconds 200',
          shell: 'powershell' as const,
        }
      : nodeCommand('setTimeout(()=>{},200)')
  const job = manager.start(input)

  assert.equal(job.id, 'j-1')

  assert.deepEqual(
    manager.list().map(({ id, state }) => ({ id, state })),
    [{ id: job.id, state: 'running' }]
  )

  const result = await job.wait()
  assert.equal(result.exitCode, 0)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(manager.list(), [])
})

test('RunCommandJobManager applies a configured output buffer limit', async () => {
  const manager = new RunCommandJobManager({ maxOutputBufferBytes: 16 })
  const result = await manager
    .start(nodeCommand('process.stdout.write("x".repeat(32))'))
    .wait()

  assert.ok(Buffer.byteLength(result.stdout) <= 16)
  assert.equal(result.truncated, true)
})

test('RunCommandJobManager drains bounded output after a waiter detaches', async () => {
  const manager = new RunCommandJobManager()
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'portal-job-output-'))
  const ready = path.join(tempDir, 'ready.txt')
  const finished = path.join(tempDir, 'finished.txt')
  const input =
    os.platform() === 'win32'
      ? {
          command: `Start-Sleep -Milliseconds 100; [Console]::Out.Write('x' * 5242880); Set-Content -LiteralPath '${finished.replaceAll("'", "''")}' -Value finished`,
          shell: 'powershell' as const,
        }
      : nodeCommand(
          `const fs=require("fs");fs.writeFileSync(${JSON.stringify(ready)},"ready");process.stdout.write("x".repeat(5*1024*1024));fs.writeFileSync(${JSON.stringify(finished)},"finished")`
        )
  const controller = new AbortController()

  try {
    const job = manager.start(input)
    const detachedWaiter = job.wait(controller.signal)
    if (os.platform() === 'win32') {
      await new Promise((resolve) => setTimeout(resolve, 150))
    } else {
      await waitForFile(ready)
    }
    controller.abort()
    await assert.rejects(detachedWaiter)

    const result = await job.wait()
    assert.equal(result.truncated, true)
    assert.equal(result.stdout.length, 4 * 1024 * 1024)
    assert.equal(existsSync(finished), true)
  } finally {
    await manager.stopAll()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('RunCommandJobManager timeout terminates a running job', async () => {
  const manager = new RunCommandJobManager()
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'portal-job-timeout-'))
  const ready = path.join(tempDir, 'ready.txt')

  try {
    const job = manager.start({ ...markerCommand(ready), timeoutMs: 1000 })
    await waitForFile(ready)
    const result = await job.wait()

    assert.equal(result.timedOut, true)
    assert.equal(result.terminationReason, 'timeout')
  } finally {
    await manager.stopAll()
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test(
  'RunCommandJobManager stop terminates the Windows process tree',
  { skip: os.platform() !== 'win32' },
  async () => {
    const manager = new RunCommandJobManager()
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'portal-job-tree-'))
    const childReady = path.join(tempDir, 'child-ready.txt')
    const marker = path.join(tempDir, 'child-alive.txt')
    const quotePowerShell = (value: string) =>
      `'${value.replaceAll("'", "''")}'`
    const childScript = [
      `Set-Content -LiteralPath ${quotePowerShell(childReady)} -Value ready`,
      'Start-Sleep -Milliseconds 500',
      `Set-Content -LiteralPath ${quotePowerShell(marker)} -Value alive`,
    ].join('; ')
    const command = [
      `$childScript = ${quotePowerShell(childScript)}`,
      `Start-Process -FilePath powershell.exe -ArgumentList @('-NoLogo','-NoProfile','-Command',$childScript) | Out-Null`,
      'Start-Sleep -Seconds 5',
    ].join('; ')

    try {
      const job = manager.start({ command, shell: 'powershell' })
      const completion = job.wait()
      await waitForFile(childReady)
      assert.equal(await manager.stop(job.id), 'stopped')
      const result = await completion
      assert.equal(result.terminationReason, 'user')
      await new Promise((resolve) => setTimeout(resolve, 700))
      assert.equal(existsSync(marker), false)
    } finally {
      await manager.stopAll()
      rmSync(tempDir, { recursive: true, force: true })
    }
  }
)

test(
  'RunCommandJobManager stop terminates the POSIX process group',
  { skip: os.platform() === 'win32' },
  async () => {
    const manager = new RunCommandJobManager()
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'portal-job-tree-'))
    const childReady = path.join(tempDir, 'child-ready.txt')
    const marker = path.join(tempDir, 'child-alive.txt')
    const command = [
      `(printf ready > ${quoteShellArg(childReady)}; sleep 0.5; printf alive > ${quoteShellArg(marker)}) &`,
      'sleep 5',
    ].join(' ')

    try {
      const job = manager.start({ command, shell: 'sh' })
      const completion = job.wait()
      await waitForFile(childReady)
      assert.equal(await manager.stop(job.id), 'stopped')
      const result = await completion
      assert.equal(result.terminationReason, 'user')
      await new Promise((resolve) => setTimeout(resolve, 700))
      assert.equal(existsSync(marker), false)
    } finally {
      await manager.stopAll()
      rmSync(tempDir, { recursive: true, force: true })
    }
  }
)

test('RunCommandJobManager shutdown stops jobs and rejects new starts', async () => {
  const manager = new RunCommandJobManager()
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'portal-job-shutdown-'))
  const ready = path.join(tempDir, 'ready.txt')
  const input = markerCommand(ready)

  try {
    manager.start(input)
    await waitForFile(ready)
    await manager.stopAll()

    assert.deepEqual(manager.list(), [])
    assert.throws(() => manager.start(nodeCommand('')), /shutting down/)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
