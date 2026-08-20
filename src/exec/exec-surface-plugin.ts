import type {
  ExtensionDescriptor,
  ExtensionModule,
  ExtensionRegistrationApi,
} from '../extensions/extension-contracts.ts'
import type { PortalExtensionRegistration } from '../extensions/portal-hooks.ts'
import { throwIfAborted } from '../runtime/runtime-cancellation.ts'
import {
  surfaceActivationBindings,
  surfaceContributions,
  type SurfaceActivationContext,
  type SurfaceInstance,
} from '../surfaces/surface-extension.ts'
import type {
  ExecProgressEvent,
  PortalExecSessionOptions,
} from './exec-types.ts'
export const EXEC_SURFACE_PACKAGE_ID = 'portal.surface.exec'
export const EXEC_SURFACE_ID = 'portal.exec'
const EXEC_ACTIVATOR_ID = `${EXEC_SURFACE_ID}.activator`

export interface ExecSurfaceApi {
  run(task: string, signal: AbortSignal): Promise<string>
}

export function createExecSurfaceRegistration(
  options: {
    readonly dependencies?: readonly string[]
  } = {}
): PortalExtensionRegistration {
  const descriptor: ExtensionDescriptor = Object.freeze({
    id: EXEC_SURFACE_PACKAGE_ID,
    version: '1.0.0',
    dependencies: Object.freeze([...(options.dependencies ?? [])]),
    capabilities: Object.freeze([]),
  })
  const module: ExtensionModule = Object.freeze({
    register(api: ExtensionRegistrationApi): void {
      api.contribute(surfaceContributions, {
        id: EXEC_SURFACE_ID,
        value: Object.freeze({
          id: EXEC_SURFACE_ID,
          label: 'Portal exec',
          kind: 'batch',
          sessionIntent: 'batch',
          activationBindingId: EXEC_ACTIVATOR_ID,
        }),
        requiredServices: Object.freeze([]),
        requiredCapabilities: Object.freeze([]),
      })
      api.bind(surfaceActivationBindings, {
        id: EXEC_ACTIVATOR_ID,
        targetId: EXEC_SURFACE_ID,
        binding: activateExecSurface,
      })
    },
  })
  return Object.freeze({ descriptor, module })
}

export function isExecSurfaceApi(value: unknown): value is ExecSurfaceApi {
  return (
    value !== null &&
    typeof value === 'object' &&
    'run' in value &&
    typeof value.run === 'function'
  )
}

function activateExecSurface(
  input: unknown,
  context: SurfaceActivationContext
): SurfaceInstance {
  const options = assertExecOptions(input)
  options.onProgress({
    type: 'status',
    message: `Connecting to ${options.provider}...`,
  })
  const sessionController = new AbortController()
  let threadId: string | null = null
  let closed = false
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  let rejectDisconnected!: (error: Error) => void
  const disconnected = new Promise<never>((_, reject) => {
    rejectDisconnected = reject
  })
  void disconnected.catch(() => undefined)
  const unsubscribe = context.events.subscribe((event) => {
    if (event.type === 'runtime.disconnected') {
      rejectDisconnected(
        new Error(
          event.message.includes('cleanup could not be verified')
            ? event.message
            : 'Browser disconnected while the exec task was running.'
        )
      )
      return
    }
    if (event.type !== 'thread.lifecycle') return
    reportLifecycleEvent(options.onProgress, event.event)
  })

  const api: ExecSurfaceApi = Object.freeze({
    run: async (task: string, signal: AbortSignal) => {
      throwIfAborted(signal)
      if (closed) throw new Error('The exec Surface is closed.')
      if (threadId !== null)
        throw new Error('An exec session can run only one task.')
      const operationSignal = AbortSignal.any([
        signal,
        context.signal,
        sessionController.signal,
      ])
      return await Promise.race([
        executeTask(context, options, task, operationSignal, (id) => {
          threadId = id
        }),
        disconnected,
      ])
    },
  })

  return Object.freeze({
    api,
    done,
    close: () => {
      if (closed) return
      closed = true
      sessionController.abort(new Error('The exec Surface is closing.'))
      unsubscribe()
      resolveDone()
    },
  })
}

