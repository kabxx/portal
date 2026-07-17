import type { ProviderId } from '../../providers/provider-id.ts'
import type { RuntimeCore } from '../../runtime/runtime-core.ts'
import type { CliCommandContext, CommandResult } from '../core/command-types.ts'
import { getActiveThread } from '../core/command-types.ts'

const THREAD_CAPABILITY_LABEL = '/thread capability'

interface ProviderCapability {
  name: string
  description: string
  kind: 'toggle' | 'action'
}

export interface ProviderCapabilityState {
  name: string
  state: string
}

type ActionCapabilityState =
  | 'available'
  | 'selected'
  | 'cleared'
  | 'disabled'
  | 'unavailable'

type ToggleCapability = 'thinking' | 'search' | 'advanced_search'
type ToggleState = 'on' | 'off'

interface ActionCapabilityInfo {
  name: string
  state: ActionCapabilityState
}

export interface ProviderCapabilityResult {
  title: string
  body: string
  format: 'plain' | 'markdown'
}

type ProviderCapabilityStatus =
  | 'ok'
  | 'invalid_args'
  | 'unknown_capability'
  | 'unsupported_provider'

export interface ProviderCapabilityExecution {
  status: ProviderCapabilityStatus
  result: ProviderCapabilityResult
}

const PROVIDER_CAPABILITIES: Record<ProviderId, readonly ProviderCapability[]> =
  {
    chatgpt: [],
    gemini: [],
    deepseek: [
      {
        name: 'thinking',
        description: 'Deep thinking mode.',
        kind: 'toggle',
      },
      {
        name: 'search',
        description: 'Smart search mode.',
        kind: 'toggle',
      },
    ],
    doubao: [],
    grok: [],
    glm: [
      {
        name: 'thinking',
        description: 'Deep thinking mode.',
        kind: 'toggle',
      },
      {
        name: 'search',
        description: 'Smart search mode.',
        kind: 'toggle',
      },
      {
        name: 'advanced_search',
        description: 'Multi-round advanced search mode.',
        kind: 'toggle',
      },
    ],
    qwen: [],
    kimi: [],
  }

export async function executeThreadCapability(
  context: CliCommandContext,
  args: readonly string[]
): Promise<CommandResult> {
  const activeThread = getActiveThread(context)
  if (activeThread === null) {
    context.ui.renderWarning(
      THREAD_CAPABILITY_LABEL,
      'No active thread. Use /thread open <provider> first.'
    )
    return { continue: true }
  }

  const capabilityName = args[0] ?? ''
  if (capabilityName) {
    const execution = await executeProviderCapability(
      activeThread.provider,
      activeThread.runtime,
      capabilityName,
      args.slice(1)
    )
    if (execution.status === 'ok') {
      context.ui.renderSuccess(
        execution.result.title,
        execution.result.body,
        execution.result.format
      )
    } else {
      context.ui.renderWarning(
        execution.result.title,
        execution.result.body,
        execution.result.format
      )
    }
    return { continue: true }
  }

  const capabilities = await listProviderCapabilityStates(
    activeThread.provider,
    activeThread.runtime
  )
  if (capabilities.length === 0) {
    context.ui.renderWarning(
      THREAD_CAPABILITY_LABEL,
      `No capabilities available for ${activeThread.provider}.`
    )
    return { continue: true }
  }

  context.ui.renderInfo(
    THREAD_CAPABILITY_LABEL,
    formatCapabilityList(activeThread.provider, capabilities)
  )
  return { continue: true }
}

function formatCapabilityList(
  provider: ProviderId,
  capabilities: readonly { name: string; state: string }[]
): string {
  const longestNameLength = Math.max(
    ...capabilities.map((capability) => capability.name.length)
  )

  return [
    `Provider: ${provider}`,
    '',
    'Capabilities:',
    ...capabilities.map(
      (capability) =>
        `  ${capability.name.padEnd(longestNameLength)}  ${capability.state}`
    ),
    '',
    'Usage:',
    isToggleCapabilityProvider(provider)
      ? '  /thread capability <capability> <on|off|status>'
      : '  /thread capability <capability>',
  ].join('\n')
}

export async function listProviderCapabilityStates(
  provider: ProviderId,
  runtime: RuntimeCore
): Promise<readonly ProviderCapabilityState[]> {
  if (isToggleCapabilityProvider(provider)) {
    const adapter = runtime.getAdapter()
    if (!isToggleCapabilityAdapter(adapter)) {
      return []
    }

    const states: ProviderCapabilityState[] = []
    for (const capability of PROVIDER_CAPABILITIES[provider]) {
      if (
        isToggleCapability(capability.name) &&
        (await adapter.hasToggleCapability(capability.name))
      ) {
        states.push({
          name: capability.name,
          state: await adapter.getToggleState(capability.name),
        })
      }
    }
    return states
  }

  if (
    provider === 'doubao' ||
    provider === 'gemini' ||
    provider === 'chatgpt' ||
    provider === 'qwen'
  ) {
    const adapter = runtime.getAdapter()
    if (!isActionCapabilityAdapter(adapter)) {
      return []
    }
    return await adapter.listActionCapabilities()
  }

  return []
}

