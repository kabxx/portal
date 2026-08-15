import { ResourceScope } from '../shared/resource-scope.ts'
import type {
  ContributionRef,
  ContributionSpec,
  Decision,
  ExtensionDescriptor,
  ExtensionModule,
  HookInvocationOptions,
  HookRef,
  HookRuntimeClock,
  HookTraceSink,
  InitialHookSpec,
  ResolvedContribution,
  ResolvedHookPolicy,
  ResourceScopeKind,
  ServiceRef,
  TerminalScopeView,
} from './extension-contracts.ts'
import {
  ExtensionRegistry,
  type ResolvedExtensionGraph,
} from './extension-registry.ts'
import { HookRunner } from './hook-runner.ts'
import { ExtensionResourceScope } from './scope-registration.ts'
import { ServiceContainer } from './service-container.ts'

export class ExtensionTestHost {
  readonly #rootResourceScope: ResourceScope
  readonly #registry: ExtensionRegistry
  readonly #clock: HookRuntimeClock | undefined
  readonly #traceSink: HookTraceSink | undefined
  #graph: ResolvedExtensionGraph | null = null
  #runner: HookRunner | null = null

  public readonly rootScope: ExtensionResourceScope

  public constructor(options: {
    readonly generation: string
    readonly policies: readonly ResolvedHookPolicy[]
    readonly contributionSelections?: Readonly<
      Record<string, Readonly<Record<string, string>>>
    >
    readonly clock?: HookRuntimeClock
    readonly traceSink?: HookTraceSink
  }) {
    this.#rootResourceScope = new ResourceScope('extension test host', {
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    })
    this.rootScope = new ExtensionResourceScope(
      'portal',
      'test-portal',
      this.#rootResourceScope
    )
    this.#registry = new ExtensionRegistry({
      generation: options.generation,
      policies: options.policies,
      ...(options.contributionSelections === undefined
        ? {}
        : { contributionSelections: options.contributionSelections }),
    })
    this.#clock = options.clock
    this.#traceSink = options.traceSink
  }

  public defineService<Service>(ref: ServiceRef<Service>): void {
    this.#registry.defineService(ref)
  }

  public defineContribution<Value>(spec: ContributionSpec<Value>): void {
    this.#registry.defineContribution(spec)
  }

  public defineHook<Input, Output>(spec: InitialHookSpec<Input, Output>): void {
    this.#registry.defineHook(spec)
  }

  public register(
    descriptor: ExtensionDescriptor,
    module: ExtensionModule
  ): void {
    this.#registry.register(descriptor, module)
  }

  public freeze(): ResolvedExtensionGraph {
    this.#graph ??= this.#registry.freeze()
    this.#runner ??= new HookRunner(
      this.#graph,
      new ServiceContainer(this.#graph.servicePlan, {
        ...(this.#clock === undefined ? {} : { clock: this.#clock }),
      }),
      {
        ...(this.#clock === undefined ? {} : { clock: this.#clock }),
        ...(this.#traceSink === undefined
          ? {}
          : { traceSink: this.#traceSink }),
      }
    )
    return this.#graph
  }

  public contributions<Value>(
    ref: ContributionRef<Value>
  ): readonly ResolvedContribution<Value>[] {
    return this.freeze().contributions(ref)
  }

  public createScope(
    kind: ResourceScopeKind,
    resourceId: string,
    parent: ExtensionResourceScope = this.rootScope
  ): ExtensionResourceScope {
    return parent.createChild(kind, resourceId)
  }

  public terminalScope(
    kind: ResourceScopeKind,
    resourceId: string,
    closedAt = Date.now()
  ): TerminalScopeView {
    return Object.freeze({ kind, resourceId, closedAt })
  }

  public async invokeObserve<Input>(
    ref: HookRef<Input, void, 'observe'>,
    input: Input,
    options: HookInvocationOptions
  ): Promise<void> {
    await this.#getRunner().invokeObserve(ref, input, options)
  }

  public async invokeWaterfall<Input, Patch>(
    ref: HookRef<Input, Patch, 'waterfall'>,
    input: Input,
    options: HookInvocationOptions
  ): Promise<Input> {
    return await this.#getRunner().invokeWaterfall(ref, input, options)
  }

  public async invokeGuard<Input>(
    ref: HookRef<Input, Decision, 'guard'>,
    input: Input,
    options: HookInvocationOptions
  ): Promise<Decision> {
    return await this.#getRunner().invokeGuard(ref, input, options)
  }

  public async dispose(reason?: unknown): Promise<void> {
    await this.#rootResourceScope.dispose({
      ...(reason === undefined ? {} : { reason }),
    })
  }

  #getRunner(): HookRunner {
    this.freeze()
    return this.#runner!
  }
}
