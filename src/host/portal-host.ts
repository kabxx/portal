import path from 'node:path'

import {
  KernelBootstrap,
  type KernelPluginPlan,
} from '../bootstrap/kernel-bootstrap.ts'
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
import { builtinCommandDefinitions } from '../cli-commands/builtin-commands.ts'
import {
  CommandServiceHost,
  type CommandServiceBundle,
} from '../cli-commands/core/command-services.ts'
import type { CommandSessionRuntime } from '../cli-commands/core/command-runtime.ts'
import { ExtensionResourceScope } from '../extensions/scope-registration.ts'
import type { BrowserLaunch } from '../platform/browser-cdp-launcher.ts'
import { launchBrowser } from '../platform/browser-cdp-launcher.ts'
import { resolvePortalDataDirectory } from '../platform/portal-data-directory.ts'
import { RunCommandJobManager } from '../processes/run-command-job-manager.ts'
import { resolveConversationUrl } from '../providers/provider-conversation-url.ts'
import type { RuntimeCore } from '../runtime/runtime-core.ts'
import { createRuntimeFromAdapter } from '../runtime/runtime-factory.ts'
import type { RuntimeSetupMode } from '../runtime/setup-handshake.ts'
import { throwIfAborted } from '../runtime/runtime-cancellation.ts'
import { ResourceScope } from '../shared/resource-scope.ts'
import { sleepWithAbortAsync } from '../shared/sleep.ts'
import { SkillLibrary } from '../skills/skill-library.ts'
import type { ThreadCreationMode } from '../threads/thread-creation-mode.ts'
import {
  ThreadLifecycleService,
  type ThreadLifecycleObserver,
} from '../threads/thread-lifecycle-service.ts'
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
  loadProjectInstructions,
  type ProjectInstructions,
} from '../instructions/project-instructions.ts'
import {
  createPortalRuntimeSettings,
  runtimeSetupModeForThreadCreation,
  type PortalRuntimeSettings,
} from '../runtime/runtime-settings.ts'
import { createToolServices } from '../tools/spawn-tool-services.ts'
import { createAdapterForProvider } from '../providers/provider-catalog.ts'
import { buildPortalExtensionCatalog } from './portal-catalog.ts'
import { PluginManager } from '../extensions/plugin-manager.ts'
import { JsonPluginStore } from '../extensions/plugin-store.ts'
import { AttachmentFileService } from '../attachments/attachment-service.ts'

const LOGIN_CHECK_INTERVAL_MS = 1000
const HOST_OPERATION_TIMEOUT_MS = 3000
const PORTAL_ACTIVATION_HOOK_TIMEOUT_MS = 5000
const PORTAL_SHUTDOWN_HOOK_TIMEOUT_MS = 3000
export type PortalHostProfile = 'tui' | 'exec'
export type PortalHostState =
  'resolved' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'

export interface PortalHostOptions {
  readonly profile: PortalHostProfile
  readonly cwd: string
  readonly dataDirectory?: string
  readonly browserExecutablePath?: string
}

export interface PortalHostDependencies {
  readonly launchBrowser?: typeof launchBrowser
  readonly createProviderAdapter?: typeof createAdapterForProvider
  readonly createRuntime?: typeof createRuntimeFromAdapter
  readonly extensionClock?: HookRuntimeClock
  readonly extensionTraceSink?: HookTraceSink
  readonly [portalHostTestExtensions]?: readonly PortalExtensionRegistration[]
}

interface ResolvedPortalHostDependencies {
  readonly launchBrowser: typeof launchBrowser
  readonly createProviderAdapter: typeof createAdapterForProvider
  readonly createRuntime: typeof createRuntimeFromAdapter
}

export interface PortalHostStartOptions {
  readonly signal?: AbortSignal
  readonly observer?: ThreadLifecycleObserver
  readonly onPageCloseCleanupError?: (error: unknown, threadId: string) => void
}

export interface PortalHostPreparedServices {
  readonly profile: PortalHostProfile
  readonly cwd: string
  readonly dataDirectory: string
  readonly configPath: string
  readonly config: PortalConfigDocument
  readonly settings: PortalRuntimeSettings
  readonly skillLibrary: SkillLibrary
  readonly projectInstructions: ProjectInstructions
  readonly browserExecutablePath: string
  readonly browserProfileDir: string
  readonly threadStore: ThreadStore
  readonly threadManager: ThreadManager
  readonly threadOperations: ThreadOperationCoordinator
  readonly runtimeRegistry: ThreadRuntimeRegistry<RuntimeCore>
  readonly runCommandJobs: RunCommandJobManager
  readonly pluginManager: PluginManager
  readonly pluginPlan: KernelPluginPlan
  readonly providerHost: import('../providers/provider-host.ts').ProviderHost
  readonly toolHost: import('../tools/tool-host.ts').ToolHost
  readonly conversationHost: import('../threads/conversation-host.ts').ConversationHost
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

