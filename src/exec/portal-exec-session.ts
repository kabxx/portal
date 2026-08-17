import { PortalHost, type PortalHostDependencies } from '../host/portal-host.ts'
import { throwIfAborted } from '../runtime/runtime-cancellation.ts'
import {
  EXEC_SURFACE_ID,
  isExecSurfaceApi,
  type ExecSurfaceApi,
} from './exec-surface-plugin.ts'
import type {
  PortalExecSession,
  PortalExecSessionOptions,
} from './exec-types.ts'

export async function createPortalExecSession(
  options: PortalExecSessionOptions
): Promise<PortalExecSession> {
  return await PortalApplicationCore.open(options)
}

export type PortalApplicationCoreDependencies = PortalHostDependencies

/** UI-independent facade over the shared PortalHost composition. */
export class PortalApplicationCore implements PortalExecSession {
  private constructor(
    private readonly host: PortalHost,
    private readonly surface: ExecSurfaceApi
  ) {}

  public static async open(
    options: PortalExecSessionOptions,
    dependencies: PortalApplicationCoreDependencies = {}
  ): Promise<PortalApplicationCore> {
    throwIfAborted(options.signal)
    const host = await PortalHost.prepare(
      {
        entrySurfaceId: EXEC_SURFACE_ID,
        cwd: options.cwd,
        ...(options.dataDirectory === undefined
          ? {}
          : { dataDirectory: options.dataDirectory }),
        ...(options.browserExecutablePath === undefined
          ? {}
          : { browserExecutablePath: options.browserExecutablePath }),
      },
      dependencies
    )
    try {
      await host.start({ signal: options.signal })
      const activeSurface = await host.activateSurface(
        EXEC_SURFACE_ID,
        options,
        options.signal
      )
      if (!isExecSurfaceApi(activeSurface.api)) {
        throw new Error('The exec Surface returned an invalid API.')
      }
      return new PortalApplicationCore(host, activeSurface.api)
    } catch (error) {
      try {
        await host.close(error)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Portal exec startup failed and could not close cleanly.',
          { cause: cleanupError }
        )
      }
      throw error
    }
  }

  public async run(task: string, signal: AbortSignal): Promise<string> {
    return await this.surface.run(task, signal)
  }

  public async close(): Promise<void> {
    await this.host.close()
  }
}
