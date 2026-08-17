import type {
  ContributionSpec,
  ExecutableBindingSpec,
  ResolvedContribution,
  ResolvedExecutableBinding,
} from '../../extensions/extension-contracts.ts'
import {
  createContributionRef,
  createExecutableBindingRef,
} from '../../extensions/extension-contracts.ts'
import type { ResolvedExtensionGraph } from '../../extensions/extension-registry.ts'
import { freezeImmutableData } from '../../extensions/immutable-data.ts'
import type {
  CommandCompletionEntry,
  CommandCompletionSnapshot,
  CommandContribution,
  CommandDescriptor,
  CommandDiagnostic,
  CommandExecutionContext,
  CommandHandler,
  CommandHint,
  CommandInputAnalysis,
  CommandName,
  CommandPositionalSpec,
  CommandRouteConstraint,
  CommandRouteProjection,
  CommandRouteSpec,
  CommandSyntaxSpan,
  PreparedCommandArguments,
  PreparedCommandInvocation,
  ResolvedCommand,
} from './command-contracts.ts'
import { CommandPlanError } from './command-errors.ts'
import { commandCapabilities, commandServiceRefs } from './command-services.ts'

interface Token {
  readonly value: string
  readonly start: number
  readonly end: number
}

interface TokenizationResult {
  readonly tokens: readonly Token[]
  readonly trailingWhitespace: boolean
  readonly diagnostic?: CommandDiagnostic
}

interface RouteParseSuccess {
  readonly route: CommandRouteSpec
  readonly arguments: PreparedCommandArguments
}

interface RouteParseFailure {
  readonly diagnostic: CommandDiagnostic
}

interface RouteTokenProjection {
  readonly positionalTokens: readonly Token[]
  readonly optionValues: Readonly<Record<string, string | null>>
  readonly diagnostic?: CommandDiagnostic
}

interface AnalyzeOptions {
  readonly final: boolean
  readonly completionSnapshot?: CommandCompletionSnapshot
  readonly routeProjection?: CommandRouteProjection
}

export const commandContributions = createContributionRef<CommandContribution>({
  id: 'commands.collect',
  version: 1,
})

export const commandHandlerBindings =
  createExecutableBindingRef<CommandHandler>({
    id: 'commands.handlers',
    version: 1,
    kind: 'command-handler',
    targetContribution: commandContributions,
  })

export const commandContributionSpec: ContributionSpec<CommandContribution> =
  Object.freeze({
    ref: commandContributions,
    schema: Object.freeze({ parse: parseCommandContribution }),
    identityOf: (value: CommandContribution) => value.id,
    conflictKeyOf: (value: CommandContribution) => value.primaryName,
    maxPerConflictKey: 1,
    selection: 'all',
    ordering: 'dependency-edges',
    allowedServices: commandServiceRefs,
    allowedCapabilities: commandCapabilities,
  })

export const commandHandlerBindingSpec: ExecutableBindingSpec<CommandHandler> =
  Object.freeze({
    ref: commandHandlerBindings,
    targetContribution: commandContributions,
    cardinality: 'exactly-one-per-target',
    ownership: 'same-owner',
    capture(binding: CommandHandler) {
      if (typeof binding !== 'function') {
        throw new TypeError('Command handler binding must be a function.')
      }
      return async (
        invocation: Readonly<PreparedCommandInvocation>,
        context: CommandExecutionContext
      ) => await binding(invocation, context)
    },
  })

export class ResolvedCommandPlan {
  readonly #commands: readonly ResolvedCommand[]
  readonly #byName: ReadonlyMap<CommandName, ResolvedCommand>
  readonly #prepared = new WeakMap<PreparedCommandInvocation, ResolvedCommand>()

  public readonly generation: string
  public readonly catalog: readonly CommandDescriptor[]

  public constructor(graph: ResolvedExtensionGraph) {
    this.generation = graph.generation
    const contributions = graph.contributions(commandContributions)
    const bindings = graph.executableBindings(commandHandlerBindings)
    const bindingByTarget = new Map(
      bindings.map((binding) => [binding.targetId, binding])
    )
    const names = new Map<CommandName, ResolvedCommand>()
    const commands = contributions.map((contribution) => {
      const binding = bindingByTarget.get(contribution.id)
      if (binding === undefined) {
        throw new CommandPlanError(
          `Command "${contribution.id}" has no resolved handler binding.`
        )
      }
      const command = resolveCommand(contribution, binding)
      for (const name of [
        command.descriptor.primaryName,
        ...command.descriptor.aliases,
      ]) {
        const existing = names.get(name)
        if (existing !== undefined) {
          throw new CommandPlanError(
            `Command name "${name}" is owned by both "${existing.descriptor.id}" and "${command.descriptor.id}".`
          )
        }
        names.set(name, command)
      }
      return command
    })
    this.#commands = Object.freeze(commands)
    this.#byName = names
    this.catalog = Object.freeze(commands.map(({ descriptor }) => descriptor))
    Object.freeze(this)
  }

