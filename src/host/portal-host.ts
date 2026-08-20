import path from 'node:path'

import {
  KernelBootstrap,
  type KernelPluginPlan,
} from '../bootstrap/kernel-bootstrap.ts'
import { createFirstPartyPluginDefinitions } from '../bootstrap/first-party-plugins.ts'
import type {
  HookRuntimeClock,
  HookTraceSink,
} from '../extensions/extension-contracts.ts'
import {
  PortalHookRuntime,
  portalHostTestExtensions,
  type PortalExtensionRegistration,
  type PortalSessionIntent,
  type PortalShutdownPreviousState,
} from '../extensions/portal-hooks.ts'
import { CommandHost } from '../cli-commands/core/command-host.ts'
import { PortalDomainRuntime } from './portal-domain-runtime.ts'
import { portalCommandDefinitions } from '../cli-commands/builtin-commands.ts'
import {
  CommandServiceHost,
  type CommandServiceBundle,
} from '../cli-commands/core/command-services.ts'
import {
  createPortalCommandServices,
  portalCommandCompletionSnapshot,
  portalCommandRouteProjection,
} from './portal-command-services.ts'
import type { CommandSessionRuntime } from '../cli-commands/core/command-runtime.ts'
import { ExtensionResourceScope } from '../extensions/scope-registration.ts'
import type { BrowserLaunch } from '../platform/browser-cdp-launcher.ts'
import { launchBrowser } from '../platform/browser-cdp-launcher.ts'
import { resolvePortalDataDirectory } from '../platform/portal-data-directory.ts'
import type { AgentStartup } from '../agents/agent-extension.ts'
import { throwIfAborted } from '../runtime/runtime-cancellation.ts'
import { ResourceScope } from '../shared/resource-scope.ts'
import type { ThreadCreationMode } from '../threads/thread-creation-mode.ts'
import { ThreadLifecycleService } from '../threads/thread-lifecycle-service.ts'
import { ThreadManager } from '../threads/thread-manager.ts'
import { ThreadOperationCoordinator } from '../threads/thread-operation-coordinator.ts'
import { ThreadRuntimeRegistry } from '../threads/thread-runtime-registry.ts'
import { createThreadStore, type ThreadStore } from '../threads/thread-store.ts'
import {
  createDefaultPortalConfig,
  ensurePortalConfig,
  type PortalConfigDocument,
} from '../config/portal-config.ts'
import {
  createPortalRuntimeSettings,
  type PortalRuntimeSettings,
} from '../runtime/runtime-settings.ts'
import { createWebChildConversationService } from '../threads/web-child-conversation-service.ts'
import { buildPortalExtensionCatalog } from './portal-catalog.ts'
import { PluginManager } from '../extensions/plugin-manager.ts'
import { JsonPluginStore } from '../extensions/plugin-store.ts'
import { ChildConversationServiceHost } from '../threads/child-conversation-service.ts'
import { PortalBrowserSessionHost } from '../platform/browser-session-service.ts'
import { ToolRuntimeServiceHost } from '../tools/tool-runtime-service.ts'
import { createConversationRuntimeBridge } from '../threads/conversation-runtime-bridge.ts'
import type { ThreadLifecycleEvent } from '../threads/thread-lifecycle-service.ts'
import type { ThreadRuntime } from '../threads/thread-runtime.ts'
import { PortalSurfacePort } from './portal-surface-port.ts'
import type {
  SurfaceHostEvent,
  SurfaceThreadLifecycleEvent,
} from '../surfaces/surface-extension.ts'

const HOST_OPERATION_TIMEOUT_MS = 3000
const PORTAL_ACTIVATION_HOOK_TIMEOUT_MS = 5000
const PORTAL_SHUTDOWN_HOOK_TIMEOUT_MS = 3000
export type PortalHostState =
  'resolved' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'

export interface PortalHostOptions {
  readonly entrySurfaceId: string
  readonly cwd: string
  readonly dataDirectory?: string
  readonly browserExecutablePath?: string
}

export interface PortalHostDependencies {
  readonly launchBrowser?: typeof launchBrowser
  readonly extensionClock?: HookRuntimeClock
  readonly extensionTraceSink?: HookTraceSink
  readonly [portalHostTestExtensions]?: readonly PortalExtensionRegistration[]
}

interface ResolvedPortalHostDependencies {
  readonly launchBrowser: typeof launchBrowser
}

