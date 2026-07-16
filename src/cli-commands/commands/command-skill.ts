import { isAbortError } from '../../runtime/runtime-cancellation.ts'
import type {
  CliCommand,
  CliCommandContext,
  CommandResult,
} from '../core/command-types.ts'

const SKILL_SUBCOMMANDS = [
  'add',
  'list',
  'enable',
  'disable',
  'remove',
] as const

const SKILL_ADD_HELP = [
  {
    usage: 'add <local-directory>',
    description: 'Register a skill or skill collection from a local directory.',
  },
  {
    usage: 'add <url>',
    description: 'Download and install a skill or skill collection.',
  },
  {
    usage: 'add <name> --registry <url>',
    description: 'Download and install a named skill from a Hub registry.',
  },
] as const

const SKILL_HELP_ROWS = [
  ...SKILL_ADD_HELP,
  { usage: 'list', description: 'List registered skills.' },
  {
    usage: 'enable <name>',
    description: 'Enable a registered skill for new threads.',
  },
  {
    usage: 'disable <name>',
    description: 'Disable a registered skill for new threads.',
  },
  {
    usage: 'remove <name>',
    description: 'Remove a registered skill.',
  },
] as const

const MAX_DISPLAYED_REMOTE_SOURCE_LENGTH = 160

export const SkillCommand: CliCommand = {
  name: '/skill',
  usage: '/skill <subcommand>',
  description: 'Manage registered skills.',
  subcommands: SKILL_SUBCOMMANDS,
  async execute(context, args) {
    const [subcommand, ...subcommandArgs] = args
    if (subcommand === undefined) {
      renderSkillHelp(context)
      return { continue: true }
    }

    switch (subcommand) {
      case 'add':
        return await addSkill(context, subcommandArgs)
      case 'list':
        return await listSkills(context)
      case 'enable':
        return await enableSkill(context, subcommandArgs)
      case 'disable':
        return await disableSkill(context, subcommandArgs)
      case 'remove':
        return await removeSkill(context, subcommandArgs)
      default:
        context.ui.renderWarning('/skill', [
          `Unknown skill subcommand: ${subcommand}`,
          'Run /skill to see available subcommands.',
        ])
        return { continue: true }
    }
  },
}

function renderSkillHelp(context: CliCommandContext): void {
  const usageWidth = Math.max(
    ...SKILL_HELP_ROWS.map(({ usage }) => usage.length)
  )
  context.ui.renderInfo(
    '/skill',
    [
      'Subcommands:',
      ...SKILL_HELP_ROWS.map(
        ({ usage, description }) =>
          `  ${usage.padEnd(usageWidth)}  ${description}`
      ),
      '',
      'Manual trigger:',
      '  $<name> [task]  Use an enabled skill for the current turn.',
    ].join('\n')
  )
}

async function addSkill(
  context: CliCommandContext,
  args: readonly string[]
): Promise<CommandResult> {
  let parsed: ParsedSkillAddArgs
  try {
    parsed = parseSkillAddArgs(args)
  } catch (error) {
    context.ui.renderWarning('/skill add', [
      getErrorMessage(error),
      'Usage:',
      ...SKILL_ADD_HELP.map(({ usage }) => `  /skill ${usage}`),
    ])
    return { continue: true }
  }

  context.ui.setBusy(true)
  context.ui.renderInfo(
    '/skill add',
    describeSkillInstall(parsed.source, parsed.registryUrl)
  )
  try {
    const result = await context.addSkill(
      parsed.source,
      parsed.registryUrl === null
        ? undefined
        : { registryUrl: parsed.registryUrl }
    )
    context.ui.renderSuccess('/skill add', describeAddedSkills(result.skills))
    if (result.warnings.length > 0) {
      context.ui.renderWarning('/skill add', result.warnings)
    }
  } catch (error) {
    if (isAbortError(error)) {
      context.ui.renderWarning('/skill add', 'Skill installation cancelled.')
    } else {
      context.ui.renderError(
        '/skill add',
        error instanceof Error ? error.message : String(error)
      )
    }
  } finally {
    context.ui.setBusy(false)
  }
  return { continue: true }
}

function describeAddedSkills(
  skills: readonly { name: string; directory: string }[]
): string[] {
  if (skills.length === 1) {
    return [
      `Added and enabled ${skills[0]!.name}.`,
      `Path: ${skills[0]!.directory}`,
    ]
  }
  return [
    `Added and enabled ${skills.length} skills.`,
    ...skills.map(({ name, directory }) => `- ${name}: ${directory}`),
  ]
}

interface ParsedSkillAddArgs {
  source: string
  registryUrl: string | null
}