  public analyze(
    input: string,
    completionSnapshot?: CommandCompletionSnapshot,
    routeProjection?: CommandRouteProjection
  ): CommandInputAnalysis {
    return this.#analyze(input, {
      final: false,
      ...(completionSnapshot === undefined ? {} : { completionSnapshot }),
      ...(routeProjection === undefined ? {} : { routeProjection }),
    })
  }

  public prepare(
    input: string,
    routeProjection?: CommandRouteProjection
  ): CommandInputAnalysis {
    return this.#analyze(input, {
      final: true,
      ...(routeProjection === undefined ? {} : { routeProjection }),
    })
  }

  public projectCatalog(
    routeProjection?: CommandRouteProjection
  ): readonly CommandDescriptor[] {
    if (routeProjection === undefined) return this.catalog
    return Object.freeze(
      this.catalog.map((command) =>
        projectCommandDescriptor(command, routeProjection)
      )
    )
  }

  public canExecute(
    invocation: PreparedCommandInvocation,
    state: { readonly threadBusy: boolean }
  ): boolean {
    this.resolvePrepared(invocation)
    return !state.threadBusy || invocation.availability === 'always'
  }

  public resolvePrepared(
    invocation: PreparedCommandInvocation
  ): ResolvedCommand {
    const command = this.#prepared.get(invocation)
    if (command === undefined || invocation.generation !== this.generation) {
      throw new CommandPlanError(
        'Command invocation was not prepared by this resolved generation.'
      )
    }
    return command
  }

  #analyze(input: string, options: AnalyzeOptions): CommandInputAnalysis {
    const tokenized = tokenize(input)
    if (tokenized.tokens.length === 0) {
      return analysis('not-command')
    }
    const commandToken = tokenized.tokens[0]!
    if (!commandToken.value.startsWith('/')) {
      return analysis('not-command')
    }
    const syntaxSpans = commandSyntaxSpans(tokenized.tokens, this.#byName)
    if (tokenized.diagnostic !== undefined) {
      return analysisWithDiagnostic('invalid', tokenized.diagnostic, {
        syntaxSpans,
      })
    }

    const exact = this.#byName.get(commandToken.value)
    if (exact === undefined) {
      const candidates = this.#nameCandidates(commandToken.value)
      const hints = candidates.map(({ name, command }) =>
        commandHint(
          name,
          command.descriptor.description,
          input,
          command.descriptor.usage
        )
      )
      if (
        !options.final &&
        candidates.length > 0 &&
        tokenized.tokens.length === 1 &&
        !tokenized.trailingWhitespace
      ) {
        return analysis('partial', {
          hints,
          completion: uniqueCompletion(hints),
          syntaxSpans,
        })
      }
      const diagnostic: CommandDiagnostic = {
        code: 'unknown-command',
        message: `Unknown command: ${commandToken.value}`,
      }
      const committed =
        options.final ||
        tokenized.trailingWhitespace ||
        tokenized.tokens.length > 1
      return analysisWithDiagnostic('unknown', diagnostic, {
        hints: committed ? [warningHint(diagnostic)] : hints,
        syntaxSpans,
      })
    }

    const descriptor = projectCommandDescriptor(
      exact.descriptor,
      options.routeProjection
    )
    const argumentTokens = tokenized.tokens.slice(1)
    const routeResult = parseRoute(descriptor, argumentTokens)
    const hints = routeHints(
      descriptor,
      commandToken.value,
      input,
      argumentTokens,
      tokenized.trailingWhitespace,
      options.completionSnapshot
    )
    if ('diagnostic' in routeResult) {
      if (!options.final && routePrefixExists(descriptor, argumentTokens)) {
        return analysis('partial', {
          hints,
          completion: uniqueCompletion(hints),
          syntaxSpans,
        })
      }
      const committed =
        options.final ||
        tokenized.trailingWhitespace ||
        argumentTokens.length > 1
      return analysisWithDiagnostic('invalid', routeResult.diagnostic, {
        hints: committed
          ? [...hints, warningHint(routeResult.diagnostic)]
          : hints,
        completion: uniqueCompletion(hints),
        syntaxSpans,
      })
    }

    const invocation = freezeImmutableData({
      generation: this.generation,
      commandId: descriptor.id,
      primaryName: descriptor.primaryName,
      invokedName: commandToken.value,
      routeId: routeResult.route.id,
      availability: routeResult.route.availability,
      arguments: routeResult.arguments,
    })
    this.#prepared.set(invocation, exact)
    return analysis('ready', {
      invocation,
      hints:
        argumentTokens.length === 0 && !tokenized.trailingWhitespace
          ? [
              commandHint(
                commandToken.value,
                exact.descriptor.description,
                input,
                exact.descriptor.usage
              ),
            ]
          : hints,
      completion: uniqueCompletion(hints),
      syntaxSpans,
    })
  }

  #nameCandidates(prefix: string): readonly {
    readonly name: CommandName
    readonly command: ResolvedCommand
  }[] {
    const candidates: Array<{
      readonly name: CommandName
      readonly command: ResolvedCommand
    }> = []
    for (const command of this.#commands) {
      for (const name of [
        command.descriptor.primaryName,
        ...command.descriptor.aliases,
      ]) {
        if (name.startsWith(prefix)) candidates.push({ name, command })
      }
    }
    return candidates
  }
}

