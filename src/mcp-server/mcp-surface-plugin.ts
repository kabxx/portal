import type {
  ExtensionDescriptor,
  ExtensionModule,
  ExtensionRegistrationApi,
} from '../extensions/extension-contracts.ts'
import type { PortalExtensionRegistration } from '../extensions/portal-hooks.ts'
import {
  stopMcpForegroundOperation,
  type McpForegroundOperation,
  type StopTarget,
} from '../app/app-lifecycle.ts'
import { createMcpHandlers } from '../app/app-mcp-handlers.ts'
import {
  surfaceActivationBindings,
  surfaceContributions,
  type SurfaceActivationContext,
  type SurfaceInstance,
} from '../surfaces/surface-extension.ts'
import type { CommandMcpService } from '../cli-commands/core/command-services.ts'
import {
  createDefaultPortalConfig,
  ensurePortalConfig,
} from '../config/portal-config.ts'
import { McpMessageOperationStore } from './mcp-message-operations.ts'
import {
  PortalMcpServer,
  resolvePortalMcpToken,
  type PortalMcpServerOptions,
} from './mcp-server.ts'
import {
  MCP_JOB_MANAGEMENT_FEATURE_ID,
  MCP_SURFACE_ID,
  isMcpJobManagementFeature,
} from './mcp-surface-contracts.ts'
import { registerMcpCommand } from './mcp-command-plugin.ts'

export const MCP_SURFACE_PACKAGE_ID = 'portal.surface.mcp'
export { MCP_SURFACE_ID } from './mcp-surface-contracts.ts'
const MCP_ACTIVATOR_ID = `${MCP_SURFACE_ID}.activator`

export type McpSurfaceApi = CommandMcpService

export interface McpSurfaceActivationOptions {
  readonly host?: string
  readonly port?: number
  readonly token?: string | null
  readonly environment?: NodeJS.ProcessEnv
  readonly createServer?: (options: PortalMcpServerOptions) => PortalMcpServer
}

interface ResolvedMcpSurfaceActivationOptions extends McpSurfaceActivationOptions {
  readonly host: string
  readonly port: number
}

export function createMcpSurfaceRegistration(): PortalExtensionRegistration {
  const descriptor: ExtensionDescriptor = Object.freeze({
    id: MCP_SURFACE_PACKAGE_ID,
    version: '1.0.0',
    dependencies: Object.freeze(['portal.commands']),
    capabilities: Object.freeze(['portal.command.mcp.manage']),
  })
  const module: ExtensionModule = Object.freeze({
    register(api: ExtensionRegistrationApi): void {
      registerMcpCommand(api)
      api.contribute(surfaceContributions, {
        id: MCP_SURFACE_ID,
        value: Object.freeze({
          id: MCP_SURFACE_ID,
          label: 'Portal MCP',
          kind: 'listener',
          sessionIntent: 'automation',
          activationBindingId: MCP_ACTIVATOR_ID,
        }),
        requiredServices: Object.freeze([]),
        requiredCapabilities: Object.freeze([]),
      })
      api.bind(surfaceActivationBindings, {
        id: MCP_ACTIVATOR_ID,
        targetId: MCP_SURFACE_ID,
        binding: activateMcpSurface,
      })
    },
  })
  return Object.freeze({ descriptor, module })
}

export function isMcpSurfaceApi(value: unknown): value is McpSurfaceApi {
  return (
    value !== null &&
    typeof value === 'object' &&
    'start' in value &&
    typeof value.start === 'function' &&
    'stop' in value &&
    typeof value.stop === 'function' &&
    'status' in value &&
    typeof value.status === 'function'
  )
}

