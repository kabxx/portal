import type {
  CommandProviderCapabilityResult,
  CommandProviderCapabilityState,
} from '../cli-commands/core/command-services.ts'
import { ProviderAdapterUnsupportedError } from '../providers/adapters/adapter-base.ts'
import {
  getProviderCapability,
  listProviderCapabilities,
  type ProviderCapabilityDefinition,
} from '../providers/provider-definition-pack.ts'
import type { ProviderId } from '../providers/provider-id.ts'
import { abortable } from '../runtime/runtime-cancellation.ts'
import type { RuntimeCore } from '../runtime/runtime-core.ts'

const TITLE = '/thread capability'

type ToggleCapabilityDefinition = Extract<
  ProviderCapabilityDefinition,
  { kind: 'toggle' }
>
type ToggleCapability = ToggleCapabilityDefinition['key']
type ToggleState = 'on' | 'off'
type ActionCapabilityState =
  'available' | 'selected' | 'cleared' | 'disabled' | 'unavailable'

export interface PortalCommandCapabilityList {
  readonly provider: ProviderId
  readonly capabilities: readonly CommandProviderCapabilityState[]
  readonly usage: string
}

export async function listPortalCommandCapabilities(
  provider: ProviderId,
  runtime: RuntimeCore,
  signal: AbortSignal
): Promise<PortalCommandCapabilityList> {
  if (isToggleCapabilityProvider(provider)) {
    const adapter = runtime.getAdapter()
    if (!isToggleCapabilityAdapter(adapter)) {
      return { provider, capabilities: [], usage: toggleUsage() }
    }
    const capabilities: CommandProviderCapabilityState[] = []
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
    return { provider, capabilities, usage: toggleUsage() }
  }

  if (isActionCapabilityProvider(provider)) {
    const adapter = runtime.getAdapter()
    if (!isActionCapabilityAdapter(adapter)) {
      return { provider, capabilities: [], usage: actionUsage() }
    }
    const capabilities = await abortable(
      adapter.listActionCapabilities(),
      signal
    )
    return {
      provider,
      capabilities: capabilities.map(({ name, state }) => ({ name, state })),
      usage: actionUsage(),
    }
  }

  return { provider, capabilities: [], usage: actionUsage() }
}

export async function executePortalCommandCapability(
  provider: ProviderId,
  runtime: RuntimeCore,
  name: string,
  args: readonly string[],
  signal: AbortSignal
): Promise<CommandProviderCapabilityResult> {
  if (isActionCapabilityProvider(provider)) {
    return await executeActionCapability(provider, runtime, name, args, signal)
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
  const adapter = runtime.getAdapter()
  if (!isToggleCapabilityAdapter(adapter)) {
    return result(
      'unsupported-provider',
      `The active ${formatProviderName(provider)} runtime does not support this capability.`
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
  runtime: RuntimeCore,
  name: string,
  args: readonly string[],
  signal: AbortSignal
): Promise<CommandProviderCapabilityResult> {
  const adapter = runtime.getAdapter()
  if (!isActionCapabilityAdapter(adapter)) {
    return result(
      'unsupported-provider',
      `The active ${formatProviderName(provider)} runtime does not support this capability.`
    )
  }
  if (name === 'none') {
    if (args.length > 0) {
      return result('invalid-args', `Usage: /thread capability ${name}`)
    }
    if (!hasClearActionCapability(adapter)) {
      return result(
        'unsupported-provider',
        `The active ${formatProviderName(provider)} runtime does not support clearing capabilities.`
      )
    }
    await abortable(adapter.clearActionCapability(), signal)
    return result('ok', `${provider}.none: cleared`)
  }

  const capabilities = await abortable(adapter.listActionCapabilities(), signal)
  if (!capabilities.some((item) => item.name === name)) {
    return result(
      'unknown-capability',
      `Unknown capability for ${provider}: ${name}`
    )
  }
  if (args.length > 0) {
    return result('invalid-args', `Usage: /thread capability ${name}`)
  }
  const state = await abortable(adapter.selectActionCapability(name), signal)
  if (state === 'disabled') {
    return result(
      'unsupported-provider',
      `${formatProviderName(provider)} capability is disabled: ${name}`
    )
  }
  if (state === 'unavailable') {
    return result(
      'unsupported-provider',
      `Capability not available for ${provider}: ${name}`
    )
  }
  return result('ok', `${provider}.${name}: selected`)
}

function result(
  status: CommandProviderCapabilityResult['status'],
  body: string
): CommandProviderCapabilityResult {
  return { status, title: TITLE, body, format: 'plain' }
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

function formatProviderName(provider: ProviderId): string {
  const names: Record<ProviderId, string> = {
    chatgpt: 'ChatGPT',
    gemini: 'Gemini',
    deepseek: 'DeepSeek',
    doubao: 'Doubao',
    grok: 'Grok',
    glm: 'GLM',
    qwen: 'Qwen',
    kimi: 'Kimi',
  }
  return names[provider]
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

function hasClearActionCapability(
  adapter: unknown
): adapter is { clearActionCapability: () => Promise<void> } {
  return (
    typeof adapter === 'object' &&
    adapter !== null &&
    'clearActionCapability' in adapter &&
    typeof adapter.clearActionCapability === 'function'
  )
}
