import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  CommandJobService,
  CommandKeybindingService,
  CommandMcpService,
  CommandProviderService,
  CommandSkillService,
  CommandThreadService,
} from '../../src/cli-commands/core/command-services.ts'
import { createBuiltinCommandTestRuntime } from '../helpers/builtin-command-runtime.ts'

test('built-in catalog drives help, providers, and exit', async (t) => {
  const runtime = createBuiltinCommandTestRuntime()
  t.after(async () => await runtime.close())

  await runtime.execute('/help')
  const help = runtime.messages.at(-1)
  assert.equal(help?.title, '/help')
  assert.deepEqual(
    runtime.session.catalog.map(({ primaryName }) => primaryName),
    [
      '/help',
      '/thread',
      '/keybinding',
      '/providers',
      '/exit',
      '/skill',
      '/job',
      '/mcp',
    ]
  )
  assert.match(bodyText(help?.body), /\/thread <subcommand>/)

  await runtime.execute('/providers')
  assert.deepEqual(runtime.messages.at(-1)?.body, [
    'Providers:',
    '  chatgpt',
    '  gemini',
  ])
  assert.deepEqual(await runtime.execute('/exit'), {
    disposition: 'request-stop',
  })
})

test('thread creation resolves providers and forwards parsed route arguments', async (t) => {
  const creations: Parameters<CommandThreadService['create']>[0][] = []
  const threads: CommandThreadService = {
    ...defaultThreads(),
    create: async (input) => {
      creations.push(input)
      return { ok: true }
    },
  }
  const providers: CommandProviderService = {
    list: () => ['gemini'],
    resolve: (value) => (value.toLowerCase() === 'gemini' ? 'gemini' : null),
    completionSnapshot: () => ({ entries: [] }),
  }
  const runtime = createBuiltinCommandTestRuntime({ threads, providers })
  t.after(async () => await runtime.close())

  await runtime.execute('/thread agent missing')
  assert.equal(runtime.messages.at(-1)?.body, 'Unknown provider: missing')
  assert.equal(creations.length, 0)

  await runtime.execute('/thread agent GEMINI 3.1-pro extended')
  await runtime.execute('/thread chat gemini 3-flash')
  assert.deepEqual(
    creations.map(({ provider, modelKey, optionKey, mode }) => ({
      provider,
      modelKey,
      optionKey,
      mode,
    })),
    [
      {
        provider: 'gemini',
        modelKey: '3.1-pro',
        optionKey: 'extended',
        mode: 'agent',
      },
      {
        provider: 'gemini',
        modelKey: '3-flash',
        optionKey: null,
        mode: 'chat',
      },
    ]
  )
  assert.equal(
    creations.every(({ signal }) => signal.aborted),
    true
  )
})

test('resolved route availability preserves the busy-thread admission contract', async (t) => {
  const runtime = createBuiltinCommandTestRuntime()
  t.after(async () => await runtime.close())

  for (const input of [
    '/help',
    '/thread',
    '/thread agent gemini',
    '/thread chat gemini',
    '/thread list',
    '/thread history',
    '/thread resume https://chatgpt.com/c/example',
    '/thread switch t-2',
    '/thread status',
    '/thread close t-1',
    '/thread detach',
    '/skill',
    '/skill list',
    '/mcp start',
    '/job stop j-1',
    '/keybinding reset',
    '/providers',
    '/exit',
  ]) {
    const analysis = runtime.session.prepare(input)
    assert.equal(analysis.kind, 'ready', input)
    if (analysis.kind === 'ready') {
      assert.equal(
        runtime.session.canExecute(analysis.invocation, { threadBusy: true }),
        true,
        input
      )
    }
  }

  for (const input of [
    '/thread reload',
    '/thread capability',
    '/skill add ./skill',
    '/skill enable alpha',
    '/skill disable alpha',
    '/skill remove alpha',
  ]) {
    const analysis = runtime.session.prepare(input)
    assert.equal(analysis.kind, 'ready', input)
    if (analysis.kind === 'ready') {
      assert.equal(
        runtime.session.canExecute(analysis.invocation, { threadBusy: true }),
        false,
        input
      )
    }
  }
})