function projectCommandDescriptor(
  command: CommandDescriptor,
  projection: CommandRouteProjection | undefined
): CommandDescriptor {
  if (projection === undefined) return command
  const routes = command.routes.filter((route) =>
    projection.isRouteEnabled(command.id, route.id)
  )
  if (routes.length === command.routes.length) return command
  return Object.freeze({
    ...command,
    routes: Object.freeze(routes),
  })
}

function resolveCommand(
  contribution: ResolvedContribution<CommandContribution>,
  binding: ResolvedExecutableBinding<CommandHandler>
): ResolvedCommand {
  return Object.freeze({
    descriptor: contribution.value,
    owner: contribution.owner,
    resolvedIndex: contribution.resolvedIndex,
    requiredServices: contribution.requiredServices,
    requiredCapabilities: contribution.requiredCapabilities,
    handler: binding.binding,
  })
}

function parseCommandContribution(value: unknown): CommandContribution {
  const object = plainObject(value, 'Command contribution', [
    'id',
    'primaryName',
    'aliases',
    'usage',
    'description',
    'routes',
  ])
  const id = requiredString(object, 'id', 'Command contribution')
  const primaryName = commandName(
    requiredString(object, 'primaryName', `Command "${id}"`)
  )
  const aliases = stringArray(object.aliases, `Command "${id}" aliases`).map(
    commandName
  )
  if (new Set([primaryName, ...aliases]).size !== aliases.length + 1) {
    throw new TypeError(`Command "${id}" repeats a primary name or alias.`)
  }
  const routes = arrayValue(object.routes, `Command "${id}" routes`).map(
    (route, index) => parseRouteSpec(route, id, index)
  )
  if (routes.length === 0) {
    throw new TypeError(`Command "${id}" must define at least one route.`)
  }
  const routeIds = new Set<string>()
  const routePaths = new Set<string>()
  for (const route of routes) {
    if (routeIds.has(route.id)) {
      throw new TypeError(`Command "${id}" repeats route ID "${route.id}".`)
    }
    const pathKey = route.path.join('\u0000')
    if (routePaths.has(pathKey)) {
      throw new TypeError(
        `Command "${id}" repeats route path "${route.path.join(' ')}".`
      )
    }
    routeIds.add(route.id)
    routePaths.add(pathKey)
  }
  return {
    id,
    primaryName,
    aliases,
    usage: requiredString(object, 'usage', `Command "${id}"`),
    description: requiredString(object, 'description', `Command "${id}"`),
    routes,
  }
}