async function activateMcpSurface(
  input: unknown,
  context: SurfaceActivationContext
): Promise<SurfaceInstance> {
  const options = await assertMcpOptions(input, context)
  const messageOperations = new McpMessageOperationStore()
  const foregroundOperations = new Set<McpForegroundOperation>()
  let currentOperation: McpForegroundOperation | null = null
  let closed = false
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const jobFeature = context.features.get(MCP_JOB_MANAGEMENT_FEATURE_ID)
  const jobFeatureApi = jobFeature?.api
  if (
    jobFeatureApi !== undefined &&
    !isMcpJobManagementFeature(jobFeatureApi)
  ) {
    throw new TypeError('The MCP Job management Surface feature is invalid.')
  }

  const stopOperations = async (): Promise<void> => {
    const outcomes = await Promise.allSettled([
      ...[...foregroundOperations].map(
        async (operation) => await stopMcpForegroundOperation(operation)
      ),
      messageOperations.stopAll(),
    ])
    const errors: unknown[] = []
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') errors.push(outcome.reason)
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'MCP operations failed to stop cleanly.')
    }
  }
  const withCancellableOperation = async <T>(
    stopTarget: StopTarget | null,
    runOperation: (
      signal: AbortSignal,
      setStopTarget: (target: StopTarget | null) => void
    ) => Promise<T>
  ): Promise<T> => {
    const controller = new AbortController()
    const operation: McpForegroundOperation = {
      controller,
      stopTarget,
      done: Promise.resolve(),
      cancellation: null,
    }
    currentOperation = operation
    const setStopTarget = (target: StopTarget | null) => {
      if (currentOperation === operation) operation.stopTarget = target
    }
    try {
      const run = runOperation(
        AbortSignal.any([context.signal, controller.signal]),
        setStopTarget
      )
      operation.done = run
      return await run
    } finally {
      if (currentOperation === operation) currentOperation = null
    }
  }
  const handlers = createMcpHandlers({
    surface: context.port,
    ...(jobFeatureApi === undefined ? {} : { runCommandJobs: jobFeatureApi }),
    messageOperations,
    foregroundOperations,
    isForegroundOperationActive: () => currentOperation !== null,
    withCancellableOperation,
  })
  const serverOptions: PortalMcpServerOptions = {
    host: options.host,
    port: options.port,
    token:
      options.token === undefined
        ? resolvePortalMcpToken(options.environment)
        : options.token,
    handlers,
    onStop: stopOperations,
    ...(options.environment === undefined
      ? {}
      : { environment: options.environment }),
  }
  const server =
    options.createServer?.(serverOptions) ?? new PortalMcpServer(serverOptions)
  const api: McpSurfaceApi = Object.freeze({
    start: async () => await server.start(),
    stop: async () => await server.stop(),
    status: () => Object.freeze({ ...server.status() }),
  })
  return Object.freeze({
    api,
    done,
    close: async () => {
      if (closed) return
      closed = true
      const outcomes = await Promise.allSettled([
        server.stop(),
        stopOperations(),
      ])
      resolveDone()
      const errors: unknown[] = []
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') errors.push(outcome.reason)
      }
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          'The MCP Surface failed to close cleanly.'
        )
      }
    },
  })
}

async function assertMcpOptions(
  value: unknown,
  context: SurfaceActivationContext
): Promise<ResolvedMcpSurfaceActivationOptions> {
  const config = await ensurePortalConfig(
    context.host.configPath,
    createDefaultPortalConfig(context.host.dataDirectory)
  )
  if (
    value === null ||
    typeof value !== 'object' ||
    ('host' in value &&
      value.host !== undefined &&
      typeof value.host !== 'string') ||
    ('port' in value &&
      value.port !== undefined &&
      (typeof value.port !== 'number' ||
        !Number.isInteger(value.port) ||
        value.port < 0 ||
        value.port > 65_535))
  ) {
    throw new TypeError('Invalid MCP Surface activation input.')
  }
  if (
    ('token' in value &&
      value.token !== undefined &&
      value.token !== null &&
      typeof value.token !== 'string') ||
    ('createServer' in value &&
      value.createServer !== undefined &&
      !isMcpServerFactory(value.createServer)) ||
    ('environment' in value &&
      value.environment !== undefined &&
      !isProcessEnvironment(value.environment))
  ) {
    throw new TypeError('Invalid MCP Surface activation options.')
  }
  const options = value as {
    readonly host?: unknown
    readonly port?: unknown
    readonly token?: unknown
    readonly createServer?: unknown
    readonly environment?: unknown
  }
  const token = options.token
  const createServer = options.createServer
  const environment = options.environment
  return {
    host: typeof options.host === 'string' ? options.host : config.mcp.host,
    port: typeof options.port === 'number' ? options.port : config.mcp.port,
    ...(typeof token === 'string' || token === null ? { token } : {}),
    ...(isMcpServerFactory(createServer) ? { createServer } : {}),
    ...(isProcessEnvironment(environment) ? { environment } : {}),
  }
}

function isMcpServerFactory(
  value: unknown
): value is (options: PortalMcpServerOptions) => PortalMcpServer {
  return typeof value === 'function'
}

function isProcessEnvironment(value: unknown): value is NodeJS.ProcessEnv {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (entry) => entry === undefined || typeof entry === 'string'
    )
  )
}