export interface PortalHostStartOptions {
  readonly signal?: AbortSignal
}

export interface PortalHostPreparedServices {
  readonly entrySurfaceId: string
  readonly sessionIntent: PortalSessionIntent
  readonly cwd: string
  readonly dataDirectory: string
  readonly configPath: string
  readonly config: PortalConfigDocument
  readonly settings: PortalRuntimeSettings
  readonly browserExecutablePath: string
  readonly browserProfileDir: string
  readonly threadStore: ThreadStore
  readonly threadManager: ThreadManager
  readonly threadOperations: ThreadOperationCoordinator
  readonly runtimeRegistry: ThreadRuntimeRegistry<ThreadRuntime>
  readonly pluginManager: PluginManager
  readonly pluginPlan: KernelPluginPlan
  readonly providerHost: import('../providers/provider-host.ts').ProviderHost
  readonly agentHost: import('../agents/agent-host.ts').AgentHost
  readonly toolHost: import('../tools/tool-host.ts').ToolHost
  readonly conversationHost: import('../threads/conversation-host.ts').ConversationHost
  readonly childConversations: ChildConversationServiceHost
}

export interface PortalHostStartedServices extends PortalHostPreparedServices {
  readonly browser: BrowserLaunch
  readonly lifecycle: ThreadLifecycleService
}

export class PortalHost {
  readonly #rootScope: ResourceScope
  readonly #extensionActivationScope: ResourceScope
  readonly #coreScope: ResourceScope
  readonly #portalScope: ExtensionResourceScope
  readonly #hooks: PortalHookRuntime
  readonly #commandHost: CommandHost
  readonly #commandServices: CommandServiceHost
  readonly #startupController = new AbortController()
  readonly #dependencies: ResolvedPortalHostDependencies
  #state: PortalHostState = 'resolved'
  #startPromise: Promise<PortalHostStartedServices> | null = null
  #closePromise: Promise<void> | null = null
  #startAttemptScope: ResourceScope | null = null
  #browserScope: ResourceScope | null = null
  #runtimeScope: ResourceScope | null = null
  #startedServices: PortalHostStartedServices | null = null
  #surfaceKernelUnbind: (() => void) | null = null
  readonly #surfaceListeners = new Set<
    (event: SurfaceHostEvent) => void | Promise<void>
  >()
  readonly #domainRuntime: PortalDomainRuntime
  readonly #browserSession: PortalBrowserSessionHost

  private constructor(
    public readonly prepared: PortalHostPreparedServices,
    rootScope: ResourceScope,
    extensionActivationScope: ResourceScope,
    coreScope: ResourceScope,
    portalScope: ExtensionResourceScope,
    hooks: PortalHookRuntime,
    commandHost: CommandHost,
    commandServices: CommandServiceHost,
    dependencies: ResolvedPortalHostDependencies,
    domainRuntime: PortalDomainRuntime,
    browserSession: PortalBrowserSessionHost
  ) {
    this.#rootScope = rootScope
    this.#extensionActivationScope = extensionActivationScope
    this.#coreScope = coreScope
    this.#portalScope = portalScope
    this.#hooks = hooks
    this.#commandHost = commandHost
    this.#commandServices = commandServices
    this.#dependencies = dependencies
    this.#domainRuntime = domainRuntime
    this.#browserSession = browserSession
  }