test('thread queries, lifecycle actions, and navigation use the narrow port', async (t) => {
  const calls: string[] = []
  const threads: CommandThreadService = {
    ...defaultThreads(),
    list: () => [
      {
        id: 't-1',
        provider: 'gemini',
        title: 'First',
        turnCount: 2,
        conversationUrl: 'https://gemini.google.com/app/1',
        active: true,
      },
    ],
    history: async (limit, signal) => {
      calls.push(`history:${limit}`)
      assert.equal(signal.aborted, false)
      return {
        ok: true,
        entries: [
          {
            id: 7,
            provider: 'gemini',
            title: 'Archived',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastUsedAt: '2026-01-02T00:00:00.000Z',
            conversationUrl: 'https://gemini.google.com/app/7',
          },
        ],
      }
    },
    resume: async (target) => {
      calls.push(`resume:${target}`)
      return { ok: false, message: 'Cannot resume.' }
    },
    reloadActive: async () => ({
      ok: false,
      message: 'Reload failed.',
      threadId: 't-1',
    }),
    switchTo: (threadId) => {
      calls.push(`switch:${threadId}`)
      return threadId === 't-2'
    },
    status: () => ({
      id: 't-1',
      provider: 'gemini',
      title: 'First',
      turnCount: 2,
      conversationUrl: 'https://gemini.google.com/app/1',
      active: true,
    }),
    close: async (threadId) => {
      calls.push(`close:${threadId}`)
      return { ok: true, threadId: threadId ?? 't-1', wasActive: false }
    },
    detach: () => 't-1',
  }
  const runtime = createBuiltinCommandTestRuntime({ threads })
  t.after(async () => await runtime.close())

  await runtime.execute('/thread list')
  assert.match(
    bodyText(runtime.messages.at(-1)?.body),
    /\* t-1 {2}gemini {2}2 turns/
  )
  assert.match(bodyText(runtime.messages.at(-1)?.body), /title: First/)
  assert.match(
    bodyText(runtime.messages.at(-1)?.body),
    /url: https:\/\/gemini\.google\.com\/app\/1/
  )
  await runtime.execute('/thread history 12')
  assert.match(bodyText(runtime.messages.at(-1)?.body), /#7 Archived/)
  assert.match(
    bodyText(runtime.messages.at(-1)?.body),
    /Last used: 2026-01-02T00:00:00\.000Z/
  )
  await runtime.execute('/thread resume #7')
  assert.equal(runtime.messages.at(-1)?.body, 'Cannot resume.')
  await runtime.execute('/thread reload')
  assert.equal(runtime.messages.at(-1)?.threadId, 't-1')
  await runtime.execute('/thread switch t-2')
  await runtime.execute('/thread status')
  assert.match(bodyText(runtime.messages.at(-1)?.body), /id: t-1/)
  await runtime.execute('/thread close t-2')
  await runtime.execute('/thread detach')

  assert.deepEqual(calls, [
    'history:12',
    'resume:#7',
    'switch:t-2',
    'close:t-2',
  ])
  assert.deepEqual(runtime.navigation, [
    { kind: 'show-thread', threadId: 't-2' },
    { kind: 'remove-thread', threadId: 't-2' },
    { kind: 'show-home' },
  ])
})

test('reload reports success and close cleanup failures still remove timelines', async (t) => {
  const threads: CommandThreadService = {
    ...defaultThreads(),
    reloadActive: async () => ({ ok: true }),
    close: async () => ({
      ok: false,
      message: 'Runtime cleanup failed.',
      removedThreadId: 't-1',
    }),
  }
  const runtime = createBuiltinCommandTestRuntime({ threads })
  t.after(async () => await runtime.close())

  await runtime.execute('/thread reload')
  assert.deepEqual(runtime.messages.at(-1), {
    level: 'success',
    title: '/thread reload',
    body: 'Provider page reloaded.',
    format: 'plain',
  })

  await runtime.execute('/thread close t-1')
  assert.deepEqual(runtime.navigation.at(-1), {
    kind: 'remove-thread',
    threadId: 't-1',
  })
  assert.deepEqual(runtime.messages.at(-1), {
    level: 'warning',
    title: '/thread close',
    body: 'Runtime cleanup failed.',
    format: 'plain',
  })
})

test('thread close cancellation cannot publish a late warning', async (t) => {
  const controller = new AbortController()
  const closeStarted = Promise.withResolvers<void>()
  const threads: CommandThreadService = {
    ...defaultThreads(),
    close: async (_threadId, signal) => {
      closeStarted.resolve()
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error('close cancelled')
            )
          },
          {
            once: true,
          }
        )
      })
    },
  }
  const runtime = createBuiltinCommandTestRuntime({ threads })
  t.after(async () => await runtime.close())

  const closing = runtime.execute('/thread close t-1', {
    signal: controller.signal,
  })
  await closeStarted.promise
  controller.abort(new DOMException('cancel close', 'AbortError'))

  await assert.rejects(closing, { name: 'AbortError' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(runtime.messages, [])
  assert.deepEqual(runtime.navigation, [])
})