function parseSkillAddArgs(args: readonly string[]): ParsedSkillAddArgs {
  const sourceParts: string[] = []
  let registryUrl: string | null = null

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === '--registry') {
      if (registryUrl !== null) {
        throw new Error('Duplicate --registry option.')
      }
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--registry requires a URL.')
      }
      registryUrl = value
      index += 1
      continue
    }
    if (argument.startsWith('--')) {
      throw new Error(`Unknown skill add option: ${argument}`)
    }
    sourceParts.push(argument)
  }

  const source = sourceParts.join(' ').trim()
  if (source === '') {
    throw new Error('Missing skill source.')
  }
  if (registryUrl !== null && sourceParts.length !== 1) {
    throw new Error('--registry requires one skill name.')
  }
  if (registryUrl !== null && /^https?:\/\//i.test(source)) {
    throw new Error('--registry requires a skill name, not a URL.')
  }
  return { source, registryUrl }
}

function describeSkillInstall(
  source: string,
  registryUrl: string | null
): string[] {
  if (registryUrl !== null) {
    return [
      'Installing skill from Hub registry...',
      `Skill: ${source}`,
      `Registry: ${formatRemoteSource(registryUrl)}`,
      'Downloading, extracting, and validating may take time.',
      'Press Ctrl+C to cancel.',
    ]
  }
  if (!/^https?:\/\//i.test(source)) {
    return [
      'Adding skill from local directory...',
      `Source: ${source}`,
      'Validating and registering may take time.',
      'Press Ctrl+C to cancel.',
    ]
  }

  return [
    'Installing skill from remote source...',
    `Source: ${formatRemoteSource(source)}`,
    'Downloading, extracting, and validating may take time.',
    'Press Ctrl+C to cancel.',
  ]
}

function formatRemoteSource(source: string): string {
  let display = source.replace(/[?#][\s\S]*$/, '')
  try {
    const url = new URL(source)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    display = url.href
  } catch {
    // Non-URL sources are already sanitized by the fallback above.
  }

  if (display.length <= MAX_DISPLAYED_REMOTE_SOURCE_LENGTH) {
    return display
  }
  return `${display.slice(0, MAX_DISPLAYED_REMOTE_SOURCE_LENGTH - 3)}...`
}

async function listSkills(context: CliCommandContext): Promise<CommandResult> {
  context.ui.renderSkillList(await context.skillLibrary.list())
  return { continue: true }
}

async function enableSkill(
  context: CliCommandContext,
  args: readonly string[]
): Promise<CommandResult> {
  const name = args[0] ?? ''
  if (name === '') {
    context.ui.renderWarning('/skill enable', 'Usage: /skill enable <name>')
    return { continue: true }
  }
  try {
    if (!(await context.skillLibrary.enable(name))) {
      context.ui.renderWarning('/skill enable', `Unknown skill: ${name}`)
      return { continue: true }
    }
  } catch (error) {
    context.ui.renderError('/skill enable', getErrorMessage(error))
    return { continue: true }
  }
  context.ui.renderSuccess('/skill enable', `Enabled ${name} for new threads.`)
  return { continue: true }
}

async function disableSkill(
  context: CliCommandContext,
  args: readonly string[]
): Promise<CommandResult> {
  const name = args[0] ?? ''
  if (name === '') {
    context.ui.renderWarning('/skill disable', 'Usage: /skill disable <name>')
    return { continue: true }
  }
  try {
    if (!(await context.skillLibrary.disable(name))) {
      context.ui.renderWarning('/skill disable', `Unknown skill: ${name}`)
      return { continue: true }
    }
  } catch (error) {
    context.ui.renderError('/skill disable', getErrorMessage(error))
    return { continue: true }
  }
  context.ui.renderSuccess(
    '/skill disable',
    `Disabled ${name} for new threads.`
  )
  return { continue: true }
}

async function removeSkill(
  context: CliCommandContext,
  args: readonly string[]
): Promise<CommandResult> {
  const name = args[0] ?? ''
  if (name === '') {
    context.ui.renderWarning('/skill remove', 'Usage: /skill remove <name>')
    return { continue: true }
  }
  try {
    const result = await context.skillLibrary.remove(name)
    if (!result.removed) {
      context.ui.renderWarning('/skill remove', `Unknown skill: ${name}`)
      return { continue: true }
    }
    context.ui.renderSuccess('/skill remove', `Removed ${name}.`)
    if (result.warnings.length > 0) {
      context.ui.renderWarning('/skill remove', result.warnings)
    }
  } catch (error) {
    context.ui.renderError('/skill remove', getErrorMessage(error))
    return { continue: true }
  }
  return { continue: true }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
