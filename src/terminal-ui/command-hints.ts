import type {
  CliCommand,
  CliCommandGuide,
} from '../cli-commands/core/command-types.ts'
import type { ProviderId } from '../providers/provider-id.ts'
import {
  listProviderModelOptions,
  listProviderModels,
} from '../providers/provider-model-catalog.ts'
import type { InputHint } from './input-hints.ts'

export function resolveCommandHints(
  value: string,
  commands: readonly CliCommand[],
  providers: readonly ProviderId[]
): readonly InputHint[] {
  if (value.includes('\n')) {
    return []
  }

  const input = value.trimStart()
  if (!input.startsWith('/')) {
    return []
  }

  const trailingWhitespace = /\s$/.test(input)
  const tokens = input.trimEnd().split(/\s+/)
  const commandToken = tokens[0] ?? ''
  const commandMatches = commands.filter(({ name }) =>
    name.startsWith(commandToken)
  )
  const exactCommand = commandMatches.find(({ name }) => name === commandToken)

  if (exactCommand === undefined) {
    if (commandMatches.length > 0) {
      return tokens.length === 1 && !trailingWhitespace
        ? commandMatches.map((command) => commandHint(command, input))
        : [warningHint(`Unknown command: ${commandToken}`)]
    }
    return trailingWhitespace || tokens.length > 1
      ? [warningHint(`Unknown command: ${commandToken}`)]
      : []
  }

  if (tokens.length === 1 && !trailingWhitespace) {
    return [commandHint(exactCommand, input)]
  }

  if (exactCommand.guides === undefined || exactCommand.guides.length === 0) {
    return [commandHint(exactCommand, input)]
  }

  const pathInput = tokens.slice(1)
  const guideMatches = exactCommand.guides.filter((guide) =>
    guideMatchesInput(guide, pathInput, trailingWhitespace)
  )
  if (guideMatches.length === 0) {
    return hasCompletedInvalidPathToken(
      exactCommand.guides,
      pathInput,
      trailingWhitespace
    )
      ? [warningHint(`Unknown subcommand for ${exactCommand.name}.`)]
      : []
  }

  const exactGuides = guideMatches.filter((guide) =>
    guidePathIsComplete(guide, pathInput, trailingWhitespace)
  )
  if (exactGuides.length > 0) {
    const longestPath = Math.max(...exactGuides.map(({ path }) => path.length))
    const details = exactGuides
      .filter(({ path }) => path.length === longestPath)
      .map((guide) => guideHint(exactCommand, guide, true, input))
    return appendProviderHint(
      details,
      exactCommand,
      pathInput,
      trailingWhitespace,
      providers
    )
  }

  return candidateGuideHints(
    exactCommand,
    guideMatches,
    pathInput,
    trailingWhitespace,
    input
  )
}

function hasCompletedInvalidPathToken(
  guides: readonly CliCommandGuide[],
  input: readonly string[],
  trailingWhitespace: boolean
): boolean {
  if (trailingWhitespace) {
    return true
  }

  for (let index = 0; index < input.length - 1; index += 1) {
    const prefix = input.slice(0, index)
    const token = input[index]!
    const tokenCanMatch = guides.some(
      ({ path }) =>
        prefix.every((part, partIndex) => path[partIndex] === part) &&
        path[index] === token
    )
    if (!tokenCanMatch) {
      return true
    }
  }
  return false
}

function commandHint(command: CliCommand, input: string): InputHint {
  return withCompletion(
    {
      usage: command.usage ?? command.name,
      description: command.description,
      kind: 'command',
    },
    `${command.name} `,
    input
  )
}

function guideHint(
  command: CliCommand,
  guide: CliCommandGuide,
  includeCommand: boolean,
  input: string
): InputHint {
  const hint: InputHint = {
    usage: includeCommand ? `${command.name} ${guide.usage}` : guide.usage,
    description: guide.description,
    kind: 'command',
  }
  return includeCommand
    ? hint
    : withCompletion(hint, `${command.name} ${guide.path.join(' ')} `, input)
}

function withCompletion(
  hint: InputHint,
  completion: string,
  input: string
): InputHint {
  return completion === input ? hint : { ...hint, completion }
}

function warningHint(message: string): InputHint {
  return { usage: message, description: '', kind: 'warning' }
}

function guideMatchesInput(
  guide: CliCommandGuide,
  input: readonly string[],
  trailingWhitespace: boolean
): boolean {
  const comparedLength = Math.min(guide.path.length, input.length)
  for (let index = 0; index < comparedLength; index += 1) {
    const expected = guide.path[index]!
    const actual = input[index]!
    const isPartialToken = index === input.length - 1 && !trailingWhitespace
    if (isPartialToken ? !expected.startsWith(actual) : expected !== actual) {
      return false
    }
  }
  return (
    input.length <= guide.path.length || comparedLength === guide.path.length
  )
}

function guidePathIsComplete(
  guide: CliCommandGuide,
  input: readonly string[],
  trailingWhitespace: boolean
): boolean {
  if (input.length < guide.path.length) {
    return false
  }
  if (!guide.path.every((token, index) => input[index] === token)) {
    return false
  }
  return input.length > guide.path.length || trailingWhitespace
}

