import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  createHookSnapshot,
  parseHooksConfig,
} from '../../src/hooks/hook-config.ts'
import { HookDispatcher } from '../../src/hooks/hook-dispatcher.ts'
import type { HookExecutionScope } from '../../src/hooks/hook-types.ts'
import { PortalAbortError } from '../../src/runtime/runtime-cancellation.ts'

function createScope(config: unknown): HookExecutionScope {
  return {
    snapshot: createHookSnapshot(parseHooksConfig(config)),
    cwd: path.resolve('.'),
    source: 'system',
    spawnDepth: 0,
    hookDepth: 0,
  }
}

test('HookDispatcher chains command rewrites in configuration order', async () => {
  const scripts = [
    `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const e=JSON.parse(s);process.stdout.write(JSON.stringify({action:'rewrite',params:{...e.payload.params,first:true}}))})`,
    `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const e=JSON.parse(s);process.stdout.write(JSON.stringify({action:'rewrite',params:{...e.payload.params,second:e.payload.params.first===true}}))})`,
  ]
  const scope = createScope({
    enabled: true,
    handlers: scripts.map((script, index) => ({
      name: `rewrite-${index}`,
      type: 'command',
      events: ['tool.before'],
      command: [process.execPath, '-e', script],
    })),
  })
  const dispatcher = new HookDispatcher()
  const event = dispatcher.createEvent('tool.before', scope, {
    tool: 'run_command',
    params: { command: 'git status' },
  })

  assert.deepEqual(await dispatcher.dispatch(event, scope), {
    action: 'rewrite',
    params: { command: 'git status', first: true, second: true },
    rewrittenBy: ['rewrite-0', 'rewrite-1'],
  })
})

test('HookDispatcher stops at the first deny', async () => {
  const scope = createScope({
    enabled: true,
    handlers: [
      {
        name: 'block',
        type: 'command',
        events: ['tool.before'],
        command: [
          process.execPath,
          '-e',
          `process.stdout.write(JSON.stringify({action:'deny',reason:'not allowed'}))`,
        ],
      },
      {
        name: 'must-not-run',
        type: 'command',
        events: ['tool.before'],
        command: [process.execPath, '-e', `process.exit(7)`],
      },
    ],
  })
  const dispatcher = new HookDispatcher()
  const event = dispatcher.createEvent('tool.before', scope, {
    tool: 'run_command',
    params: {},
  })

  assert.deepEqual(await dispatcher.dispatch(event, scope), {
    action: 'deny',
    reason: 'not allowed',
    handler: 'block',
    rewrittenBy: [],
  })
})

test('HookDispatcher fails closed for invalid tool.before output', async () => {
  const scope = createScope({
    enabled: true,
    handlers: [
      {
        name: 'broken',
        type: 'command',
        events: ['tool.before'],
        command: [process.execPath, '-e', `process.stdout.write('not json')`],
      },
    ],
  })
  const dispatcher = new HookDispatcher()
  const event = dispatcher.createEvent('tool.before', scope, {
    tool: 'run_command',
    params: {},
  })
  const result = await dispatcher.dispatch(event, scope)

  assert.equal(result.action, 'deny')
  assert.match(result.action === 'deny' ? result.reason : '', /invalid JSON/)
})

test('HookDispatcher fails closed for an empty command response', async () => {
  const scope = createScope({
    enabled: true,
    handlers: [
      {
        name: 'empty',
        type: 'command',
        events: ['tool.before'],
        command: [process.execPath, '-e', 'process.exit(0)'],
      },
    ],
  })
  const dispatcher = new HookDispatcher()
  const event = dispatcher.createEvent('tool.before', scope, {
    tool: 'run_command',
    params: {},
  })

  const result = await dispatcher.dispatch(event, scope)
  assert.equal(result.action, 'deny')
  assert.match(result.action === 'deny' ? result.reason : '', /empty output/)
})

test('HookDispatcher enforces the configured command output limit', async () => {
  const scope = createScope({
    enabled: true,
    handlers: [
      {
        name: 'oversized',
        type: 'command',
        events: ['tool.before'],
        command: [
          process.execPath,
          '-e',
          `process.stdout.write(JSON.stringify({action:'allow'}))`,
        ],
      },
    ],
  })
  const dispatcher = new HookDispatcher(null, null, 8)
  const event = dispatcher.createEvent('tool.before', scope, {
    tool: 'run_command',
    params: {},
  })

  const result = await dispatcher.dispatch(event, scope)
  assert.equal(result.action, 'deny')
  assert.match(result.action === 'deny' ? result.reason : '', /8 bytes/)
})

test('HookDispatcher skips handlers when the global switch is disabled', async () => {
  const scope = createScope({
    enabled: false,
    handlers: [
      {
        name: 'block',
        type: 'command',
        events: ['tool.before'],
        command: [
          process.execPath,
          '-e',
          `process.stdout.write(JSON.stringify({action:'deny'}))`,
        ],
      },
    ],
  })
  const dispatcher = new HookDispatcher()
  const event = dispatcher.createEvent('tool.before', scope, {
    tool: 'run_command',
    params: {},
  })
  assert.deepEqual(await dispatcher.dispatch(event, scope), {
    action: 'allow',
    rewrittenBy: [],
  })
})

test('HookDispatcher applies onError when a model handler times out internally', async () => {
  const scope = createScope({
    enabled: true,
    handlers: [
      {
        name: 'timed-out-model',
        type: 'prompt',
        events: ['tool.before'],
        prompt: 'Review.',
        onError: 'deny',
      },
    ],
  })
  const dispatcher = new HookDispatcher({
    execute: async () => {
      throw new PortalAbortError('internal Hook timeout')
    },
  })
  const event = dispatcher.createEvent('tool.before', scope, {
    tool: 'run_command',
    params: {},
  })

  const result = await dispatcher.dispatch(event, scope)
  assert.equal(result.action, 'deny')
  assert.match(
    result.action === 'deny' ? result.reason : '',
    /internal Hook timeout/
  )
})
