import type {
  Capability,
  ContributionId,
  ExtensionId,
  ResourceScopeRegistration,
  ServiceAccessor,
  ServiceRef,
} from '../../extensions/extension-contracts.ts'

export type CommandName = string
export type CommandAvailability = 'always' | 'thread-idle'
export type CommandDisposition = 'continue' | 'request-stop'
export type CommandMessageLevel = 'info' | 'success' | 'warning' | 'error'
export type CommandMessageFormat = 'plain' | 'markdown'

export interface CommandResult {
  readonly disposition: CommandDisposition
}

export interface CommandHelpRow {
  readonly usage: string
  readonly description: string
}

export interface CommandCompletionSpec {
  readonly sourceId: string
  readonly dependsOn: readonly string[]
}

export interface CommandPositionalSpec {
  readonly name: string
  readonly cardinality: 'required' | 'optional' | 'one-or-more' | 'zero-or-more'
  readonly completion?: CommandCompletionSpec
}

export interface CommandOptionSpec {
  readonly name: string
  readonly valueName: string
}

export type CommandRouteConstraint =
  | {
      readonly kind: 'option-requires-single-positional'
      readonly option: string
      readonly positional: string
    }
  | {
      readonly kind: 'option-forbids-http-url-positional'
      readonly option: string
      readonly positional: string
    }

export interface CommandRouteSpec {
  readonly id: string
  readonly path: readonly string[]
  readonly availability: CommandAvailability
  readonly positionals: readonly CommandPositionalSpec[]
  readonly options: readonly CommandOptionSpec[]
  readonly constraints: readonly CommandRouteConstraint[]
  readonly help: readonly CommandHelpRow[]
}

export interface CommandRouteProjection {
  isRouteEnabled(commandId: ContributionId, routeId: string): boolean
}

export interface CommandContribution {
  readonly id: ContributionId
  readonly primaryName: CommandName
  readonly aliases: readonly CommandName[]
  readonly usage: string
  readonly description: string
  readonly routes: readonly CommandRouteSpec[]
}

export interface CommandDescriptor {
  readonly id: ContributionId
  readonly primaryName: CommandName
  readonly aliases: readonly CommandName[]
  readonly usage: string
  readonly description: string
  readonly routes: readonly CommandRouteSpec[]
}

export type CommandArgumentValue = string | readonly string[] | null

export interface PreparedCommandArguments {
  readonly positionals: Readonly<Record<string, CommandArgumentValue>>
  readonly options: Readonly<Record<string, string | null>>
}

export interface PreparedCommandInvocation {
  readonly generation: string
  readonly commandId: ContributionId
  readonly primaryName: CommandName
  readonly invokedName: CommandName
  readonly routeId: string
  readonly availability: CommandAvailability
  readonly arguments: PreparedCommandArguments
}

export interface CommandExecutionContext {
  readonly extensionId: ExtensionId
  readonly generation: string
  readonly executionId: string
  readonly signal: AbortSignal
  readonly deadline: number
  readonly scope: ResourceScopeRegistration
  readonly services: ServiceAccessor
}

export type CommandHandler = (
  invocation: Readonly<PreparedCommandInvocation>,
  context: CommandExecutionContext
) => Promise<CommandResult>

export interface CommandCompletionCandidate {
  readonly value: string
  readonly description: string
}

export interface CommandCompletionEntry {
  readonly sourceId: string
  readonly dependencies: Readonly<Record<string, string>>
  readonly candidates: readonly CommandCompletionCandidate[]
}

export interface CommandCompletionSnapshot {
  readonly entries: readonly CommandCompletionEntry[]
}

export interface CommandHint {
  readonly usage: string
  readonly description: string
  readonly kind: 'command' | 'detail' | 'warning'
  readonly completion?: string
}

export interface CommandSyntaxSpan {
  readonly start: number
  readonly end: number
  readonly kind: 'command'
}

export interface CommandDiagnostic {
  readonly code:
    | 'unknown-command'
    | 'unterminated-quote'
    | 'unknown-route'
    | 'unknown-option'
    | 'duplicate-option'
    | 'missing-option-value'
    | 'missing-argument'
    | 'too-many-arguments'
    | 'constraint-failed'
  readonly message: string
}

interface CommandAnalysisBase {
  readonly hints: readonly CommandHint[]
  readonly completion: string | null
  readonly syntaxSpans: readonly CommandSyntaxSpan[]
}

export type CommandInputAnalysis =
  | (CommandAnalysisBase & { readonly kind: 'not-command' })
  | (CommandAnalysisBase & { readonly kind: 'partial' })
  | (CommandAnalysisBase & {
      readonly kind: 'unknown' | 'invalid'
      readonly diagnostic: CommandDiagnostic
    })
  | (CommandAnalysisBase & {
      readonly kind: 'ready'
      readonly invocation: PreparedCommandInvocation
    })

export interface ResolvedCommand {
  readonly descriptor: CommandDescriptor
  readonly owner: ExtensionId
  readonly resolvedIndex: number
  readonly requiredServices: readonly ServiceRef<unknown>[]
  readonly requiredCapabilities: readonly Capability[]
  readonly handler: CommandHandler
}

export interface CommandAdmissionState {
  readonly threadBusy: boolean
}

export type CommandTraceEventKind =
  | 'command.started'
  | 'command.completed'
  | 'command.failed'
  | 'command.timedOut'
  | 'command.cancelled'
  | 'command.lateSettled'

export interface CommandTraceEvent {
  readonly kind: CommandTraceEventKind
  readonly generation: string
  readonly executionId: string
  readonly commandId: ContributionId
  readonly extensionId: ExtensionId
  readonly resolvedIndex: number
  readonly timestamp: number
  readonly resultCategory?: string
}

export type CommandTraceSink = (event: CommandTraceEvent) => unknown