async function executeTask(
  context: SurfaceActivationContext,
  options: PortalExecSessionOptions,
  task: string,
  signal: AbortSignal,
  setThreadId: (threadId: string) => void
): Promise<string> {
  const provision = await context.port.createThread(
    {
      provider: options.provider,
      model: options.model,
      option: options.option ?? null,
      mode: 'agent',
      source: 'exec',
      activate: false,
    },
    signal
  )
  setThreadId(provision.thread.id)
  let assistant = ''
  const start = context.port.startMessage(
    provision.thread.id,
    task,
    (event) => {
      if (event.type === 'assistant.result') {
        assistant = event.text
      } else if (event.type === 'tool.progress') {
        options.onProgress({ type: 'tool', name: event.toolName })
      } else if (event.type === 'turn.item') {
        if (event.item.kind === 'status') {
          options.onProgress({ type: 'status', message: event.item.text })
        } else if (event.item.kind === 'tool_call') {
          options.onProgress({ type: 'tool', name: event.item.toolName })
        } else if (event.item.kind === 'error') {
          options.onProgress({ type: 'warning', message: event.item.text })
        }
      }
    },
    task,
    signal
  )
  if (!start.accepted) {
    throw new Error(
      start.reason === 'closing'
        ? `Thread ${provision.thread.id} is closing.`
        : `Thread ${provision.thread.id} is already running.`
    )
  }
  await start.operation.done
  if (assistant === '') {
    throw new Error('The exec thread did not produce a final response.')
  }
  return assistant
}

function reportLifecycleEvent(
  onProgress: (event: ExecProgressEvent) => void,
  event: { readonly type: string } & Record<string, unknown>
): void {
  if (event.type === 'provision.warning' && Array.isArray(event.lines)) {
    onProgress({
      type: 'warning',
      message: event.lines
        .filter((line): line is string => typeof line === 'string')
        .join(' '),
    })
  } else if (
    event.type === 'provision.login_wait' &&
    typeof event.provider === 'string'
  ) {
    onProgress({
      type: 'status',
      message: `Waiting for ${event.provider} login...`,
    })
  } else if (
    event.type === 'thread.ready' &&
    typeof event.provider === 'string' &&
    typeof event.conversationUrl === 'string'
  ) {
    onProgress({
      type: 'status',
      message: `Conversation: ${event.conversationUrl}`,
    })
  }
}

function assertExecOptions(value: unknown): PortalExecSessionOptions {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('provider' in value) ||
    typeof value.provider !== 'string' ||
    !('model' in value) ||
    (value.model !== null && typeof value.model !== 'string') ||
    !('onProgress' in value) ||
    !isExecProgressHandler(value.onProgress) ||
    !('signal' in value) ||
    !(value.signal instanceof AbortSignal) ||
    !('cwd' in value) ||
    typeof value.cwd !== 'string'
  ) {
    throw new TypeError('Invalid exec Surface activation input.')
  }
  if (
    ('dataDirectory' in value &&
      value.dataDirectory !== undefined &&
      typeof value.dataDirectory !== 'string') ||
    ('browserExecutablePath' in value &&
      value.browserExecutablePath !== undefined &&
      typeof value.browserExecutablePath !== 'string') ||
    ('option' in value &&
      value.option !== undefined &&
      value.option !== null &&
      typeof value.option !== 'string')
  ) {
    throw new TypeError('Invalid exec Surface activation options.')
  }
  const dataDirectory =
    'dataDirectory' in value ? value.dataDirectory : undefined
  const browserExecutablePath =
    'browserExecutablePath' in value ? value.browserExecutablePath : undefined
  const option = 'option' in value ? value.option : undefined
  return {
    cwd: value.cwd,
    provider: value.provider,
    model: value.model,
    signal: value.signal,
    onProgress: value.onProgress,
    ...(typeof dataDirectory === 'string' ? { dataDirectory } : {}),
    ...(typeof browserExecutablePath === 'string'
      ? { browserExecutablePath }
      : {}),
    ...(typeof option === 'string' || option === null ? { option } : {}),
  }
}

function isExecProgressHandler(
  value: unknown
): value is (event: ExecProgressEvent) => void {
  return typeof value === 'function'
}
