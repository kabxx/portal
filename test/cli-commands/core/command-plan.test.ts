import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  CommandContribution,
  CommandHandler,
  CommandRouteSpec,
} from '../../../src/cli-commands/core/command-contracts.ts'
import { CommandPlanError } from '../../../src/cli-commands/core/command-errors.ts'
import {
  commandContributionSpec,
  commandContributions,
  commandHandlerBindingSpec,
  commandHandlerBindings,
  ResolvedCommandPlan,
} from '../../../src/cli-commands/core/command-plan.ts'
import { commandServiceRefs } from '../../../src/cli-commands/core/command-services.ts'
import type { ExtensionTestHost } from '../../../src/extensions/extension-test-host.ts'
import {
  createTestHost,
  extension,
} from '../../extensions/extension-test-fixtures.ts'

const continueHandler: CommandHandler = async () => ({
  disposition: 'continue',
})

test('ResolvedCommandPlan rejects primary and alias collisions', () => {
  const host = commandHost()
  registerCommand(host, command('test.alpha', '/alpha', ['/shared']))
  registerCommand(host, command('test.beta', '/beta', ['/shared']), {
    extensionId: 'test.beta-owner',
  })

  assert.throws(
    () => new ResolvedCommandPlan(host.freeze()),
    (error: unknown) =>
      error instanceof CommandPlanError &&
      /name "\/shared" is owned by both/.test(error.message)
  )
})

test('ResolvedCommandPlan ordering is deterministic and catalog data is immutable', () => {
  const host = commandHost()
  registerCommand(host, command('test.zeta', '/zeta'), {
    extensionId: 'test.zeta-owner',
  })
  registerCommand(host, command('test.alpha', '/alpha'), {
    extensionId: 'test.alpha-owner',
  })

  const plan = new ResolvedCommandPlan(host.freeze())

  assert.deepEqual(
    plan.catalog.map(({ id }) => id),
    ['test.alpha', 'test.zeta']
  )
  assert.equal(Object.isFrozen(plan.catalog), true)
  assert.equal(Object.isFrozen(plan.catalog[0]?.routes), true)
})

test('one plan parses quoted arguments, aliases, options, and admission metadata', () => {
  const host = commandHost()
  registerCommand(
    host,
    command(
      'test.manage',
      '/manage',
      ['/m'],
      [
        route(
          'add',
          ['add'],
          'thread-idle',
          [
            {
              name: 'source',
              cardinality: 'one-or-more',
            },
          ],
          [{ name: '--registry', valueName: 'url' }]
        ),
      ]
    )
  )
  const plan = new ResolvedCommandPlan(host.freeze())

  const analysis = plan.prepare(
    '/m add "local skill" extras --registry https://example.test'
  )

  assert.equal(analysis.kind, 'ready')
  if (analysis.kind !== 'ready') return
  assert.equal(analysis.invocation.commandId, 'test.manage')
  assert.equal(analysis.invocation.invokedName, '/m')
  assert.deepEqual(analysis.invocation.arguments.positionals.source, [
    'local skill',
    'extras',
  ])
  assert.equal(
    analysis.invocation.arguments.options['--registry'],
    'https://example.test'
  )
  assert.equal(
    plan.canExecute(analysis.invocation, { threadBusy: true }),
    false
  )
  assert.equal(
    plan.canExecute(analysis.invocation, { threadBusy: false }),
    true
  )
})

test('analysis distinguishes partial, unknown, invalid, and ready inputs', () => {
  const host = commandHost()
  registerCommand(
    host,
    command(
      'test.thread',
      '/thread',
      [],
      [
        route('help', [], 'always'),
        route('agent', ['agent'], 'always', [
          { name: 'provider', cardinality: 'required' },
        ]),
      ]
    )
  )
  const plan = new ResolvedCommandPlan(host.freeze())

  assert.equal(plan.analyze('hello').kind, 'not-command')
  assert.equal(plan.analyze('/thr').kind, 'partial')
  assert.equal(plan.prepare('/thr').kind, 'unknown')
  assert.equal(plan.analyze('/thread ag').kind, 'partial')
  assert.equal(plan.analyze('/thread nonsense').kind, 'invalid')
  assert.equal(plan.prepare('/thread agent').kind, 'invalid')
  assert.equal(plan.prepare('/thread agent gemini').kind, 'ready')
  const quote = plan.prepare('/thread agent "gemini')
  assert.equal(quote.kind, 'invalid')
  if (quote.kind === 'invalid') {
    assert.equal(quote.diagnostic.code, 'unterminated-quote')
  }
})