test('thread capability renders port results without exposing provider adapters', async (t) => {
  const executions: Array<{ name: string; args: readonly string[] }> = []
  const threads: CommandThreadService = {
    ...defaultThreads(),
    listCapabilities: async () => ({
      ok: true,
      provider: 'chatgpt',
      capabilities: [
        { name: 'image_create', state: 'available' },
        { name: 'web_search', state: 'selected' },
      ],
      usage: '/thread capability <capability>',
    }),
    executeCapability: async (name, args) => {
      executions.push({ name, args })
      return {
        status: name === 'missing' ? 'unknown-capability' : 'ok',
        title: '/thread capability',
        body:
          name === 'missing'
            ? 'Unknown capability for chatgpt: missing'
            : `chatgpt.${name}: selected`,
        format: 'plain',
      }
    },
  }
  const runtime = createBuiltinCommandTestRuntime({ threads })
  t.after(async () => await runtime.close())

  await runtime.execute('/thread capability')
  assert.match(
    bodyText(runtime.messages.at(-1)?.body),
    /image_create {2}available/
  )
  assert.match(
    bodyText(runtime.messages.at(-1)?.body),
    /Usage:\n {2}\/thread capability <capability>/
  )
  await runtime.execute('/thread capability web_search')
  assert.equal(runtime.messages.at(-1)?.level, 'success')
  await runtime.execute('/thread capability missing on')
  assert.equal(runtime.messages.at(-1)?.level, 'warning')
  assert.deepEqual(executions, [
    { name: 'web_search', args: [] },
    { name: 'missing', args: ['on'] },
  ])
})

