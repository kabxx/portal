import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createApiHandlers,
  type ApiHandlerDependencies,
} from '../../src/app/app-api-handlers.ts'

test('API handler status resolves server state lazily', () => {
  let serverStatusCalls = 0
  // This focused fake implements only the status dependencies exercised here.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const dependencies = {
    threadManager: { getActiveThread: () => null },
    threadOperations: { list: () => [] },
    isBrowserConnected: () => true,
    isForegroundOperationActive: () => false,
    getServerStatus: () => {
      serverStatusCalls += 1
      return { running: true, address: '127.0.0.1:8787', auth: false }
    },
    getHookStatus: () => ({ enabled: false }),
    publishEvent: () => {},
  } as unknown as ApiHandlerDependencies

  const { handlers } = createApiHandlers(dependencies)
  assert.equal(serverStatusCalls, 0)
  assert.deepEqual(handlers.status(), {
    browserConnected: true,
    activeThreadId: null,
    busy: false,
    server: { running: true, address: '127.0.0.1:8787', auth: false },
    hooks: { enabled: false },
  })
  assert.equal(serverStatusCalls, 1)
})

test('API handlers list and stop run_command jobs with stable errors', async () => {
  const jobs = [
    {
      id: 'j-1',
      pid: 123,
      command: 'work',
      cwd: 'C:\\workspace',
      shell: 'powershell' as const,
      startedAt: 1,
      state: 'running' as const,
    },
  ]
  let stopResult: 'stopped' | 'not_found' | 'timeout' = 'stopped'
  // This focused fake implements only the job dependencies exercised here.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const dependencies = {
    runCommandJobs: {
      list: () => jobs,
      stop: async () => stopResult,
    },
  } as unknown as ApiHandlerDependencies
  const { handlers } = createApiHandlers(dependencies)

  assert.deepEqual(handlers.listJobs(), { jobs })
  assert.deepEqual(await handlers.stopJob('j-1'), {
    stopped: true,
    jobId: 'j-1',
  })
  stopResult = 'not_found'
  await assert.rejects(handlers.stopJob('j-1'), {
    statusCode: 404,
    code: 'JOB_NOT_FOUND',
  })
  stopResult = 'timeout'
  await assert.rejects(handlers.stopJob('j-1'), {
    statusCode: 504,
    code: 'JOB_STOP_TIMEOUT',
  })
  await assert.rejects(handlers.stopJob(' '), {
    statusCode: 400,
    code: 'INVALID_JOB_ID',
  })
})
