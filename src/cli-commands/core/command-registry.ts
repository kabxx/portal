import type {
  CliCommand,
  CliCommandContext,
  CommandResult,
} from './command-types.ts'

export class CommandRegistry {
  private readonly commands = new Map<string, CliCommand>()
  private readonly primaryCommands: CliCommand[]

  public constructor(primaryCommands: readonly CliCommand[]) {
    this.primaryCommands = [...primaryCommands]
    for (const command of primaryCommands) {
      this.commands.set(command.name, command)
    }
  }

  public list(): readonly CliCommand[] {
    return this.primaryCommands
  }

  public find(name: string): CliCommand | null {
    return this.commands.get(name) ?? null
  }

  public async execute(
    input: string,
    context: CliCommandContext
  ): Promise<CommandResult | null> {
    const [commandName, ...args] = tokenizeCommandInput(input)
    if (!commandName) {
      return null
    }
    const command = this.find(commandName)
    if (command === null) {
      return null
    }
    return await command.execute(context, args)
  }
}

export function tokenizeCommandInput(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: 'single' | 'double' | null = null
  let preserveQuote = false
  let started = false

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!
    if (quote !== null) {
      const quoteCharacter = quote === 'single' ? "'" : '"'
      if (character === quoteCharacter) {
        if (preserveQuote) {
          current += character
        }
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
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    if (character === "'" || character === '"') {
      preserveQuote = started
      if (preserveQuote) {
        current += character
      }
      quote = character === "'" ? 'single' : 'double'
      started = true
      continue
    }
    current += character
    started = true
  }

  if (quote !== null) {
    throw new Error('Unterminated quote in command input')
  }
  if (started) {
    tokens.push(current)
  }
  return tokens
}