test('route projection removes disabled routes from parsing, hints, and catalog', () => {
  const host = commandHost()
  registerCommand(
    host,
    command(
      'test.thread',
      '/thread',
      [],
      [
        route('root', [], 'always'),
        route('agent', ['agent'], 'always', [
          { name: 'provider', cardinality: 'required' },
        ]),
        route('chat', ['chat'], 'always', [
          { name: 'provider', cardinality: 'required' },
        ]),
      ]
    )
  )
  const plan = new ResolvedCommandPlan(host.freeze())
  const projection = {
    isRouteEnabled: (_commandId: string, routeId: string) =>
      routeId !== 'agent',
  }

  assert.equal(plan.prepare('/thread agent gemini', projection).kind, 'invalid')
  assert.equal(plan.prepare('/thread chat gemini', projection).kind, 'ready')
  const partial = plan.analyze('/thread a', undefined, projection)
  assert.equal(partial.kind, 'invalid')
  assert.equal(
    partial.hints.some(({ usage }) => usage === 'agent'),
    false
  )
  assert.deepEqual(
    plan.projectCatalog(projection)[0]?.routes.map(({ id }) => id),
    ['root', 'chat']
  )
})

test('route metadata drives static and dynamic hints, completion, and syntax spans', () => {
  const host = commandHost()
  registerCommand(
    host,
    command(
      'test.thread',
      '/thread',
      [],
      [
        route('help', [], 'always'),
        route(
          'agent',
          ['agent'],
          'always',
          [
            {
              name: 'provider',
              cardinality: 'required',
              completion: { sourceId: 'portal.providers', dependsOn: [] },
            },
          ],
          [],
          [{ usage: 'agent <provider>', description: 'Create a thread.' }]
        ),
      ]
    )
  )
  const plan = new ResolvedCommandPlan(host.freeze())

  const staticAnalysis = plan.analyze('/thread ag')
  assert.equal(staticAnalysis.completion, '/thread agent ')
  assert.deepEqual(staticAnalysis.syntaxSpans, [
    { start: 0, end: 7, kind: 'command' },
  ])

  const dynamic = plan.analyze('/thread agent ge', {
    entries: [
      {
        sourceId: 'portal.providers',
        dependencies: {},
        candidates: [
          { value: 'gemini', description: 'Google Gemini' },
          { value: 'chatgpt', description: 'OpenAI ChatGPT' },
        ],
      },
    ],
  })
  assert.equal(dynamic.completion, '/thread agent gemini ')
  assert.equal(dynamic.hints.at(-1)?.usage, 'gemini')
})

test('dynamic completion ignores route options in positional projection', () => {
  const host = commandHost()
  registerCommand(
    host,
    command(
      'test.thread',
      '/thread',
      [],
      [
        route(
          'agent',
          ['agent'],
          'always',
          [
            {
              name: 'provider',
              cardinality: 'required',
              completion: { sourceId: 'providers', dependsOn: [] },
            },
            {
              name: 'model',
              cardinality: 'optional',
              completion: {
                sourceId: 'models',
                dependsOn: ['provider'],
              },
            },
          ],
          [{ name: '--profile', valueName: 'name' }]
        ),
      ]
    )
  )
  const plan = new ResolvedCommandPlan(host.freeze())
  const snapshot = {
    entries: [
      {
        sourceId: 'providers',
        dependencies: {},
        candidates: [{ value: 'gemini', description: 'Google Gemini' }],
      },
      {
        sourceId: 'models',
        dependencies: { provider: 'gemini' },
        candidates: [{ value: 'pro', description: 'Pro model' }],
      },
    ],
  }

  assert.equal(
    plan.analyze('/thread agent --profile work ge', snapshot).completion,
    '/thread agent --profile work gemini '
  )
  assert.equal(
    plan.analyze('/thread agent gemini --profile work pr', snapshot).completion,
    '/thread agent gemini --profile work pro'
  )
  assert.equal(
    plan.analyze('/thread agent gemini --profile work ', snapshot).completion,
    '/thread agent gemini --profile work pro'
  )
  assert.equal(
    plan.prepare('/thread agent gemini pro --profile work').kind,
    'ready'
  )
})

