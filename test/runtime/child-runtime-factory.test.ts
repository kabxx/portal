import test from 'node:test'
import assert from 'node:assert/strict'

import { ChildRuntimeFactory } from '../../src/runtime/child-runtime-factory.ts'
import {
  createHookSnapshot,
  parseHooksConfig,
} from '../../src/hooks/hook-config.ts'
import type { HookExecutionScope } from '../../src/hooks/hook-types.ts'
import type { RuntimeCoreHandlers } from '../../src/runtime/runtime-core.ts'
import { createFakeRuntime } from '../helpers/fakes.ts'

function scope(): HookExecutionScope {
  return {
    snapshot: createHookSnapshot(
      parseHooksConfig({ enabled: true, maxDepth: 1 })
    ),
    cwd: process.cwd(),
    source: 'tui',
    spawnDepth: 0,
    hookDepth: 0,
    provider: 'gemini',
  }
}

test('ChildRuntimeFactory gives prompt hooks no tools and one model turn', async () => {
  const requests: unknown[] = []
  let handlers: RuntimeCoreHandlers | undefined
  const factory = new ChildRuntimeFactory('chatgpt', async (request) => {
    requests.push(request)
    return {
      runtime: createFakeRuntime({
        submitUserInput: async (_input, value) => {
          handlers = value
          return '{"action":"allow"}'
        },
      }),
      close: async () => {},
    }
  })
  const controller = new AbortController()
  await factory.execute(
    {
      name: 'prompt-check',
      enabled: true,
      type: 'prompt',
      events: ['tool.before'],
      match: {},
      timeoutMs: 1000,
      onError: 'deny',
      prompt: 'Check it.',
    },
    {
      eventId: 'event-1',
      event: 'tool.before',
      occurredAt: Date.now(),
      cwd: process.cwd(),
      source: 'tui',
      spawnDepth: 0,
      provider: 'gemini',
      payload: {},
    },
    scope(),
    controller.signal
  )

  assert.deepEqual(
    (requests[0] as { allowedTools: readonly string[] }).allowedTools,
    []
  )
  assert.equal(handlers?.maxToolCalls, 0)
  assert.equal(handlers?.executionScope?.hookDepth, 1)
  assert.equal(handlers?.executionScope?.originatingHandlerId, 'prompt-check')
})

test('ChildRuntimeFactory applies the explicit agent tool list and turn limit', async () => {
  let request: { allowedTools: readonly string[] } | undefined
  let handlers: RuntimeCoreHandlers | undefined
  const factory = new ChildRuntimeFactory('chatgpt', async (value) => {
    request = value
    return {
      runtime: createFakeRuntime({
        submitUserInput: async (_input, options) => {
          handlers = options
          return '{"action":"allow"}'
        },
      }),
      close: async () => {},
    }
  })
  const controller = new AbortController()
  await factory.execute(
    {
      name: 'agent-check',
      enabled: true,
      type: 'agent',
      events: ['tool.before'],
      match: {},
      timeoutMs: 1000,
      onError: 'deny',
      prompt: 'Inspect it.',
      tools: ['run_command', 'apply_patch'],
      maxTurns: 5,
    },
    {
      eventId: 'event-2',
      event: 'tool.before',
      occurredAt: Date.now(),
      cwd: process.cwd(),
      source: 'tui',
      spawnDepth: 0,
      payload: {},
    },
    scope(),
    controller.signal
  )

  assert.deepEqual(request?.allowedTools, ['run_command', 'apply_patch'])
  assert.equal(handlers?.maxToolCalls, 4)
})