function parseRouteSpec(
  value: unknown,
  commandId: string,
  index: number
): CommandRouteSpec {
  const label = `Command "${commandId}" route ${index}`
  const object = plainObject(value, label, [
    'id',
    'path',
    'availability',
    'positionals',
    'options',
    'constraints',
    'help',
  ])
  const id = stableSegment(requiredString(object, 'id', label), `${label} ID`)
  const path = stringArray(object.path, `${label} path`).map((part) =>
    stableSegment(part, `${label} path`)
  )
  const availability = requiredString(object, 'availability', label)
  if (availability !== 'always' && availability !== 'thread-idle') {
    throw new TypeError(`${label} has invalid availability.`)
  }
  const positionals = arrayValue(
    object.positionals,
    `${label} positionals`
  ).map((item, itemIndex) => parsePositional(item, label, itemIndex))
  validatePositionalOrder(positionals, label)
  const positionalNames = new Set(positionals.map(({ name }) => name))
  if (positionalNames.size !== positionals.length) {
    throw new TypeError(`${label} repeats a positional name.`)
  }
  for (const positional of positionals) {
    for (const dependency of positional.completion?.dependsOn ?? []) {
      if (!positionalNames.has(dependency)) {
        throw new TypeError(
          `${label} completion depends on unknown positional "${dependency}".`
        )
      }
    }
  }
  const options = arrayValue(object.options, `${label} options`).map(
    (item, itemIndex) => parseOption(item, label, itemIndex)
  )
  if (new Set(options.map(({ name }) => name)).size !== options.length) {
    throw new TypeError(`${label} repeats an option name.`)
  }
  const constraints = arrayValue(
    object.constraints,
    `${label} constraints`
  ).map((item, itemIndex) =>
    parseRouteConstraint(item, label, itemIndex, positionals, options)
  )
  const help = arrayValue(object.help, `${label} help`).map((item) => {
    const row = plainObject(item, `${label} help row`, ['usage', 'description'])
    return {
      usage: requiredString(row, 'usage', `${label} help row`),
      description: requiredString(row, 'description', `${label} help row`),
    }
  })
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

function parseRouteConstraint(
  value: unknown,
  routeLabel: string,
  index: number,
  positionals: readonly CommandPositionalSpec[],
  options: readonly { readonly name: string }[]
): CommandRouteConstraint {
  const label = `${routeLabel} constraint ${index}`
  const object = plainObject(value, label, ['kind', 'option', 'positional'])
  const kind = requiredString(object, 'kind', label)
  if (
    kind !== 'option-requires-single-positional' &&
    kind !== 'option-forbids-http-url-positional'
  ) {
    throw new TypeError(`${label} has an invalid kind.`)
  }
  const option = requiredString(object, 'option', label)
  const positional = requiredString(object, 'positional', label)
  if (!options.some((candidate) => candidate.name === option)) {
    throw new TypeError(`${label} references unknown option "${option}".`)
  }
  if (!positionals.some((candidate) => candidate.name === positional)) {
    throw new TypeError(
      `${label} references unknown positional "${positional}".`
    )
  }
  return { kind, option, positional }
}

function parsePositional(
  value: unknown,
  routeLabel: string,
  index: number
): CommandPositionalSpec {
  const label = `${routeLabel} positional ${index}`
  const object = plainObject(
    value,
    label,
    ['name', 'cardinality'],
    ['completion']
  )
  const cardinality = requiredString(object, 'cardinality', label)
  if (
    cardinality !== 'required' &&
    cardinality !== 'optional' &&
    cardinality !== 'one-or-more' &&
    cardinality !== 'zero-or-more'
  ) {
    throw new TypeError(`${label} has invalid cardinality.`)
  }
  const completionValue = object.completion
  const completion =
    completionValue === undefined
      ? undefined
      : (() => {
          const completionObject = plainObject(
            completionValue,
            `${label} completion`,
            ['sourceId', 'dependsOn']
          )
          return {
            sourceId: stableId(
              requiredString(
                completionObject,
                'sourceId',
                `${label} completion`
              ),
              `${label} completion source`
            ),
            dependsOn: stringArray(
              completionObject.dependsOn,
              `${label} completion dependencies`
            ).map((dependency) =>
              stableSegment(dependency, `${label} completion dependency`)
            ),
          }
        })()
  return {
    name: stableSegment(requiredString(object, 'name', label), `${label} name`),
    cardinality,
    ...(completion === undefined ? {} : { completion }),
  }
}

function parseOption(value: unknown, routeLabel: string, index: number) {
  const label = `${routeLabel} option ${index}`
  const object = plainObject(value, label, ['name', 'valueName'])
  const name = requiredString(object, 'name', label)
  if (!/^--[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new TypeError(`${label} name is invalid.`)
  }
  return {
    name,
    valueName: stableSegment(
      requiredString(object, 'valueName', label),
      `${label} value name`
    ),
  }
}

function validatePositionalOrder(
  positionals: readonly { readonly cardinality: string }[],
  label: string
): void {
  let optional = false
  for (const [index, positional] of positionals.entries()) {
    if (
      positional.cardinality === 'one-or-more' ||
      positional.cardinality === 'zero-or-more'
    ) {
      if (index !== positionals.length - 1) {
        throw new TypeError(`${label} variadic positional must be last.`)
      }
      optional = true
      continue
    }
    if (positional.cardinality === 'optional') {
      optional = true
    } else if (optional) {
      throw new TypeError(
        `${label} cannot require an argument after an optional one.`
      )
    }
  }
}

function parseRoute(
  command: CommandDescriptor,
  tokens: readonly Token[]
): RouteParseSuccess | RouteParseFailure {
  const matching = command.routes
    .filter((route) =>
      route.path.every((part, index) => tokens[index]?.value === part)
    )
    .sort((left, right) => right.path.length - left.path.length)
  const route = matching[0]
  if (route === undefined) {
    return {
      diagnostic: {
        code: 'unknown-route',
        message: `Unknown command route for ${command.primaryName}.`,
      },
    }
  }
  const remaining = tokens.slice(route.path.length)
  const projection = projectRouteTokens(command.primaryName, route, remaining)
  if (projection.diagnostic !== undefined) {
    return { diagnostic: projection.diagnostic }
  }
  const positionalTokens = projection.positionalTokens.map(({ value }) => value)
  const optionValues = projection.optionValues

  const positionals: Record<string, string | readonly string[] | null> = {}
  let positionalIndex = 0
  for (const spec of route.positionals) {
    if (
      spec.cardinality === 'one-or-more' ||
      spec.cardinality === 'zero-or-more'
    ) {
      const values = positionalTokens.slice(positionalIndex)
      if (spec.cardinality === 'one-or-more' && values.length === 0) {
        return {
          diagnostic: {
            code: 'missing-argument',
            message: `Missing argument <${spec.name}> for ${command.primaryName}.`,
          },
        }
      }
      positionals[spec.name] = values
      positionalIndex = positionalTokens.length
      continue
    }
    const value = positionalTokens[positionalIndex]
    if (value === undefined && spec.cardinality === 'required') {
      return {
        diagnostic: {
          code: 'missing-argument',
          message: `Missing argument <${spec.name}> for ${command.primaryName}.`,
        },
      }
    }
    positionals[spec.name] = value ?? null
    if (value !== undefined) positionalIndex += 1
  }
  if (positionalIndex < positionalTokens.length) {
    return {
      diagnostic: {
        code: 'too-many-arguments',
        message: `Too many arguments for ${command.primaryName}.`,
      },
    }
  }
  const constraintFailure = validateRouteConstraints(
    route,
    positionals,
    optionValues,
    command.primaryName
  )
  if (constraintFailure !== null) return constraintFailure
  return {
    route,
    arguments: freezeImmutableData({
      positionals,
      options: optionValues,
    }),
  }
}

function validateRouteConstraints(
  route: CommandRouteSpec,
  positionals: Readonly<Record<string, string | readonly string[] | null>>,
  options: Readonly<Record<string, string | null>>,
  commandName: string
): RouteParseFailure | null {
  for (const constraint of route.constraints) {
    if (options[constraint.option] === null) continue
    const value = positionals[constraint.positional]
    const values: readonly string[] =
      value === null || value === undefined
        ? []
        : typeof value === 'string'
          ? [value]
          : value
    if (
      constraint.kind === 'option-requires-single-positional' &&
      values.length !== 1
    ) {
      return {
        diagnostic: {
          code: 'constraint-failed',
          message: `${constraint.option} requires one ${constraint.positional} for ${commandName}.`,
        },
      }
    }
    if (
      constraint.kind === 'option-forbids-http-url-positional' &&
      values.some((item) => /^https?:\/\//i.test(item))
    ) {
      return {
        diagnostic: {
          code: 'constraint-failed',
          message: `${constraint.option} requires a name, not a URL.`,
        },
      }
    }
  }
  return null
}

function routePrefixExists(
  command: CommandDescriptor,
  tokens: readonly Token[]
): boolean {
  if (tokens.length === 0) return true
  return command.routes.some((route) => {
    if (route.path.length === 0 || tokens.length > route.path.length) {
      return false
    }
    const relevant = tokens.slice(0, Math.min(tokens.length, route.path.length))
    return relevant.every((token, index) => {
      const expected = route.path[index]
      return expected !== undefined && expected.startsWith(token.value)
    })
  })
}

function routeHints(
  command: CommandDescriptor,
  invokedName: CommandName,
  input: string,
  tokens: readonly Token[],
  trailingWhitespace: boolean,
  snapshot: CommandCompletionSnapshot | undefined
): readonly CommandHint[] {
  const completedCount = trailingWhitespace
    ? tokens.length
    : Math.max(0, tokens.length - 1)
  const activeToken = trailingWhitespace ? null : (tokens.at(-1) ?? null)
  const hints: CommandHint[] = []
  const completed = tokens.slice(0, completedCount)
  const incompleteRoutes = command.routes.filter((route) => {
    if (completedCount >= route.path.length) return false
    if (!completed.every((token, index) => route.path[index] === token.value)) {
      return false
    }
    return route.path[completedCount]!.startsWith(activeToken?.value ?? '')
  })
  if (incompleteRoutes.length > 0) {
    const seen = new Set<string>()
    for (const route of incompleteRoutes) {
      const expected = route.path[completedCount]!
      if (seen.has(expected)) continue
      seen.add(expected)
      hints.push({
        usage: expected,
        description: route.help[0]?.description ?? '',
        kind: 'command',
        completion: replaceActiveToken(input, activeToken, expected),
      })
    }
    return deduplicateHints(hints)
  }

  const matchingRoutes = command.routes
    .filter((route) =>
      route.path.every((part, index) => tokens[index]?.value === part)
    )
    .sort((left, right) => right.path.length - left.path.length)
  const route = matchingRoutes[0]
  if (route === undefined) return Object.freeze([])
  if (
    route.path.length === 0 &&
    tokens.length > 0 &&
    route.positionals.length === 0
  ) {
    return Object.freeze([])
  }

  if (route.help.length === 0 && route.path.length === 0) {
    hints.push(
      commandHint(invokedName, command.description, input, command.usage)
    )
  } else {
    for (const help of route.help) {
      hints.push({
        usage: `${invokedName} ${help.usage}`,
        description: help.description,
        kind: 'command',
      })
    }
  }

  const projection = projectRouteTokens(
    command.primaryName,
    route,
    tokens.slice(route.path.length)
  )
  const activePositionalIndex =
    activeToken === null
      ? projection.positionalTokens.length
      : projection.positionalTokens.indexOf(activeToken)
  const positionalIndex = positionalSpecIndex(
    route.positionals,
    activePositionalIndex
  )
  const positional =
    positionalIndex === null ? undefined : route.positionals[positionalIndex]
  if (
    projection.diagnostic === undefined &&
    activePositionalIndex >= 0 &&
    positionalIndex !== null &&
    positional?.completion !== undefined &&
    snapshot !== undefined
  ) {
    const dependencies = positionalDependencies(
      route,
      projection.positionalTokens,
      positional.completion.dependsOn
    )
    const entry = findCompletionEntry(
      snapshot.entries,
      positional.completion.sourceId,
      dependencies
    )
    const prefix = activeToken?.value ?? ''
    for (const candidate of entry?.candidates ?? []) {
      if (!candidate.value.startsWith(prefix)) continue
      hints.push({
        usage: candidate.value,
        description: candidate.description,
        kind: 'detail',
        completion: replaceActiveToken(
          input,
          activeToken,
          candidate.value,
          positional.cardinality !== 'optional' ||
            positionalIndex < route.positionals.length - 1
        ),
      })
    }
  }
  return deduplicateHints(hints)
}

function positionalDependencies(
  route: CommandRouteSpec,
  positionalTokens: readonly Token[],
  names: readonly string[]
): Readonly<Record<string, string>> {
  const values: Record<string, string> = {}
  for (const name of names) {
    const index = route.positionals.findIndex((item) => item.name === name)
    const value = positionalTokens[index]?.value
    if (value !== undefined) values[name] = value
  }
  return values
}

function projectRouteTokens(
  commandName: string,
  route: CommandRouteSpec,
  tokens: readonly Token[]
): RouteTokenProjection {
  const optionSpecs = new Map(
    route.options.map((option) => [option.name, option])
  )
  const optionValues: Record<string, string | null> = Object.fromEntries(
    route.options.map(({ name }) => [name, null])
  )
  const positionalTokens: Token[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (!token.value.startsWith('--')) {
      positionalTokens.push(token)
      continue
    }
    const option = optionSpecs.get(token.value)
    if (option === undefined) {
      return {
        positionalTokens,
        optionValues,
        diagnostic: {
          code: 'unknown-option',
          message: `Unknown option for ${commandName}: ${token.value}`,
        },
      }
    }
    if (optionValues[option.name] !== null) {
      return {
        positionalTokens,
        optionValues,
        diagnostic: {
          code: 'duplicate-option',
          message: `Duplicate option: ${option.name}`,
        },
      }
    }
    const value = tokens[index + 1]?.value
    if (value === undefined || value.startsWith('--')) {
      return {
        positionalTokens,
        optionValues,
        diagnostic: {
          code: 'missing-option-value',
          message: `${option.name} requires ${option.valueName}.`,
        },
      }
    }
    optionValues[option.name] = value
    index += 1
  }
  return { positionalTokens, optionValues }
}

function positionalSpecIndex(
  positionals: readonly CommandPositionalSpec[],
  tokenIndex: number
): number | null {
  if (tokenIndex < 0) return null
  for (let index = 0; index < positionals.length; index += 1) {
    const positional = positionals[index]!
    if (
      positional.cardinality === 'one-or-more' ||
      positional.cardinality === 'zero-or-more'
    ) {
      return index
    }
    if (index === tokenIndex) return index
  }
  return null
}

function findCompletionEntry(
  entries: readonly CommandCompletionEntry[],
  sourceId: string,
  dependencies: Readonly<Record<string, string>>
): CommandCompletionEntry | undefined {
  return entries.find(
    (entry) =>
      entry.sourceId === sourceId &&
      sameRecord(entry.dependencies, dependencies)
  )
}

function sameRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
): boolean {
  const leftKeys = Object.keys(left).sort(compareAscii)
  const rightKeys = Object.keys(right).sort(compareAscii)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && left[key] === right[key]
    )
  )
}