test('command contribution schema rejects unknown fields and decorated arrays', () => {
  const unknownFieldHost = commandHost()
  const invalid = { ...command('test.invalid', '/invalid'), extra: true }
  assert.throws(() => registerCommand(unknownFieldHost, invalid))

  const decoratedHost = commandHost()
  const aliases: string[] = []
  Object.defineProperty(aliases, 'extra', { value: 'mutable' })
  assert.throws(() =>
    registerCommand(decoratedHost, {
      ...command('test.decorated', '/decorated'),
      aliases,
    })
  )

  const sparseHost = commandHost()
  const sparseAliases = new Array<string>(1)
  assert.throws(() =>
    registerCommand(sparseHost, {
      ...command('test.sparse', '/sparse'),
      aliases: sparseAliases,
    })
  )
})

test('declarative constraints fully validate conditional command arguments', () => {
  const host = commandHost()
  registerCommand(
    host,
    command(
      'test.skill',
      '/skill',
      [],
      [
        route(
          'add',
          ['add'],
          'thread-idle',
          [{ name: 'source', cardinality: 'one-or-more' }],
          [{ name: '--registry', valueName: 'url' }],
          [],
          [
            {
              kind: 'option-requires-single-positional',
              option: '--registry',
              positional: 'source',
            },
            {
              kind: 'option-forbids-http-url-positional',
              option: '--registry',
              positional: 'source',
            },
          ]
        ),
      ]
    )
  )
  const plan = new ResolvedCommandPlan(host.freeze())

  assert.equal(plan.prepare('/skill add local directory').kind, 'ready')
  assert.equal(
    plan.prepare('/skill add review --registry https://hub.test').kind,
    'ready'
  )
  assert.equal(
    plan.prepare('/skill add two names --registry https://hub.test').kind,
    'invalid'
  )
  assert.equal(
    plan.prepare(
      '/skill add https://archive.test/skill --registry https://hub.test'
    ).kind,
    'invalid'
  )
})

test('prepared invocations are generation-bound and cannot be forged', () => {
  const host = commandHost()
  registerCommand(host, command('test.safe', '/safe'))
  const plan = new ResolvedCommandPlan(host.freeze())

  assert.throws(
    () =>
      plan.resolvePrepared({
        generation: plan.generation,
        commandId: 'test.safe',
        primaryName: '/safe',
        invokedName: '/safe',
        routeId: 'root',
        availability: 'always',
        arguments: { positionals: {}, options: {} },
      }),
    CommandPlanError
  )
})

function commandHost(): ExtensionTestHost {
  const host = createTestHost()
  for (const ref of commandServiceRefs) host.defineService(ref)
  host.defineContribution(commandContributionSpec)
  host.defineExecutableBinding(commandHandlerBindingSpec)
  return host
}

function registerCommand(
  host: ExtensionTestHost,
  contribution: CommandContribution,
  options: {
    readonly extensionId?: string
    readonly handler?: CommandHandler
  } = {}
): void {
  const extensionId = options.extensionId ?? 'test.commands'
  host.register(extension(extensionId), {
    register(api) {
      api.contribute(commandContributions, {
        id: contribution.id,
        value: contribution,
        requiredServices: [],
        requiredCapabilities: [],
      })
      api.bind(commandHandlerBindings, {
        id: `${contribution.id}.handler`,
        targetId: contribution.id,
        binding: options.handler ?? continueHandler,
      })
    },
  })
}

function command(
  id: string,
  primaryName: string,
  aliases: readonly string[] = [],
  routes: readonly CommandRouteSpec[] = [route('root')]
): CommandContribution {
  return {
    id,
    primaryName,
    aliases,
    usage: primaryName,
    description: `${primaryName} command.`,
    routes,
  }
}

function route(
  id: string,
  path: readonly string[] = [],
  availability: CommandRouteSpec['availability'] = 'always',
  positionals: CommandRouteSpec['positionals'] = [],
  options: CommandRouteSpec['options'] = [],
  help: CommandRouteSpec['help'] = [],
  constraints: CommandRouteSpec['constraints'] = []
): CommandRouteSpec {
  return {
    id,
    path,
    availability,
    positionals,
    options,
    constraints,
    help,
  }
}
