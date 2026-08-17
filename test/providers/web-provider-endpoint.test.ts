import assert from 'node:assert/strict'
import test from 'node:test'

import { PORTAL_ACTION_PROTOCOL } from '../../src/providers/portal-action-protocol.ts'
import { decodeWebProviderResponse } from '../../src/providers/web-provider-endpoint.ts'
import { createProviderAdapterStub } from '../helpers/fakes.ts'
import { createTestToolRegistry } from '../helpers/tool-host.ts'

test('web Provider rejects an Action without a name instead of creating an unknown Tool request', async () => {
  const adapter = createProviderAdapterStub()
  const tools = createTestToolRegistry(adapter, [], {
    protocol: PORTAL_ACTION_PROTOCOL,
  })

  await assert.rejects(
    decodeWebProviderResponse(
      '<action>{"value":"input"}</action>',
      'exchange-1',
      tools
    ),
    /invalid Action payload/
  )
})