function commandSyntaxSpans(
  tokens: readonly Token[],
  commands: ReadonlyMap<CommandName, ResolvedCommand>
): readonly CommandSyntaxSpan[] {
  const first = tokens[0]
  if (first === undefined) return []
  const command = commands.get(first.value)
  if (command === undefined) return []
  const spans: CommandSyntaxSpan[] = [
    { start: first.start, end: first.end, kind: 'command' },
  ]
  const arguments_ = tokens.slice(1)
  const route = command.descriptor.routes
    .filter((candidate) =>
      candidate.path.every((part, index) => arguments_[index]?.value === part)
    )
    .sort((left, right) => right.path.length - left.path.length)[0]
  if (route !== undefined) {
    for (let index = 0; index < route.path.length; index += 1) {
      const token = arguments_[index]
      if (token !== undefined) {
        spans.push({ start: token.start, end: token.end, kind: 'command' })
      }
    }
  }
  return Object.freeze(spans.map((span) => Object.freeze(span)))
}

function commandHint(
  name: CommandName,
  description: string,
  input: string,
  usage = name
): CommandHint {
  return {
    usage,
    description,
    kind: 'command',
    ...(input.trimEnd() === name ? {} : { completion: `${name} ` }),
  }
}

function warningHint(diagnostic: CommandDiagnostic): CommandHint {
  return {
    usage: diagnostic.message,
    description: '',
    kind: 'warning',
  }
}

