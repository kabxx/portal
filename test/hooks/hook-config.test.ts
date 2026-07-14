import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createDefaultHooksConfig,
  createHookSnapshot,
  HookConfigError,
  parseHooksConfig,
} from '../../src/hooks/hook-config.ts'

test('parseHooksConfig accepts command, prompt, and agent handlers', () => {
  const config = parseHooksConfig({
    enabled: true,
    maxDepth: 2,
    handlers: [
      {
        name: 'protect-command',
        type: 'command',
        events: ['tool.before'],
        match: { tool: 'run_command' },
        command: ['node', 'hooks/protect.mjs'],
      },
      {
        name: 'review-turn',
        type: 'prompt',
        events: ['turn.completed'],
        prompt: 'Review the event.',
      },
      {
        name: 'inspect-change',
        type: 'agent',
        events: ['tool.before'],
        prompt: 'Inspect the proposed tool call.',
        tools: ['run_command'],
        maxTurns: 4,
      },
    ],
  })

  assert.equal(config.enabled, true)
  assert.equal(config.maxDepth, 2)
  assert.equal(config.handlers[0]?.onError, 'deny')
  assert.equal(config.handlers[1]?.onError, 'continue')
  assert.deepEqual(config.handlers[2], {
    name: 'inspect-change',
    enabled: true,
    type: 'agent',
    events: ['tool.before'],
    match: {},
    timeoutMs: 5000,
    onError: 'deny',
    prompt: 'Inspect the proposed tool call.',
    tools: ['run_command'],
    maxTurns: 4,
  })
})

test('parseHooksConfig defaults to globally disabled hooks', () => {
  assert.deepEqual(parseHooksConfig(undefined), createDefaultHooksConfig())
})

test('parseHooksConfig rejects duplicate names and spawn in agent hooks', () => {
  assert.throws(
    () =>
      parseHooksConfig({
        handlers: [
          {
            name: 'same',
            type: 'prompt',
            events: ['turn.started'],
            prompt: 'one',
          },
          {
            name: 'same',
            type: 'prompt',
            events: ['turn.completed'],
            prompt: 'two',
          },
        ],
      }),
    HookConfigError
  )
  assert.throws(
    () =>
      parseHooksConfig({
        handlers: [
          {
            name: 'agent',
            type: 'agent',
            events: ['tool.before'],
            prompt: 'inspect',
            tools: ['spawn'],
          },
        ],
      }),
    /cannot include spawn/
  )
})

test('createHookSnapshot deeply freezes a detached revision', () => {
  const config = parseHooksConfig({
    enabled: true,
    handlers: [
      {
        name: 'one',
        type: 'prompt',
        events: ['turn.started'],
        prompt: 'check',
      },
    ],
  })
  const snapshot = createHookSnapshot(config)

  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot.handlers), true)
  assert.equal(Object.isFrozen(snapshot.handlers[0]), true)
  assert.equal(typeof snapshot.revision, 'string')
})
