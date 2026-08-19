import { abortable } from '../runtime/runtime-cancellation.ts'
import type { RuntimeCore } from '../runtime/runtime-core.ts'
import { ProviderAdapterUnsupportedError } from './adapters/adapter-base.ts'
import {
  getProviderCapability,
  listProviderCapabilities,
  type ProviderCapabilityDefinition,
} from './provider-definition-pack.ts'
import type { FirstPartyProviderId as ProviderId } from './first-party-provider-id.ts'
import type {
  ProviderCapabilityCatalog,
  ProviderCapabilityResult,
} from './provider-exchange.ts'

type ToggleCapabilityDefinition = Extract<
  ProviderCapabilityDefinition,
  { kind: 'toggle' }
>
type ToggleCapability = ToggleCapabilityDefinition['key']
type ToggleState = 'on' | 'off'
type ActionCapabilityState =
  'available' | 'selected' | 'cleared' | 'disabled' | 'unavailable'

export async function listWebProviderCapabilities(
  provider: ProviderId,
  runtime: RuntimeCore,
  signal: AbortSignal
): Promise<ProviderCapabilityCatalog> {
  const adapter = runtime.getAdapter()
  if (isToggleCapabilityProvider(provider)) {
    if (!isToggleCapabilityAdapter(adapter)) {
      return { capabilities: Object.freeze([]), usage: toggleUsage() }
    }
    const capabilities: { name: string; state: string }[] = []
    for (const definition of listProviderCapabilities(provider)) {
      if (definition.kind !== 'toggle') continue
      try {
        const available =
          provider === 'kimi' ||
          (await abortable(adapter.hasToggleCapability(definition.key), signal))
        if (!available) continue
        capabilities.push({
          name: definition.key,
          state: await abortable(
            adapter.getToggleState(definition.key),
            signal
          ),
        })
      } catch (error) {
        if (
          provider !== 'kimi' ||
          !(error instanceof ProviderAdapterUnsupportedError)
        ) {
          throw error
        }
      }
    }
    return {
      capabilities: Object.freeze(capabilities),
      usage: toggleUsage(),
    }
  }
  if (isActionCapabilityProvider(provider)) {
    if (!isActionCapabilityAdapter(adapter)) {
      return { capabilities: Object.freeze([]), usage: actionUsage() }
    }
    const capabilities = await abortable(
      adapter.listActionCapabilities(),
      signal
    )
    return {
      capabilities: Object.freeze(
        capabilities.map(({ name, state }) => Object.freeze({ name, state }))
      ),
      usage: actionUsage(),
    }
  }
  return { capabilities: Object.freeze([]), usage: actionUsage() }
}

export async function executeWebProviderCapability(
  provider: ProviderId,
  runtime: RuntimeCore,
  name: string,
  args: readonly string[],
  signal: AbortSignal
): Promise<ProviderCapabilityResult> {
  const adapter = runtime.getAdapter()
  if (isActionCapabilityProvider(provider)) {
    return await executeActionCapability(provider, adapter, name, args, signal)
  }
  if (!isToggleCapabilityProvider(provider)) {
    return result(
      'unsupported-provider',
      `No capabilities available for ${provider}.`
    )
  }
  const definition = getProviderCapability(provider, name)
  if (definition?.kind !== 'toggle') {
    return result(
      'unknown-capability',
      `Unknown capability for ${provider}: ${name}`
    )
  }
  const action = args[0]
  if (
    args.length !== 1 ||
    (action !== 'on' && action !== 'off' && action !== 'status')
  ) {
    return result(
      'invalid-args',
      `Usage: /thread capability ${name} <on|off|status>`
    )
  }
  if (!isToggleCapabilityAdapter(adapter)) {
    return result(
      'unsupported-provider',
      `The active ${provider} session does not support this capability.`
    )
  }
  if (
    provider !== 'kimi' &&
    !(await abortable(adapter.hasToggleCapability(definition.key), signal))
  ) {
    return result(
      'unsupported-provider',
      `Capability not available for ${provider}: ${name}`
    )
  }
  try {
    const state =
      action === 'status'
        ? await abortable(adapter.getToggleState(definition.key), signal)
        : await abortable(
            adapter.setToggleState(definition.key, action),
            signal
          )
    return result('ok', `${provider}.${definition.key}: ${state}`)
  } catch (error) {
    if (
      provider !== 'kimi' ||
      !(error instanceof ProviderAdapterUnsupportedError)
    ) {
      throw error
    }
    return result(
      'unsupported-provider',
      `Capability not available for ${provider}: ${name}`
    )
  }
}