export async function executeProviderCapability(
  provider: ProviderId,
  runtime: RuntimeCore,
  name: string,
  args: readonly string[]
): Promise<ProviderCapabilityExecution> {
  if (
    provider === 'doubao' ||
    provider === 'gemini' ||
    provider === 'chatgpt' ||
    provider === 'qwen'
  ) {
    return await executeActionCapability(provider, runtime, name, args)
  }

  if (!isToggleCapabilityProvider(provider)) {
    return {
      status: 'unsupported_provider',
      result: {
        title: THREAD_CAPABILITY_LABEL,
        body: `No capabilities available for ${provider}.`,
        format: 'plain',
      },
    }
  }

  if (
    !isToggleCapability(name) ||
    !PROVIDER_CAPABILITIES[provider].some(
      (capability) => capability.name === name
    )
  ) {
    return {
      status: 'unknown_capability',
      result: {
        title: THREAD_CAPABILITY_LABEL,
        body: `Unknown capability for ${provider}: ${name}`,
        format: 'plain',
      },
    }
  }

  const action = args[0] ?? ''
  if (action !== 'on' && action !== 'off' && action !== 'status') {
    return {
      status: 'invalid_args',
      result: {
        title: THREAD_CAPABILITY_LABEL,
        body: `Usage: /thread capability ${name} <on|off|status>`,
        format: 'plain',
      },
    }
  }

  const adapter = runtime.getAdapter()
  if (!isToggleCapabilityAdapter(adapter)) {
    return {
      status: 'unsupported_provider',
      result: {
        title: THREAD_CAPABILITY_LABEL,
        body: `The active ${formatProviderName(provider)} runtime does not support this capability.`,
        format: 'plain',
      },
    }
  }

  const capability = name
  if (!(await adapter.hasToggleCapability(capability))) {
    return {
      status: 'unsupported_provider',
      result: {
        title: THREAD_CAPABILITY_LABEL,
        body: `Capability not available for ${provider}: ${name}`,
        format: 'plain',
      },
    }
  }

  const state =
    action === 'status'
      ? await adapter.getToggleState(capability)
      : await adapter.setToggleState(capability, action)

  return {
    status: 'ok',
    result: {
      title: THREAD_CAPABILITY_LABEL,
      body: `${provider}.${name}: ${state}`,
      format: 'plain',
    },
  }
}

async function executeActionCapability(
  provider: 'doubao' | 'gemini' | 'chatgpt' | 'qwen',
  runtime: RuntimeCore,
  name: string,
  args: readonly string[]
): Promise<ProviderCapabilityExecution> {
  const adapter = runtime.getAdapter()
  if (!isActionCapabilityAdapter(adapter)) {
    return {
      status: 'unsupported_provider',
      result: {
        title: THREAD_CAPABILITY_LABEL,
        body: `The active ${formatProviderName(provider)} runtime does not support this capability.`,
        format: 'plain',
      },
    }
  }

  if (name === 'none') {
    if (args.length > 0) {
      return {
        status: 'invalid_args',
        result: {
          title: THREAD_CAPABILITY_LABEL,
          body: `Usage: /thread capability ${name}`,
          format: 'plain',
        },
      }
    }
    if (!hasClearActionCapability(adapter)) {
      return {
        status: 'unsupported_provider',
        result: {
          title: THREAD_CAPABILITY_LABEL,
          body: `The active ${formatProviderName(provider)} runtime does not support clearing capabilities.`,
          format: 'plain',
        },
      }
    }
    await adapter.clearActionCapability()
    return {
      status: 'ok',
      result: {
        title: THREAD_CAPABILITY_LABEL,
        body: `${provider}.none: cleared`,
        format: 'plain',
      },
    }
  }

  const capabilities = await adapter.listActionCapabilities()
  if (!capabilities.some((item) => item.name === name)) {
    return {
      status: 'unknown_capability',
      result: {
        title: THREAD_CAPABILITY_LABEL,
        body: `Unknown capability for ${provider}: ${name}`,
        format: 'plain',
      },
    }
  }

  if (args.length > 0) {
    return {
      status: 'invalid_args',
      result: {
        title: THREAD_CAPABILITY_LABEL,
        body: `Usage: /thread capability ${name}`,
        format: 'plain',
      },
    }
  }

  const state = await adapter.selectActionCapability(name)
  if (state === 'disabled') {
    return {
      status: 'unsupported_provider',
      result: {
        title: THREAD_CAPABILITY_LABEL,
        body: `${formatProviderName(provider)} capability is disabled: ${name}`,
        format: 'plain',
      },
    }
  }
  if (state === 'unavailable') {
    return {
      status: 'unsupported_provider',
      result: {
        title: THREAD_CAPABILITY_LABEL,
        body: `Capability not available for ${provider}: ${name}`,
        format: 'plain',
      },
    }
  }

  return {
    status: 'ok',
    result: {
      title: THREAD_CAPABILITY_LABEL,
      body: `${provider}.${name}: selected`,
      format: 'plain',
    },
  }
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

function isToggleCapability(value: string): value is ToggleCapability {
  return (
    value === 'thinking' || value === 'search' || value === 'advanced_search'
  )
}

export function isToggleCapabilityProvider(
  provider: ProviderId
): provider is 'deepseek' | 'glm' {
  return provider === 'deepseek' || provider === 'glm'
}

function isActionCapabilityAdapter(adapter: unknown): adapter is {
  listActionCapabilities: () => Promise<ActionCapabilityInfo[]>
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