function candidateGuideHints(
  command: CliCommand,
  guides: readonly CliCommandGuide[],
  input: readonly string[],
  trailingWhitespace: boolean,
  fullInput: string
): readonly InputHint[] {
  const depth = trailingWhitespace
    ? input.length
    : Math.max(0, input.length - 1)
  const groups = new Map<string, CliCommandGuide[]>()
  for (const guide of guides) {
    const key = guide.path[depth]
    if (key === undefined) {
      continue
    }
    const group = groups.get(key)
    if (group === undefined) {
      groups.set(key, [guide])
    } else {
      group.push(guide)
    }
  }

  return [...groups.values()].map((group) => {
    const guide = group[0]!
    const paths = new Set(group.map(({ path }) => path.join('\u0000')))
    if (group.length === 1) {
      return guideHint(command, guide, false, fullInput)
    }
    if (paths.size > 1) {
      const children = [
        ...new Set(
          group
            .map(({ path }) => path[depth + 1])
            .filter((token): token is string => token !== undefined)
        ),
      ]
      return withCompletion(
        {
          usage: `${guide.path.slice(0, depth + 1).join(' ')}${
            children.length > 0 ? ` <${children.join('|')}>` : ''
          }`,
          description: '',
          kind: 'command',
        },
        `${command.name} ${guide.path.slice(0, depth + 1).join(' ')} `,
        fullInput
      )
    }
    return withCompletion(
      {
        usage: guide.path.join(' '),
        description: guide.description,
        kind: 'command',
      },
      `${command.name} ${guide.path.join(' ')} `,
      fullInput
    )
  })
}

function appendProviderHint(
  hints: readonly InputHint[],
  command: CliCommand,
  pathInput: readonly string[],
  trailingWhitespace: boolean,
  providers: readonly ProviderId[]
): readonly InputHint[] {
  const subcommand = pathInput[0]
  if (
    command.name !== '/thread' ||
    (subcommand !== 'agent' && subcommand !== 'chat')
  ) {
    return hints
  }

  const providerInput = pathInput[1]
  if (providerInput === undefined) {
    return [...hints, ...providerHints(subcommand, providers)]
  }

  const providerMatches = providers.filter((provider) =>
    provider.startsWith(providerInput)
  )
  const provider = providers.find((candidate) => candidate === providerInput)
  if (!trailingWhitespace && pathInput.length === 2) {
    return providerMatches.length > 0
      ? [...hints, ...providerHints(subcommand, providerMatches)]
      : hints
  }

  if (pathInput.length === 2 && trailingWhitespace && provider !== undefined) {
    const models = listProviderModels(provider)
    return [...hints, ...modelHints(subcommand, provider, models)]
  }

  if (pathInput.length >= 3 && provider !== undefined) {
    const modelInput = pathInput[2] ?? ''
    const modelMatches = listProviderModels(provider).filter((model) =>
      model.startsWith(modelInput.toLowerCase())
    )
    if (!trailingWhitespace && pathInput.length === 3) {
      return [...hints, ...modelHints(subcommand, provider, modelMatches)]
    }
    if (pathInput.length === 3 && trailingWhitespace) {
      const model = listProviderModels(provider).find(
        (candidate) => candidate === modelInput.toLowerCase()
      )
      if (model === undefined) return hints
      const options = listProviderModelOptions(provider, model)
      return options.length === 0
        ? [
            ...hints,
            {
              usage: 'option-key: none',
              description: '',
              kind: 'detail',
            },
          ]
        : [...hints, ...optionHints(subcommand, provider, model, options)]
    }
    if (pathInput.length === 4) {
      const optionInput = pathInput[3] ?? ''
      const model = listProviderModels(provider).find(
        (candidate) => candidate === modelInput.toLowerCase()
      )
      if (model === undefined) return hints
      const options = listProviderModelOptions(provider, model).filter(
        (option) => option.startsWith(optionInput.toLowerCase())
      )
      return options.length > 0
        ? [...hints, ...optionHints(subcommand, provider, model, options)]
        : hints
    }
  }
  return hints
}

function providerHints(
  subcommand: 'agent' | 'chat',
  providers: readonly ProviderId[]
): readonly InputHint[] {
  return providers.map((provider) => ({
    usage: provider,
    description: '',
    kind: 'detail' as const,
    completion: `/thread ${subcommand} ${provider} `,
  }))
}

function modelHints(
  subcommand: 'agent' | 'chat',
  provider: ProviderId,
  models: readonly string[]
): readonly InputHint[] {
  return models.map((model) => ({
    usage: model,
    description: '',
    kind: 'detail' as const,
    completion: `/thread ${subcommand} ${provider} ${model} `,
  }))
}

function optionHints(
  subcommand: 'agent' | 'chat',
  provider: ProviderId,
  model: string,
  options: readonly string[]
): readonly InputHint[] {
  return options.map((option) => ({
    usage: option,
    description: '',
    kind: 'detail' as const,
    completion: `/thread ${subcommand} ${provider} ${model} ${option}`,
  }))
}
