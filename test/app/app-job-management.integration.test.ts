import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import {
  createMcpHandlers,
  type McpHandlerDependencies,
} from '../../src/app/app-mcp-handlers.ts'
import { PortalMcpServer } from '../../src/mcp-server/mcp-server.ts'
import {
  RunCommandJobManager,
  type RunCommandInput,
  type RunCommandJobHandle,
  type RunCommandJobSnapshot,
} from '../../src/processes/run-command-job-manager.ts'

const TEST_TOKEN = 'integration-test-token'

test(
  'Portal MCP job tools list and stop a real run_command job',
  { timeout: 20_000 },
  async () => {
    const manager = new RunCommandJobManager()
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'portal-mcp-job-'))
    const ready = path.join(tempDir, 'ready.txt')
    const server = new PortalMcpServer({
      host: '127.0.0.1',
      port: 0,
      token: TEST_TOKEN,
      handlers: createFocusedMcpHandlers(manager),
    })
    let client: Client | null = null
    try {
      const input = longRunningCommand(ready, tempDir)
      const job = manager.start(input)
      await waitForJobReady(job, ready)
      const snapshot = requireRunningSnapshot(manager, job.id, input)

      await server.start()
      const address = server.address()
      assert.ok(address !== null)
      client = await connectMcpClient(address)

      const listed = await client.callTool({
        name: 'portal_list_jobs',
        arguments: {},
      })
      assert.deepEqual(listed.structuredContent, { jobs: [snapshot] })

      const stopped = await client.callTool({
        name: 'portal_stop_job',
        arguments: { jobId: job.id },
      })
      assert.equal(stopped.isError, undefined)
      assert.deepEqual(stopped.structuredContent, {
        stopped: true,
        jobId: job.id,
      })

      const result = await job.wait()
      assert.equal(result.terminationReason, 'user')
      await waitFor(() => manager.list().length === 0, 'job list to clear')

      const afterStop = await client.callTool({
        name: 'portal_list_jobs',
        arguments: {},
      })
      assert.deepEqual(afterStop.structuredContent, { jobs: [] })
    } finally {
      if (client !== null) {
        await client.close().catch(() => {})
      }
      await server.stop().catch(() => {})
      await manager.stopAll()
      rmSync(tempDir, { recursive: true, force: true })
    }
  }
)

function createFocusedMcpHandlers(manager: RunCommandJobManager) {
  // The job tools only exercise this dependency path.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const dependencies = {
    runCommandJobs: manager,
  } as unknown as McpHandlerDependencies
  return createMcpHandlers(dependencies)
}

function quoteShellArg(value: string): string {
  return os.platform() === 'win32'
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'"'"'`)}'`
}

function longRunningCommand(ready: string, cwd: string): RunCommandInput {
  const fixture = path.resolve('test/fixtures/run-command-ready.mjs')
  const invocation = [process.execPath, fixture, ready]
    .map(quoteShellArg)
    .join(' ')
  return {
    command: os.platform() === 'win32' ? `& ${invocation}` : invocation,
    cwd,
    shell: os.platform() === 'win32' ? 'powershell' : 'sh',
    timeoutMs: 30_000,
  }
}

function requireRunningSnapshot(
  manager: RunCommandJobManager,
  jobId: string,
  input: RunCommandInput
): RunCommandJobSnapshot {
  const snapshot = manager.list().find(({ id }) => id === jobId)
  assert.ok(snapshot !== undefined)
  assert.ok(snapshot.pid !== null && snapshot.pid > 0)
  assert.equal(snapshot.command, input.command)
  assert.equal(snapshot.cwd, input.cwd)
  assert.equal(snapshot.shell, input.shell)
  assert.equal(snapshot.state, 'running')
  assert.equal(Number.isInteger(snapshot.startedAt), true)
  return snapshot
}

async function connectMcpClient(url: string): Promise<Client> {
  const client = new Client({
    name: 'portal-job-management-integration-test',
    version: '1.0.0',
  })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    },
  })
  if (!isTransport(transport)) {
    throw new Error('MCP SDK returned an invalid test transport.')
  }
  await client.connect(transport)
  return client
}

function isTransport(value: unknown): value is Transport {
  return (
    typeof value === 'object' &&
    value !== null &&
    'start' in value &&
    typeof value.start === 'function' &&
    'send' in value &&
    typeof value.send === 'function' &&
    'close' in value &&
    typeof value.close === 'function'
  )
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function waitForJobReady(
  job: RunCommandJobHandle,
  ready: string
): Promise<void> {
  const completion = job.wait()
  const deadline = Date.now() + 10_000
  while (!existsSync(ready)) {
    const settled = await Promise.race([
      completion.then((result) => result),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20)),
    ])
    if (settled !== null) {
      throw new Error(
        `Job exited before readiness (exit ${String(settled.exitCode)}, stderr bytes ${String(Buffer.byteLength(settled.stderr))}).`
      )
    }
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for job to start.')
    }
  }
}