async function executeActionCapability(
  provider: 'doubao' | 'gemini' | 'chatgpt' | 'qwen',
  adapter: unknown,
  name: string,
  args: readonly string[],
  signal: AbortSignal
): Promise<ProviderCapabilityResult> {
  if (!isActionCapabilityAdapter(adapter)) {
    return result(
      'unsupported-provider',
      `The active ${provider} session does not support this capability.`
    )
  }
  if (name === 'none') {
    if (args.length > 0) {
      return result('invalid-args', `Usage: /thread capability ${name}`)
    }
    if (!hasClearActionCapability(adapter)) {
      return result(
        'unsupported-provider',
        `The active ${provider} session does not support clearing capabilities.`
      )
    }
    await abortable(adapter.clearActionCapability(), signal)
    return result('ok', `${provider}.none: cleared`)
  }
  const capabilities = await abortable(adapter.listActionCapabilities(), signal)
  const definition = getProviderCapability(provider, name)
  if (definition?.kind !== 'action') {
    return result(
      'unknown-capability',
      `Unknown capability for ${provider}: ${name}`
    )
  }
  if (!capabilities.some((item) => item.name === name)) {
    return result(
      'unsupported-provider',
      `Capability not available for ${provider}: ${name}`
    )
  }
  if (args.length > 0) {
    return result('invalid-args', `Usage: /thread capability ${name}`)
  }
  const state = await abortable(adapter.selectActionCapability(name), signal)
  if (state === 'disabled' || state === 'unavailable') {
    return result(
      'unsupported-provider',
      state === 'disabled'
        ? `${provider} capability is disabled: ${name}`
        : `Capability not available for ${provider}: ${name}`
    )
  }
  return result('ok', `${provider}.${name}: selected`)
}

function result(
  status: ProviderCapabilityResult['status'],
  message: string
): ProviderCapabilityResult {
  return Object.freeze({ status, message })
}

function actionUsage(): string {
  return '/thread capability <capability>'
}

function toggleUsage(): string {
  return '/thread capability <capability> <on|off|status>'
}

function isActionCapabilityProvider(
  provider: ProviderId
): provider is 'doubao' | 'gemini' | 'chatgpt' | 'qwen' {
  return (
    provider === 'doubao' ||
    provider === 'gemini' ||
    provider === 'chatgpt' ||
    provider === 'qwen'
  )
}

function isToggleCapabilityProvider(
  provider: ProviderId
): provider is 'deepseek' | 'glm' | 'kimi' {
  return provider === 'deepseek' || provider === 'glm' || provider === 'kimi'
}

function isToggleCapabilityAdapter(adapter: unknown): adapter is {
  getToggleState: (capability: ToggleCapability) => Promise<ToggleState>
  hasToggleCapability: (capability: ToggleCapability) => Promise<boolean>
  setToggleState: (
    capability: ToggleCapability,
    targetState: ToggleState
  ) => Promise<ToggleState>
} {
  return (
    typeof adapter === 'object' &&
    adapter !== null &&
    'getToggleState' in adapter &&
    typeof adapter.getToggleState === 'function' &&
    'hasToggleCapability' in adapter &&
    typeof adapter.hasToggleCapability === 'function' &&
    'setToggleState' in adapter &&
    typeof adapter.setToggleState === 'function'
  )
}

function isActionCapabilityAdapter(adapter: unknown): adapter is {
  listActionCapabilities: () => Promise<
    Array<{ name: string; state: ActionCapabilityState }>
  >
  selectActionCapability: (capability: string) => Promise<ActionCapabilityState>
} {
  return (
    typeof adapter === 'object' &&
    adapter !== null &&
    'listActionCapabilities' in adapter &&
    typeof adapter.listActionCapabilities === 'function' &&
    'selectActionCapability' in adapter &&
    typeof adapter.selectActionCapability === 'function'
  )
}

function hasClearActionCapability(adapter: unknown): adapter is {
  clearActionCapability: () => Promise<void>
} {
  return (
    typeof adapter === 'object' &&
    adapter !== null &&
    'clearActionCapability' in adapter &&
    typeof adapter.clearActionCapability === 'function'
  )
}