test('skill commands pass signals, redact remote secrets, and report lifecycle results', async (t) => {
  const calls: string[] = []
  const skills: CommandSkillService = {
    add: async (source, options) => {
      calls.push(`add:${source}:${options.registryUrl ?? '-'}`)
      assert.equal(options.signal.aborted, false)
      return {
        skills: [
          { name: 'alpha', directory: 'C:\\skills\\alpha' },
          { name: 'beta', directory: 'C:\\skills\\beta' },
        ],
        warnings: ['Cleanup warning.'],
      }
    },
    list: async (signal) => {
      assert.equal(signal.aborted, false)
      return {
        skills: [{ name: 'alpha', enabled: true }],
        issues: [
          { directory: 'C:\\skills\\broken', message: 'Missing SKILL.md' },
        ],
      }
    },
    enable: async (name) => {
      calls.push(`enable:${name}`)
      return true
    },
    disable: async (name) => {
      calls.push(`disable:${name}`)
      return false
    },
    remove: async (name) => {
      calls.push(`remove:${name}`)
      return { removed: true, warnings: ['Temporary cleanup failed.'] }
    },
  }
  const runtime = createBuiltinCommandTestRuntime({ skills })
  t.after(async () => await runtime.close())

  const registryUrl = 'https://user:password@example.com/?token=secret#fragment'
  await runtime.execute(`/skill add alpha --registry ${registryUrl}`)
  const install = runtime.messages.at(-3)
  assert.match(bodyText(install?.body), /Registry: https:\/\/example\.com\//)
  assert.doesNotMatch(bodyText(install?.body), /password|secret|fragment/)
  assert.match(
    bodyText(runtime.messages.at(-2)?.body),
    /Added and enabled 2 skills/
  )
  assert.deepEqual(runtime.messages.at(-1)?.body, ['Cleanup warning.'])

  await runtime.execute('/skill list')
  assert.equal(runtime.messages.at(-2)?.level, 'info')
  assert.equal(runtime.messages.at(-1)?.level, 'warning')
  await runtime.execute('/skill enable alpha')
  assert.equal(runtime.messages.at(-1)?.level, 'success')
  await runtime.execute('/skill disable missing')
  assert.equal(runtime.messages.at(-1)?.body, 'Unknown skill: missing')
  await runtime.execute('/skill remove alpha')
  assert.equal(runtime.messages.at(-2)?.body, 'Removed alpha.')
  assert.deepEqual(runtime.messages.at(-1)?.body, ['Temporary cleanup failed.'])
  assert.deepEqual(calls, [
    `add:alpha:${registryUrl}`,
    'enable:alpha',
    'disable:missing',
    'remove:alpha',
  ])
})

test('MCP commands isolate service errors and expose only authentication state', async (t) => {
  const calls: string[] = []
  let auth = false
  const mcp: CommandMcpService = {
    start: async () => {
      calls.push('start')
    },
    stop: async () => {
      calls.push('stop')
      throw new Error('stop failed')
    },
    status: () => ({
      running: true,
      address: 'http://127.0.0.1:8788/mcp',
      auth,
    }),
  }
  const runtime = createBuiltinCommandTestRuntime({ mcp })
  t.after(async () => await runtime.close())

  await runtime.execute('/mcp')
  assert.match(bodyText(runtime.messages.at(-1)?.body), /Subcommands:/)
  await runtime.execute('/mcp start')
  assert.equal(runtime.messages.at(-1)?.body, 'MCP Server started.')
  await runtime.execute('/mcp stop')
  assert.equal(runtime.messages.at(-1)?.body, 'stop failed')
  await runtime.execute('/mcp token')
  assert.equal(runtime.messages.at(-1)?.body, 'Authentication disabled.')
  auth = true
  await runtime.execute('/mcp status')
  assert.deepEqual(runtime.messages.at(-1)?.body, [
    'Running: yes',
    'Address: http://127.0.0.1:8788/mcp',
    'Authentication: enabled',
  ])
  assert.deepEqual(calls, ['start', 'stop'])
})

test('job commands sanitize output and map stop outcomes', async (t) => {
  const stopped: string[] = []
  let stopResult: Awaited<ReturnType<CommandJobService['stop']>> = 'stopped'
  const jobs: CommandJobService = {
    list: () => [
      {
        id: 'j-1',
        pid: 42,
        state: 'running',
        startedAt: Date.now() - 2_000,
        shell: 'powershell',
        cwd: 'C:\\project',
        command: 'first\n\u001B[31msecond',
      },
    ],
    stop: async (id, signal) => {
      assert.equal(signal.aborted, false)
      stopped.push(id)
      return stopResult
    },
  }
  const runtime = createBuiltinCommandTestRuntime({ jobs })
  t.after(async () => await runtime.close())

  await runtime.execute('/job')
  const body = bodyText(runtime.messages.at(-1)?.body)
  assert.match(body, /j-1 {2}pid=42 {2}running/)
  assert.match(body, /command: first \[31msecond/)
  assert.equal(body.includes('\u001B'), false)

  await runtime.execute('/job stop j-1')
  assert.equal(runtime.messages.at(-1)?.body, 'Stopped j-1.')
  stopResult = 'timeout'
  await runtime.execute('/job stop j-2')
  assert.equal(
    runtime.messages.at(-1)?.body,
    'Timed out waiting for j-2 to stop.'
  )
  stopResult = 'not-found'
  await runtime.execute('/job stop j-3')
  assert.equal(runtime.messages.at(-1)?.body, 'Unknown or finished job: j-3')
  assert.deepEqual(stopped, ['j-1', 'j-2', 'j-3'])
})

test('keybinding reset reports success and failures', async (t) => {
  let calls = 0
  const keybindings: CommandKeybindingService = {
    reset: async (signal) => {
      assert.equal(signal.aborted, false)
      calls += 1
      if (calls === 2) throw new Error('cannot write config')
    },
  }
  const runtime = createBuiltinCommandTestRuntime({ keybindings })
  t.after(async () => await runtime.close())

  await runtime.execute('/keybinding')
  assert.match(bodyText(runtime.messages.at(-1)?.body), /reset/)
  await runtime.execute('/keybinding reset')
  assert.equal(
    runtime.messages.at(-1)?.body,
    'Restored platform-default keybindings.'
  )
  await runtime.execute('/keybinding reset')
  assert.equal(runtime.messages.at(-1)?.body, 'cannot write config')
})

function defaultThreads(): CommandThreadService {
  return {
    listAgentModes: () => ['agent', 'chat'],
    create: async () => ({ ok: true }),
    list: () => [],
    history: async () => ({ ok: true, entries: [] }),
    resume: async () => ({ ok: true }),
    reloadActive: async () => ({ ok: true }),
    switchTo: () => false,
    status: () => null,
    close: async () => ({ ok: false, message: 'No active thread.' }),
    detach: () => null,
    listCapabilities: async () => ({
      ok: false,
      message: 'No active thread. Use /thread agent <provider> first.',
    }),
    executeCapability: async () => ({
      status: 'no-active-thread',
      title: '/thread capability',
      body: 'No active thread. Use /thread agent <provider> first.',
      format: 'plain',
    }),
  }
}

function bodyText(body: string | readonly string[] | undefined): string {
  return typeof body === 'string' ? body : (body?.join('\n') ?? '')
}