  private constructor(
    public readonly prepared: PortalHostPreparedServices,
    rootScope: ResourceScope,
    extensionActivationScope: ResourceScope,
    coreScope: ResourceScope,
    portalScope: ExtensionResourceScope,
    hooks: PortalHookRuntime,
    commandHost: CommandHost,
    commandServices: CommandServiceHost,
    dependencies: ResolvedPortalHostDependencies
  ) {
    this.#rootScope = rootScope
    this.#extensionActivationScope = extensionActivationScope
    this.#coreScope = coreScope
    this.#portalScope = portalScope
    this.#hooks = hooks
    this.#commandHost = commandHost
    this.#commandServices = commandServices
    this.#dependencies = dependencies
  }

  public static async prepare(
    options: PortalHostOptions,
    dependencies: PortalHostDependencies = {}
  ): Promise<PortalHost> {
    const rootScope = new ResourceScope(`portal:${options.profile}`, {
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
        `portal:${options.profile}`,
        coreScope
      )
      const cwd = path.resolve(options.cwd)
      const dataDirectory = resolvePortalDataDirectory({
        cwd,
        ...(options.dataDirectory === undefined
          ? {}
          : { dataDirectory: options.dataDirectory }),
      })
      const pluginManager = new PluginManager({
        store: new JsonPluginStore(
          path.join(dataDirectory, 'plugins', 'installed.json')
        ),
      })
      const pluginPlan = await new KernelBootstrap({
        manager: pluginManager,
      }).prepare()
      const commandServices = new CommandServiceHost()
      const attachmentService = new AttachmentFileService()
      const catalog = buildPortalExtensionCatalog({
        commandServices,
        commandDefinitions: builtinCommandDefinitions,
        installed: pluginPlan.extensions,
        attachments: attachmentService,
        ...(dependencies[portalHostTestExtensions] === undefined
          ? {}
          : { testExtensions: dependencies[portalHostTestExtensions] }),
      })
      const domainRuntime = new PortalDomainRuntime({
        extensions: catalog,
        parentScope: coreScope,
        ...(dependencies.extensionClock === undefined
          ? {}
          : { clock: dependencies.extensionClock }),
        ...(dependencies.extensionTraceSink === undefined
          ? {}
          : { traceSink: dependencies.extensionTraceSink }),
        attachmentReader: attachmentService,
      })
      const configPath = path.join(dataDirectory, 'config.yaml')
      const config = await ensurePortalConfig(
        configPath,
        createDefaultPortalConfig(dataDirectory)
      )
      const settings = createPortalRuntimeSettings()
      const skillLibrary = new SkillLibrary({
        skillsDirectory: path.join(dataDirectory, 'skills'),
        tempDirectory: path.join(dataDirectory, 'temp', 'skill-install'),
        registryPath: path.join(dataDirectory, 'state', 'skills.json'),
      })
      await skillLibrary.initialize()
      const projectInstructions = await loadProjectInstructions({
        cwd,
        enabled: config.projectInstructions,
      })
      const threadStore = await coreScope.acquire(
        'thread store',
        async () =>
          await createThreadStore(path.join(dataDirectory, 'threads.db')),
        (store) => store.close()
      )
      const prepared: PortalHostPreparedServices = {
        profile: options.profile,
        cwd,
        dataDirectory,
        configPath,
        config,
        settings,
        skillLibrary,
        projectInstructions,
        browserExecutablePath: path.resolve(
          options.browserExecutablePath ?? config.browser.executablePath
        ),
        browserProfileDir: path.resolve(config.browser.profilePath),
        threadStore,
        threadManager: new ThreadManager(),
        threadOperations: new ThreadOperationCoordinator(),
        runtimeRegistry: new ThreadRuntimeRegistry<RuntimeCore>(),
        runCommandJobs: new RunCommandJobManager(),
        pluginManager,
        pluginPlan,
        providerHost: domainRuntime.providers,
        toolHost: domainRuntime.tools,
        conversationHost: domainRuntime.conversations,
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
        {
          launchBrowser: dependencies.launchBrowser ?? launchBrowser,
          createProviderAdapter:
            dependencies.createProviderAdapter ?? createAdapterForProvider,
          createRuntime: dependencies.createRuntime ?? createRuntimeFromAdapter,
        }
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
    return this.#commandHost.openSession(this.#portalScope, resourceId)
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
    return this.#commandHost.catalog()
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
          sessionIntent: sessionIntentForProfile(this.prepared.profile),
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
      throwIfAborted(signal)

      const runtimeScope = startScope.resourceScope.createChild('runtime')
      this.#runtimeScope = runtimeScope
      const context = browser.context
      const lifecycle = new ThreadLifecycleService({
        threadManager: this.prepared.threadManager,
        threadOperations: this.prepared.threadOperations,
        threadStore: this.prepared.threadStore,
        runtimeRegistry: this.prepared.runtimeRegistry,
        browserProfileDir: this.prepared.browserProfileDir,
        resolveConversationUrl,
        projectInstructions: this.prepared.projectInstructions,
        createAdapter: async ({ provider, conversationUrl, signal }) =>
          await this.#dependencies.createProviderAdapter(
            context,
            provider,
            conversationUrl,
            signal
          ),
        createRuntime: async ({
          adapter,
          provider,
          model,
          mode,
          projectInstructions,
          signal,
        }) =>
          await this.#dependencies.createRuntime(adapter, {
            model,
            setupMode: resolveSetupMode(this.prepared.profile, mode),
            skillLibrary: this.prepared.skillLibrary,
            projectInstructions,
            advertiseSpawnTool: this.prepared.settings.spawnDepthLimit > 0,
            workingDirectory: this.prepared.cwd,
            toolServices: createToolServices({
              context,
              provider,
              model,
              skillLibrary: this.prepared.skillLibrary,
              projectInstructions,
              runCommandJobs: this.prepared.runCommandJobs,
              settings: this.prepared.settings,
              currentSpawnDepth: 0,
              workingDirectory: this.prepared.cwd,
            }),
            signal,
          }),
        waitForLogin: async (waitSignal) =>
          await sleepWithAbortAsync(LOGIN_CHECK_INTERVAL_MS, waitSignal),
        ...(options.observer === undefined
          ? {}
          : { observer: options.observer }),
      })
      const unsubscribe = this.prepared.threadManager.onThreadPageClosed(
        (threadId) => {
          void lifecycle
            .close(threadId, 'provider_page_closed')
            .catch((error) => {
              if (!context.isClosed()) {
                options.onPageCloseCleanupError?.(error, threadId)
              }
            })
        }
      )
      runtimeScope.defer('thread page-close listener', () => unsubscribe())
      throwIfAborted(signal)

