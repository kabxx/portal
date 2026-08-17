import type {
  CommandProviderCapabilityResult,
  CommandProviderCapabilityState,
} from '../cli-commands/core/command-services.ts'
import type { ThreadRuntime } from '../threads/thread-runtime.ts'

const TITLE = '/thread capability'

export interface PortalCommandCapabilityList {
  readonly provider: string
  readonly capabilities: readonly CommandProviderCapabilityState[]
  readonly usage: string
}

export async function listPortalCommandCapabilities(
  provider: string,
  runtime: ThreadRuntime,
  signal: AbortSignal
): Promise<PortalCommandCapabilityList> {
  if (runtime.listProviderCapabilities === undefined) {
    throw new Error(
      'The active Thread runtime has no Provider capability port.'
    )
  }
  const catalog = await runtime.listProviderCapabilities(signal)
  return Object.freeze({ provider, ...catalog })
}

export async function executePortalCommandCapability(
  _provider: string,
  runtime: ThreadRuntime,
  name: string,
  args: readonly string[],
  signal: AbortSignal
): Promise<CommandProviderCapabilityResult> {
  if (runtime.executeProviderCapability === undefined) {
    throw new Error(
      'The active Thread runtime has no Provider capability port.'
    )
  }
  const outcome = await runtime.executeProviderCapability(name, args, signal)
  return Object.freeze({
    status: outcome.status,
    title: TITLE,
    body: outcome.message,
    format: 'plain',
  })
}