  public static async prepare(
    options: PortalHostOptions,
    dependencies: PortalHostDependencies = {}
  ): Promise<PortalHost> {
    const rootScope = new ResourceScope(`portal:${options.entrySurfaceId}`, {
      ...(dependencies.extensionClock === undefined
        ? {}
        : { clock: dependencies.extensionClock }),
    })
    try {
      const extensionActivationScope = rootScope.createChild(
        'extension activations'
      )
      const coreScope = rootScope.createChild('portal core')
      const portalScope = new ExtensionResourceScope(
        'portal',
        `portal:${options.entrySurfaceId}`,
        coreScope
      )
      const cwd = path.resolve(options.cwd)
      const dataDirectory = resolvePortalDataDirectory({
        cwd,
        ...(options.dataDirectory === undefined
          ? {}
          : { dataDirectory: options.dataDirectory }),
      })
      const configPath = path.join(dataDirectory, 'config.yaml')
      const config = await ensurePortalConfig(
        configPath,
        createDefaultPortalConfig(dataDirectory)
      )
      const settings = createPortalRuntimeSettings()
      const pluginManager = new PluginManager({
        store: new JsonPluginStore(
          path.join(dataDirectory, 'plugins', 'installed.json')
        ),
      })
      const commandServices = new CommandServiceHost()
      const childConversations = new ChildConversationServiceHost()
      const browserSession = new PortalBrowserSessionHost()
      const tools = new ToolRuntimeServiceHost()
      const testExtensions = dependencies[portalHostTestExtensions] ?? []
      const firstParty = createFirstPartyPluginDefinitions({
        commandServices,
        pluginManager,
        commandDefinitions: portalCommandDefinitions,
      })
      const pluginPlan = await new KernelBootstrap({
        manager: pluginManager,
        builtIns: firstParty,
      }).prepare({
        excludedPackageIds: testExtensions.map(
          ({ descriptor }) => descriptor.id
        ),
      })
      const catalog = buildPortalExtensionCatalog({
        resolved: pluginPlan.extensions,
        childConversations,
        workspace: Object.freeze({
          cwd,
          dataDirectory,
          projectInstructionsEnabled: config.projectInstructions,
        }),
        browserSession,
        tools,
        ...(testExtensions.length === 0 ? {} : { testExtensions }),
      })
      const domainRuntime = new PortalDomainRuntime({
        extensions: catalog,
        parentScope: portalScope,
        ...(dependencies.extensionClock === undefined
          ? {}
          : { clock: dependencies.extensionClock }),
        ...(dependencies.extensionTraceSink === undefined
          ? {}
          : { traceSink: dependencies.extensionTraceSink }),
      })
      const attachmentReader = await domainRuntime.resolveAttachmentReader()
      domainRuntime.providers.setAttachmentReader(attachmentReader)
      const unbindTools = tools.bind(domainRuntime.tools)
      coreScope.defer('Tool runtime service', () => unbindTools())
      const sessionIntent = domainRuntime.surfaces.sessionIntent(
        options.entrySurfaceId
      )
      if (sessionIntent === null) {
        throw new Error(
          `Unknown or disabled entry Surface: ${options.entrySurfaceId}`
        )
      }
      const threadStore = await coreScope.acquire(
        'thread store',
        async () =>
          await createThreadStore(path.join(dataDirectory, 'threads.db')),
        (store) => store.close()
      )
      const prepared: PortalHostPreparedServices = {
        entrySurfaceId: options.entrySurfaceId,
        sessionIntent,
        cwd,
        dataDirectory,
        configPath,
        config,
        settings,
        browserExecutablePath: path.resolve(
          options.browserExecutablePath ?? config.browser.executablePath
        ),
        browserProfileDir: path.resolve(config.browser.profilePath),
        threadStore,
        threadManager: new ThreadManager(),
        threadOperations: new ThreadOperationCoordinator(),
        runtimeRegistry: new ThreadRuntimeRegistry<ThreadRuntime>(),
        pluginManager,
        pluginPlan,
        providerHost: domainRuntime.providers,
        agentHost: domainRuntime.agents,
        toolHost: domainRuntime.tools,
        conversationHost: domainRuntime.conversations,
        childConversations,
      }
      return new PortalHost(
        prepared,
        rootScope,
        extensionActivationScope,
        coreScope,
        portalScope,
        domainRuntime.lifecycle,
        domainRuntime.commands,
        commandServices,
        { launchBrowser: dependencies.launchBrowser ?? launchBrowser },
        domainRuntime,
        browserSession
      )
    } catch (error) {
      try {
        await rootScope.dispose({ reason: error })
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'PortalHost preparation failed and could not roll back cleanly.',
          { cause: cleanupError }
        )
      }
      throw error
    }
  }

  public get state(): PortalHostState {
    return this.#state
  }

  /** @internal Opens the host-owned in-session Command surface. */
  public openCommandSession(resourceId = 'tui'): CommandSessionRuntime {
    if (this.#state !== 'resolved' && this.#state !== 'ready') {
      throw new Error(
        `Command session is unavailable in state "${this.#state}".`
      )
    }
    return this.#commandHost.openSession(this.#portalScope, resourceId, {
      routeProjection: portalCommandRouteProjection(this.#domainRuntime.agents),
    })
  }

  /** @internal Completes the late binding after Portal resources are ready. */
  public bindCommandServices(services: CommandServiceBundle): void {
    if (this.#state !== 'ready') {
      throw new Error(
        `Command services cannot be bound in state "${this.#state}".`
      )
    }
    this.#commandServices.bind(services)
  }

  /** @internal Returns immutable command metadata for a host-owned surface. */
  public commandCatalog(): readonly import('../cli-commands/core/command-contracts.ts').CommandDescriptor[] {
    return this.#commandHost.catalog(
      portalCommandRouteProjection(this.#domainRuntime.agents)
    )
  }

  public surfaceCatalog() {
    return this.#domainRuntime.surfaces.list()
  }

  /** @internal Returns the effective Prompt catalog for diagnostics and tests. */
  public promptCatalog() {
    return this.#domainRuntime.prompts.list()
  }

  /** @internal Returns Agents whose referenced Prompt is active. */
  public agentCatalog() {
    return this.#domainRuntime.agents.list()
  }

  public subscribeSurfaceEvents(
    listener: (event: SurfaceHostEvent) => void | Promise<void>
  ): () => void {
    this.#surfaceListeners.add(listener)
    return () => this.#surfaceListeners.delete(listener)
  }

  public async activateSurface(
    surfaceId: string,
    input: unknown,
    signal?: AbortSignal
  ) {
    if (this.#state !== 'ready') {
      throw new Error(
        `Surface activation is unavailable in state "${this.#state}".`
      )
    }
    return await this.#domainRuntime.surfaces.activate(surfaceId, input, signal)
  }

  public get services(): PortalHostStartedServices {
    if (this.#state !== 'ready' || this.#startedServices === null) {
      throw new Error(
        `PortalHost services are unavailable in state "${this.#state}".`
      )
    }
    return this.#startedServices
  }

  public start(
    options: PortalHostStartOptions = {}
  ): Promise<PortalHostStartedServices> {
    if (
      this.#startPromise !== null &&
      (this.#state === 'starting' || this.#state === 'ready')
    ) {
      return this.#startPromise
    }
    if (this.#state !== 'resolved') {
      return Promise.reject(
        new Error(`PortalHost cannot start from state "${this.#state}".`)
      )
    }
    this.#state = 'starting'
    this.#startPromise = this.#start(options)
    return this.#startPromise
  }

  public close(
    reason: unknown = new Error('PortalHost is closing.')
  ): Promise<void> {
    this.#closePromise ??= this.#close(reason)
    return this.#closePromise
  }

  async #start(
    options: PortalHostStartOptions
  ): Promise<PortalHostStartedServices> {
    try {
      throwIfAborted(options.signal)
      const signals = [this.#startupController.signal]
      if (options.signal !== undefined) signals.push(options.signal)
      const signal = AbortSignal.any(signals)
      const startScope = this.#portalScope.createChild(
        'portal',
        'start-attempt'
      )
      this.#startAttemptScope = startScope.resourceScope
      const beforeStartScope = startScope.createChild('portal', 'before-start')
      await this.#hooks.beforeStart(
        {
          sessionIntent: this.prepared.sessionIntent,
          previousState: 'resolved',
        },
        {
          scopeAccess: 'active',
          scope: beforeStartScope,
          signal,
          deadline: this.#hooks.now() + PORTAL_ACTIVATION_HOOK_TIMEOUT_MS,
        }
      )
      throwIfAborted(signal)

      const browserScope = startScope.resourceScope.createChild('browser')
      this.#browserScope = browserScope
      const browser = await browserScope.acquire(
        'browser launch',
        async () =>
          await this.#dependencies.launchBrowser(
            'chromium',
            this.prepared.browserExecutablePath,
            0,
            this.prepared.browserProfileDir,
            { signal }
          ),
        async (launch) => await launch.close()
      )
      const browserDisconnectOutcome = browser.disconnected.then(
        () => true,
        () => false
      )
      throwIfAborted(signal)

      const runtimeScope = startScope.resourceScope.createChild('runtime')
      this.#runtimeScope = runtimeScope
      const context = browser.context
      const unbindBrowserSession = this.#browserSession.bind({
        context,
        profileDirectory: this.prepared.browserProfileDir,
      })
      runtimeScope.defer('browser session service', () => {
        unbindBrowserSession()
      })
      const unbindChildConversations = this.prepared.childConversations.bind(
        createWebChildConversationService({
          providers: this.prepared.providerHost,
          conversations: this.prepared.conversationHost,
          settings: this.prepared.settings,
          generation: this.prepared.pluginPlan.generation,
          workingDirectory: this.prepared.cwd,
        })
      )
      runtimeScope.defer('child conversation service', () => {
        unbindChildConversations()
      })
      const lifecycle = new ThreadLifecycleService({
        threadManager: this.prepared.threadManager,
        threadOperations: this.prepared.threadOperations,
        threadStore: this.prepared.threadStore,
        runtimeRegistry: this.prepared.runtimeRegistry,
        resolveConversationUrl: (value) =>
          this.prepared.providerHost.resolveConversationUrl(value),
        openRuntime: async ({
          threadId,
          provider,
          conversationUrl,
          model,
          mode,
          onProviderEvent,
        }) => {
          await this.prepared.conversationHost.open({
            threadId,
            providerId: provider,
            providerOwnerId: this.prepared.providerHost.ownerOf(provider),
            conversationId: threadId,
            selectionRevision: this.prepared.pluginPlan.generation,
            conversationUrl,
            model,
            agentMode: mode === 'resume' ? null : mode,
            agentStartup: resolveAgentStartup(
              this.prepared.sessionIntent,
              mode
            ),
            workingDirectory: this.prepared.cwd,
            spawnDepth: 0,
            sessionKey: threadId,
            onProviderEvent,
          })
          return createConversationRuntimeBridge({
            host: this.prepared.conversationHost,
            threadId,
            providerId: provider,
            model,
            workingDirectory: this.prepared.cwd,
            spawnDepth: 0,
          })
        },
        observer: {
          onEvent: async (event) => {
            this.#emitSurfaceEvent({
              type: 'thread.lifecycle',
              event: projectSurfaceThreadEvent(
                event,
                this.#domainRuntime.agents
              ),
            })
          },
        },
      })
      const unsubscribe = this.prepared.threadManager.onThreadPageClosed(
        (threadId) => {
          void lifecycle
            .close(threadId, 'provider_page_closed')
            .catch((error) => {
              if (!context.isClosed()) {
                this.#emitSurfaceEvent({
                  type: 'thread.cleanup_failed',
                  threadId,
                  message: String(error),
                })
              }
            })
        }
      )
      runtimeScope.defer('thread page-close listener', () => unsubscribe())
      const services: PortalHostStartedServices = {
        ...this.prepared,
        browser,
        lifecycle,
      }
      const surfacePort = new PortalSurfacePort({
        threadManager: this.prepared.threadManager,
        threadLifecycle: lifecycle,
        threadOperations: this.prepared.threadOperations,
        providerHost: this.prepared.providerHost,
        agentHost: this.#domainRuntime.agents,
      })
      const commandRouteProjection = portalCommandRouteProjection(
        this.#domainRuntime.agents
      )
      this.#surfaceKernelUnbind = this.#domainRuntime.surfaces.bindKernel({
        port: surfacePort,
        events: {
          subscribe: (listener) => {
            this.#surfaceListeners.add(listener)
            return () => this.#surfaceListeners.delete(listener)
          },
        },
        commands: {
          openSession: (resourceId) =>
            this.#commandHost.openSession(this.#portalScope, resourceId, {
              routeProjection: commandRouteProjection,
            }),
          catalog: () => this.#commandHost.catalog(commandRouteProjection),
          completionSnapshot: () =>
            portalCommandCompletionSnapshot(this.prepared.providerHost),
          bindPresentation: (presentation) =>
            this.#commandServices.bind(
              createPortalCommandServices(
                { started: services, ...presentation },
                {
                  list: () => this.#commandHost.catalog(commandRouteProjection),
                }
              )
            ),
        },
        snapshot: Object.freeze({
          generation: this.prepared.pluginPlan.generation,
          cwd: this.prepared.cwd,
          dataDirectory: this.prepared.dataDirectory,
          configPath: this.prepared.configPath,
        }),
        requestStop: async (_surfaceId, reason) => {
          await this.close(reason)
        },
      })
      runtimeScope.defer('surface kernel binding', () => {
        this.#surfaceKernelUnbind?.()
        this.#surfaceKernelUnbind = null
      })
      throwIfAborted(signal)

      const readyScope = startScope.createChild('portal', 'ready')
      await this.#hooks.ready(
        { sessionIntent: this.prepared.sessionIntent },
        {
          scopeAccess: 'active',
          scope: readyScope,
          signal,
          deadline: this.#hooks.now() + PORTAL_ACTIVATION_HOOK_TIMEOUT_MS,
        }
      )
      throwIfAborted(signal)

      this.#startedServices = services
      this.#state = 'ready'
      this.#emitSurfaceEvent({ type: 'host.status', status: 'ready' })
      void browserDisconnectOutcome.then((cleanupVerified) =>
        cleanupVerified
          ? this.#emitSurfaceEvent({
              type: 'runtime.disconnected',
              message: 'Browser disconnected while the Portal was running.',
            })
          : this.#emitSurfaceEvent({
              type: 'runtime.disconnected',
              message:
                'Browser disconnected and process cleanup could not be verified.',
            })
      )
      return services
    } catch (error) {
      if (this.#state === 'starting') {
        this.#state = 'failed'
      }
      this.#emitSurfaceEvent({
        type: 'host.status',
        status: 'failed',
        message: String(error),
      })
      const cleanupErrors: unknown[] = []
      await this.#runClosePhase(cleanupErrors, async () => {
        await this.#startAttemptScope?.dispose({ reason: error })
      })
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          'PortalHost start failed and could not roll back cleanly.',
          { cause: error }
        )
      }
      throw error
    }
  }

  async #close(reason: unknown): Promise<void> {
    if (this.#state === 'stopped') return
    const previousState = shutdownPreviousState(this.#state)
    this.#state = 'stopping'
    this.#emitSurfaceEvent({ type: 'host.status', status: 'stopping' })
    this.#startupController.abort(reason)
    const errors: unknown[] = []
    const coreCleanupErrors: unknown[] = []
    const servicesAtShutdown = this.#startedServices
    servicesAtShutdown?.lifecycle.beginShutdown(reason)
    const provisioningShutdown =
      servicesAtShutdown?.lifecycle.waitForProvisioning() ?? null
    void provisioningShutdown?.catch(() => {})

    if (this.#startPromise !== null && this.#startedServices === null) {
      await this.#runClosePhase(
        errors,
        async () => {
          await runWithTimeout(
            'PortalHost startup cancellation',
            this.#startPromise!.then(
              () => {},
              () => {}
            ),
            this.#hooks
          )
        },
        coreCleanupErrors
      )
    }

    const beforeStopScope = this.#portalScope.createChild(
      'portal',
      'before-stop'
    )
    await this.#runClosePhase(errors, async () => {
      await this.#hooks.beforeStop(
        {
          sessionIntent: this.prepared.sessionIntent,
          previousState,
        },
        {
          scopeAccess: 'active',
          scope: beforeStopScope,
          deadline: this.#hooks.now() + PORTAL_SHUTDOWN_HOOK_TIMEOUT_MS,
        }
      )
    })

    const services = this.#startedServices
    if (services !== null) {
      await this.#runClosePhase(
        errors,
        async () => await this.#domainRuntime.surfaces.closeAll(reason),
        coreCleanupErrors
      )
      services.lifecycle.beginShutdown(reason)
      await this.#runClosePhase(
        errors,
        async () => {
          await this.#runtimeScope?.dispose({ reason })
        },
        coreCleanupErrors
      )
      await this.#runClosePhase(
        errors,
        async () => {
          await runWithTimeout(
            'thread provisioning shutdown',
            provisioningShutdown ?? Promise.resolve(),
            this.#hooks
          )
        },
        coreCleanupErrors
      )
      await this.#runClosePhase(
        errors,
        async () => {
          await services.lifecycle.cancelAll()
        },
        coreCleanupErrors
      )
      for (const thread of services.threadManager.listThreads()) {
        await this.#runClosePhase(
          errors,
          async () => {
            await runWithTimeout(
              `thread ${thread.id} shutdown`,
              services.lifecycle.close(thread.id, 'shutdown').then(() => {}),
              this.#hooks
            )
          },
          coreCleanupErrors
        )
      }
    } else {
      await this.#runClosePhase(
        errors,
        async () => {
          await this.prepared.threadOperations.cancelAll()
        },
        coreCleanupErrors
      )
    }

    await this.#runClosePhase(
      errors,
      async () => {
        await this.#browserScope?.dispose({ reason })
      },
      coreCleanupErrors
    )
    await this.#runClosePhase(
      errors,
      async () => {
        this.prepared.threadStore.close()
      },
      coreCleanupErrors
    )
    await this.#runClosePhase(
      errors,
      async () => {
        await this.#coreScope.dispose({ reason })
      },
      coreCleanupErrors
    )
    this.#state = 'stopped'
    this.#emitSurfaceEvent({ type: 'host.status', status: 'stopped' })

    await this.#runClosePhase(errors, async () => {
      await this.#hooks.stopped(
        {
          sessionIntent: this.prepared.sessionIntent,
          previousState,
          coreCleanup: {
            status: coreCleanupErrors.length === 0 ? 'clean' : 'errors',
            errorCount: coreCleanupErrors.length,
          },
        },
        {
          scopeAccess: 'terminal',
          scope: {
            kind: 'portal',
            resourceId: this.#portalScope.resourceId,
            closedAt: this.#hooks.now(),
          },
          deadline: this.#hooks.now() + PORTAL_SHUTDOWN_HOOK_TIMEOUT_MS,
        }
      )
    })
    await this.#runClosePhase(errors, async () => {
      await this.#extensionActivationScope.dispose({ reason })
    })
    await this.#runClosePhase(errors, async () => {
      await this.#rootScope.dispose({ reason })
    })

    if (errors.length > 0) {
      throw new AggregateError(errors, 'PortalHost failed to close cleanly.')
    }
  }

  async #runClosePhase(
    errors: unknown[],
    phase: () => Promise<void>,
    category?: unknown[]
  ): Promise<void> {
    try {
      await phase()
    } catch (error) {
      errors.push(error)
      if (category !== undefined && category !== errors) category.push(error)
    }
  }

  #emitSurfaceEvent(event: SurfaceHostEvent): void {
    for (const listener of this.#surfaceListeners) {
      void Promise.resolve(listener(event)).catch(() => undefined)
    }
  }
}

