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