function replaceActiveToken(
  input: string,
  token: Token | null,
  value: string,
  appendSpace = true
): string {
  const suffix = appendSpace ? ' ' : ''
  if (token === null) return `${input}${value}${suffix}`
  return `${input.slice(0, token.start)}${value}${suffix}`
}

function uniqueCompletion(hints: readonly CommandHint[]): string | null {
  const values = [
    ...new Set(
      hints.flatMap((hint) =>
        hint.completion === undefined ? [] : [hint.completion]
      )
    ),
  ]
  return values.length === 1 ? values[0]! : null
}

function deduplicateHints(
  hints: readonly CommandHint[]
): readonly CommandHint[] {
  const seen = new Set<string>()
  return Object.freeze(
    hints
      .filter((hint) => {
        const key = `${hint.kind}\u0000${hint.usage}\u0000${hint.description}\u0000${hint.completion ?? ''}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .map((hint) => Object.freeze(hint))
  )
}

function tokenize(input: string): TokenizationResult {
  const tokens: Token[] = []
  let current = ''
  let start = -1
  let quote: 'single' | 'double' | null = null
  let preserveQuote = false
  let started = false
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!
    if (quote !== null) {
      const quoteCharacter = quote === 'single' ? "'" : '"'
      if (character === quoteCharacter) {
        if (preserveQuote) current += character
        quote = null
        preserveQuote = false
        continue
      }
      if (
        quote === 'double' &&
        character === '\\' &&
        (input[index + 1] === '"' || input[index + 1] === '\\')
      ) {
        current += input[index + 1]
        index += 1
        continue
      }
      current += character
      continue
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push({ value: current, start, end: index })
        current = ''
        start = -1
        started = false
      }
      continue
    }
    if (start < 0) start = index
    if (character === "'" || character === '"') {
      preserveQuote = started
      if (preserveQuote) current += character
      quote = character === "'" ? 'single' : 'double'
      started = true
      continue
    }
    current += character
    started = true
  }
  if (started) tokens.push({ value: current, start, end: input.length })
  return {
    tokens,
    trailingWhitespace: input.length > 0 && /\s/.test(input.at(-1)!),
    ...(quote === null
      ? {}
      : {
          diagnostic: {
            code: 'unterminated-quote' as const,
            message: 'Unterminated quote in command input.',
          },
        }),
  }
}

function analysis(
  kind: 'not-command' | 'partial' | 'ready',
  fields: Partial<{
    readonly hints: readonly CommandHint[]
    readonly completion: string | null
    readonly syntaxSpans: readonly CommandSyntaxSpan[]
    readonly invocation: PreparedCommandInvocation
  }> = {}
): CommandInputAnalysis {
  const base = {
    kind,
    hints: [],
    completion: null,
    syntaxSpans: [],
    ...fields,
  }
  if (kind === 'ready') {
    if (base.invocation === undefined) {
      throw new CommandPlanError(
        'Ready command analysis requires an invocation.'
      )
    }
    return freezeImmutableData({ ...base, kind, invocation: base.invocation })
  }
  return freezeImmutableData({ ...base, kind })
}

function analysisWithDiagnostic(
  kind: 'unknown' | 'invalid',
  diagnostic: CommandDiagnostic,
  fields: Partial<{
    readonly hints: readonly CommandHint[]
    readonly completion: string | null
    readonly syntaxSpans: readonly CommandSyntaxSpan[]
  }> = {}
): CommandInputAnalysis {
  return freezeImmutableData({
    kind,
    diagnostic,
    hints: [],
    completion: null,
    syntaxSpans: [],
    ...fields,
  })
}

function plainObject(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object.`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const allowed = new Set([...required, ...optional])
  const keys = Reflect.ownKeys(descriptors)
  if (
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        !allowed.has(key) ||
        descriptors[key] === undefined ||
        !('value' in descriptors[key])
    ) ||
    required.some((key) => !Object.hasOwn(descriptors, key))
  ) {
    throw new TypeError(`${label} has missing or unexpected fields.`)
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      'value' in descriptor ? descriptor.value : undefined,
    ])
  )
}

