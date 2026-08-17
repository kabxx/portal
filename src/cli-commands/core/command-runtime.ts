import type {
  HookRuntimeClock,
  HookTimerHandle,
} from '../../extensions/extension-contracts.ts'
import type { ResolvedExtensionGraph } from '../../extensions/extension-registry.ts'
import { ExtensionResourceScope } from '../../extensions/scope-registration.ts'
import { ServiceContainer } from '../../extensions/service-container.ts'
import type {
  CommandAdmissionState,
  CommandCompletionSnapshot,
  CommandDescriptor,
  CommandInputAnalysis,
  CommandResult,
  CommandRouteProjection,
  CommandTraceSink,
  PreparedCommandInvocation,
} from './command-contracts.ts'
import {
  CommandExecutor,
  type CommandExecutionOptions,
} from './command-executor.ts'
import { CommandPlanError } from './command-errors.ts'
import { ResolvedCommandPlan } from './command-plan.ts'

export class CommandRuntime {
  readonly #clock: HookRuntimeClock
  readonly #executor: CommandExecutor

  public readonly plan: ResolvedCommandPlan

  public constructor(
    graph: ResolvedExtensionGraph,
    options: {
      readonly clock?: HookRuntimeClock
      readonly traceSink?: CommandTraceSink
      readonly serviceContainer?: ServiceContainer
    } = {}
  ) {
    this.#clock = options.clock ?? systemCommandClock
    this.plan = new ResolvedCommandPlan(graph)
    this.#executor = new CommandExecutor(
      this.plan,
      options.serviceContainer ??
        new ServiceContainer(graph.servicePlan, { clock: this.#clock }),
      this.#clock,
      options.traceSink
    )
  }

  public openSession(
    parent: ExtensionResourceScope,
    resourceId: string,
    options: {
      readonly routeProjection?: CommandRouteProjection
    } = {}
  ): CommandSessionRuntime {
    if (parent.kind !== 'portal') {
      throw new CommandPlanError(
        `Command session parent must be portal, received ${parent.kind}.`
      )
    }
    if (resourceId.trim().length === 0) {
      throw new TypeError('Command session resource ID must not be empty.')
    }
    const scope = new ExtensionResourceScope(
      'session',
      resourceId,
      parent.resourceScope.createChild(`session:${resourceId}`, {
        clock: this.#clock,
      }),
      parent
    )
    return new CommandSessionRuntime(
      this.plan,
      this.#executor,
      scope,
      options.routeProjection
    )
  }
}

export class CommandSessionRuntime {
  public constructor(
    private readonly plan: ResolvedCommandPlan,
    private readonly executor: CommandExecutor,
    private readonly scope: ExtensionResourceScope,
    private readonly routeProjection?: CommandRouteProjection
  ) {}

  public get catalog(): readonly CommandDescriptor[] {
    return this.plan.projectCatalog(this.routeProjection)
  }

  public analyze(
    input: string,
    completionSnapshot?: CommandCompletionSnapshot
  ): CommandInputAnalysis {
    return this.plan.analyze(input, completionSnapshot, this.routeProjection)
  }

  public prepare(input: string): CommandInputAnalysis {
    return this.plan.prepare(input, this.routeProjection)
  }

  public canExecute(
    invocation: PreparedCommandInvocation,
    state: CommandAdmissionState
  ): boolean {
    return this.plan.canExecute(invocation, state)
  }

  public async execute(
    invocation: PreparedCommandInvocation,
    options: Omit<CommandExecutionOptions, 'parentScope'>
  ): Promise<CommandResult> {
    return await this.executor.execute(invocation, {
      ...options,
      parentScope: this.scope,
    })
  }

  public async close(reason?: unknown): Promise<void> {
    await this.scope.resourceScope.dispose({
      ...(reason === undefined ? {} : { reason }),
    })
  }
}

const systemCommandClock: HookRuntimeClock = Object.freeze({
  now: () => Date.now(),
  setTimer: (delayMs: number, callback: () => void): HookTimerHandle => {
    const timer = setTimeout(callback, delayMs)
    return Object.freeze({ cancel: () => clearTimeout(timer) })
  },
})