export class PortalHostOperationTimeoutError extends Error {
  public constructor(
    public readonly operation: string,
    public readonly timeoutMs: number
  ) {
    super(`Timed out after ${timeoutMs}ms during ${operation}.`)
    this.name = 'PortalHostOperationTimeoutError'
  }
}

async function runWithTimeout(
  operation: string,
  promise: Promise<void>,
  clock: HookRuntimeClock,
  timeoutMs = HOST_OPERATION_TIMEOUT_MS
): Promise<void> {
  const timeoutError = new PortalHostOperationTimeoutError(operation, timeoutMs)
  const deadline = clock.now() + timeoutMs
  void promise.catch(() => undefined)
  let rejectTimeout!: (reason: unknown) => void
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject
  })
  const timer = clock.setTimer(timeoutMs, () => rejectTimeout(timeoutError))
  try {
    try {
      await Promise.race([promise, timeout])
      if (clock.now() >= deadline) throw timeoutError
    } catch (error) {
      if (error !== timeoutError && clock.now() >= deadline) {
        throw timeoutError
      }
      throw error
    }
  } finally {
    timer.cancel()
  }
}

function resolveAgentStartup(
  sessionIntent: PortalSessionIntent,
  mode: ThreadCreationMode | 'resume'
): AgentStartup {
  if (mode === 'resume') return 'resume'
  if (sessionIntent === 'batch') return 'inline'
  return 'interactive'
}

function projectSurfaceThreadEvent(
  event: ThreadLifecycleEvent,
  agents: import('../agents/agent-host.ts').AgentHost
): SurfaceThreadLifecycleEvent {
  if (event.type === 'provision.started') return { ...event }
  if (event.type === 'provision.warning') {
    return { ...event, lines: Object.freeze([...event.lines]) }
  }
  if (event.type === 'provision.login_wait') return { ...event }
  if (event.type === 'thread.ready') return { ...event }
  if (event.type === 'thread.history') {
    return {
      ...event,
      history: Object.freeze({
        messages: agents.projectHistory(event.history.messages),
        complete: event.history.complete,
        warning: event.history.warning,
      }),
    }
  }
  if (event.type === 'thread.closed') return { ...event }
  return { ...event }
}

function shutdownPreviousState(
  state: PortalHostState
): PortalShutdownPreviousState {
  switch (state) {
    case 'resolved':
    case 'starting':
    case 'ready':
    case 'failed':
      return state
    case 'stopping':
    case 'stopped':
      throw new Error(`PortalHost cannot begin shutdown from state "${state}".`)
  }
}