function requiredString(
  object: Record<string, unknown>,
  key: string,
  label: string
): string {
  const value = object[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} field "${key}" must be a non-empty string.`)
  }
  return value
}

function arrayValue(value: unknown, label: string): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new TypeError(`${label} must be an array.`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue
    if (
      typeof key !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(key) ||
      descriptors[key] === undefined ||
      !('value' in descriptors[key])
    ) {
      throw new TypeError(`${label} must contain only indexed data properties.`)
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(descriptors, String(index))) {
      throw new TypeError(`${label} must not contain array holes.`)
    }
  }
  return value
}

function stringArray(value: unknown, label: string): string[] {
  return arrayValue(value, label).map((item) => {
    if (typeof item !== 'string')
      throw new TypeError(`${label} must contain strings.`)
    return item
  })
}

function commandName(value: string): CommandName {
  if (!/^\/[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new TypeError(`Invalid command name: ${value}`)
  }
  return value
}

function stableSegment(value: string, label: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new TypeError(
      `${label} must use lowercase letters, numbers, or hyphens.`
    )
  }
  return value
}

function stableId(value: string, label: string): string {
  if (!/^[a-z0-9][a-z0-9._:/-]*$/.test(value)) {
    throw new TypeError(`${label} is invalid.`)
  }
  return value
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