      const readyScope = startScope.createChild('portal', 'ready')
      await this.#hooks.ready(
        { sessionIntent: sessionIntentForProfile(this.prepared.profile) },
        {
          scopeAccess: 'active',
          scope: readyScope,
          signal,
          deadline: this.#hooks.now() + PORTAL_ACTIVATION_HOOK_TIMEOUT_MS,
        }
      )
      throwIfAborted(signal)

      const services: PortalHostStartedServices = {
        ...this.prepared,
        browser,
        lifecycle,
      }
      this.#startedServices = services
      this.#state = 'ready'
      return services
    } catch (error) {
      if (this.#state === 'starting') {
        this.#state = 'failed'
      }
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
    this.#startupController.abort(reason)
    const errors: unknown[] = []
    const coreCleanupErrors: unknown[] = []
    const servicesAtShutdown = this.#startedServices
    servicesAtShutdown?.lifecycle.beginShutdown(reason)
    this.prepared.runCommandJobs.beginShutdown()
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
          sessionIntent: sessionIntentForProfile(this.prepared.profile),
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
      services.lifecycle.beginShutdown(reason)
      services.runCommandJobs.beginShutdown()
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
      await this.#runClosePhase(
        errors,
        async () => {
          await services.runCommandJobs.stopAll()
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
      await this.#runClosePhase(
        errors,
        async () => {
          await this.prepared.runCommandJobs.stopAll()
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
        await this.#coreScope.dispose({ reason })
      },
      coreCleanupErrors
    )
    this.#state = 'stopped'

    await this.#runClosePhase(errors, async () => {
      await this.#hooks.stopped(
        {
          sessionIntent: sessionIntentForProfile(this.prepared.profile),
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

function resolveSetupMode(
  profile: PortalHostProfile,
  mode: ThreadCreationMode | 'resume'
): RuntimeSetupMode {
  if (mode === 'resume') return 'skip'
  if (profile === 'exec') return 'inline'
  return runtimeSetupModeForThreadCreation(mode)
}

function sessionIntentForProfile(
  profile: PortalHostProfile
): PortalSessionIntent {
  return profile === 'tui' ? 'interactive' : 'batch'
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
