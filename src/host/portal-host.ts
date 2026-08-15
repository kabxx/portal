import path from 'node:path'

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

const LOGIN_CHECK_INTERVAL_MS = 1000
const HOST_OPERATION_TIMEOUT_MS = 3000

export type PortalHostProfile = 'tui' | 'exec'
export type PortalHostState =
  'prepared' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'

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
}

export interface PortalHostStartedServices extends PortalHostPreparedServices {
  readonly browser: BrowserLaunch
  readonly lifecycle: ThreadLifecycleService
}

export class PortalHost {
  readonly #rootScope: ResourceScope
  readonly #startupController = new AbortController()
  readonly #dependencies: Required<PortalHostDependencies>
  #state: PortalHostState = 'prepared'
  #startPromise: Promise<PortalHostStartedServices> | null = null
  #closePromise: Promise<void> | null = null
  #browserScope: ResourceScope | null = null
  #runtimeScope: ResourceScope | null = null
  #startedServices: PortalHostStartedServices | null = null

  private constructor(
    public readonly prepared: PortalHostPreparedServices,
    rootScope: ResourceScope,
    dependencies: Required<PortalHostDependencies>
  ) {
    this.#rootScope = rootScope
    this.#dependencies = dependencies
  }

  public static async prepare(
    options: PortalHostOptions,
    dependencies: PortalHostDependencies = {}
  ): Promise<PortalHost> {
    const rootScope = new ResourceScope(`portal:${options.profile}`)
    try {
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
      const threadStore = await rootScope.acquire(
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
      }
      return new PortalHost(prepared, rootScope, {
        launchBrowser: dependencies.launchBrowser ?? launchBrowser,
        createProviderAdapter:
          dependencies.createProviderAdapter ?? createAdapterForProvider,
        createRuntime: dependencies.createRuntime ?? createRuntimeFromAdapter,
      })
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
    if (this.#state !== 'prepared') {
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
      const browserScope = this.#rootScope.createChild('browser')
      this.#browserScope = browserScope
      const signals = [this.#startupController.signal]
      if (options.signal !== undefined) signals.push(options.signal)
      const signal = AbortSignal.any(signals)
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

      const runtimeScope = this.#rootScope.createChild('runtime')
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
        await this.#runtimeScope?.dispose({ reason: error })
      })
      await this.#runClosePhase(cleanupErrors, async () => {
        await this.#browserScope?.dispose({ reason: error })
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
    this.#state = 'stopping'
    this.#startupController.abort(reason)
    const errors: unknown[] = []
    const servicesAtShutdown = this.#startedServices
    servicesAtShutdown?.lifecycle.beginShutdown(reason)
    servicesAtShutdown?.runCommandJobs.beginShutdown()
    const provisioningShutdown =
      servicesAtShutdown?.lifecycle.waitForProvisioning() ?? null
    void provisioningShutdown?.catch(() => {})

    if (this.#startPromise !== null && this.#startedServices === null) {
      await this.#runClosePhase(errors, async () => {
        await runWithTimeout(
          'PortalHost startup cancellation',
          this.#startPromise!.then(
            () => {},
            () => {}
          )
        )
      })
    }

    const services = this.#startedServices
    if (services !== null) {
      services.lifecycle.beginShutdown(reason)
      services.runCommandJobs.beginShutdown()
      await this.#runClosePhase(errors, async () => {
        await this.#runtimeScope?.dispose({ reason })
      })
      await this.#runClosePhase(errors, async () => {
        await runWithTimeout(
          'thread provisioning shutdown',
          provisioningShutdown ?? Promise.resolve()
        )
      })
      await this.#runClosePhase(errors, async () => {
        await services.lifecycle.cancelAll()
      })
      await this.#runClosePhase(errors, async () => {
        await services.runCommandJobs.stopAll()
      })
      for (const thread of services.threadManager.listThreads()) {
        await this.#runClosePhase(errors, async () => {
          await runWithTimeout(
            `thread ${thread.id} shutdown`,
            services.lifecycle.close(thread.id, 'shutdown').then(() => {})
          )
        })
      }
    } else {
      this.prepared.runCommandJobs.beginShutdown()
      await this.#runClosePhase(errors, async () => {
        await this.prepared.threadOperations.cancelAll()
      })
      await this.#runClosePhase(errors, async () => {
        await this.prepared.runCommandJobs.stopAll()
      })
    }

    await this.#runClosePhase(errors, async () => {
      await this.#browserScope?.dispose({ reason })
    })
    await this.#runClosePhase(errors, async () => {
      await this.#rootScope.dispose({ reason })
    })
    this.#state = 'stopped'

    if (errors.length > 0) {
      throw new AggregateError(errors, 'PortalHost failed to close cleanly.')
    }
  }

  async #runClosePhase(
    errors: unknown[],
    phase: () => Promise<void>
  ): Promise<void> {
    try {
      await phase()
    } catch (error) {
      errors.push(error)
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
  timeoutMs = HOST_OPERATION_TIMEOUT_MS
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new PortalHostOperationTimeoutError(operation, timeoutMs)),
          timeoutMs
        )
      }),
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
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
