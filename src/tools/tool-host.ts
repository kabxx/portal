import { z } from 'zod'

import type {
  Capability,
  ContributionSpec,
  ExecutableBindingSpec,
} from '../extensions/extension-contracts.ts'
import {
  createContributionRef,
  createExecutableBindingRef,
} from '../extensions/extension-contracts.ts'
import type { ExtensionRegistry } from '../extensions/extension-registry.ts'
import type { ResolvedExtensionGraph } from '../extensions/extension-registry.ts'
import { ResourceScope } from '../shared/resource-scope.ts'
import { PROVIDER_ATTACHMENT_CAPABILITY } from '../providers/provider-exchange.ts'

export interface ToolContribution {
  readonly id: string
  readonly descriptor: {
    readonly name: string
    readonly description: string
    readonly inputSchema: Record<string, unknown>
  }
  readonly requiredCapabilities: readonly Capability[]
  readonly handlerBindingId: string
}

export interface ToolResult {
  readonly status: 'success' | 'error' | 'unknown'
  readonly output: Record<string, unknown>
  readonly displayText?: string
}

export interface ToolHandlerContext {
  readonly requestId: string
  readonly signal: AbortSignal
  readonly scope: { readonly name: string; readonly signal: AbortSignal }
  readonly capabilities: readonly Capability[]
}

export type ToolHandler = (
  input: Record<string, unknown> | string,
  context: ToolHandlerContext
) => ToolResult | Promise<ToolResult>

export const toolContributions = createContributionRef<ToolContribution>({
  id: 'tools.collect',
  version: 1,
})

export const toolHandlerBindings = createExecutableBindingRef<ToolHandler>({
  id: 'tools.handlers',
  version: 1,
  kind: 'tool-handler',
})

const stableId = z.string().regex(/^[a-z0-9][a-z0-9._:/-]*$/)
const toolContributionSchema = z
  .object({
    id: stableId,
    descriptor: z
      .object({
        name: stableId,
        description: z.string().trim().min(1),
        inputSchema: z.record(z.string(), z.unknown()),
      })
      .strict(),
    requiredCapabilities: z.array(stableId),
    handlerBindingId: stableId,
  })
  .strict()

export const toolContributionSpec: ContributionSpec<ToolContribution> =
  Object.freeze({
    ref: toolContributions,
    schema: Object.freeze({
      parse(value: unknown): ToolContribution {
        const parsed = toolContributionSchema.parse(value)
        if (
          new Set(parsed.requiredCapabilities).size !==
          parsed.requiredCapabilities.length
        ) {
          throw new TypeError('Tool capabilities must not contain duplicates.')
        }
        return Object.freeze({
          id: parsed.id,
          descriptor: Object.freeze({
            name: parsed.descriptor.name,
            description: parsed.descriptor.description,
            inputSchema: Object.freeze({ ...parsed.descriptor.inputSchema }),
          }),
          requiredCapabilities: Object.freeze([...parsed.requiredCapabilities]),
          handlerBindingId: parsed.handlerBindingId,
        })
      },
    }),
    identityOf: (value: ToolContribution) => value.id,
    conflictKeyOf: (value: ToolContribution) => value.descriptor.name,
    maxPerConflictKey: 1,
    selection: 'all',
    ordering: 'dependency-edges',
    allowedServices: Object.freeze([]),
    allowedCapabilities: Object.freeze([PROVIDER_ATTACHMENT_CAPABILITY]),
  })

export const toolHandlerBindingSpec: ExecutableBindingSpec<ToolHandler> =
  Object.freeze({
    ref: toolHandlerBindings,
    targetContribution: toolContributions,
    cardinality: 'exactly-one-per-target',
    ownership: 'same-owner',
    capture(binding: ToolHandler) {
      if (typeof binding !== 'function') {
        throw new TypeError('Tool handler binding must be a function.')
      }
      return binding
    },
  })

export function defineToolHost(registry: ExtensionRegistry): void {
  registry.defineContribution(toolContributionSpec)
  registry.defineExecutableBinding(toolHandlerBindingSpec)
}

export class ToolHostError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'ToolHostError'
  }
}

export class ToolHost {
  readonly #graph: ResolvedExtensionGraph
  readonly #parent: ResourceScope

  public constructor(options: {
    readonly graph: ResolvedExtensionGraph
    readonly parent: ResourceScope
  }) {
    this.#graph = options.graph
    this.#parent = options.parent
  }

  public list(): readonly ToolContribution[] {
    return Object.freeze(
      this.#graph
        .contributions(toolContributions)
        .map((contribution) => contribution.value)
    )
  }

  public async execute(
    name: string,
    input: Record<string, unknown> | string,
    requestId: string,
    options: {
      readonly signal?: AbortSignal
      readonly availableCapabilities?: readonly Capability[]
    } = {}
  ): Promise<ToolResult> {
    const contribution = this.#graph
      .contributions(toolContributions)
      .find((item) => item.value.descriptor.name === name)
    if (contribution === undefined) {
      throw new ToolHostError(`Tool is not available: ${name}.`)
    }
    const binding = this.#graph
      .executableBindings(toolHandlerBindings)
      .find((item) => item.targetId === contribution.id)
    if (binding === undefined || binding.owner !== contribution.owner) {
      throw new ToolHostError(`Tool ${name} has no same-owner handler.`)
    }
    if (binding.id !== contribution.value.handlerBindingId) {
      throw new ToolHostError(`Tool ${name} handler binding ID does not match.`)
    }
    const availableCapabilities = options.availableCapabilities ?? []
    const available = new Set(availableCapabilities)
    const missing = contribution.value.requiredCapabilities.filter(
      (capability) => !available.has(capability)
    )
    if (missing.length > 0) {
      throw new ToolHostError(
        `Tool ${name} requires unavailable capabilities: ${missing.join(', ')}.`
      )
    }
    const scope = this.#parent.createChild(`tool:${name}:${requestId}`)
    const externalSignal = options.signal
    const abortScope = () => {
      void scope.dispose({ reason: externalSignal?.reason })
    }
    if (externalSignal?.aborted === true) abortScope()
    else externalSignal?.addEventListener('abort', abortScope, { once: true })
    try {
      if (scope.signal.aborted) throw scope.signal.reason
      const handler = Promise.resolve(
        binding.binding(input, {
          requestId,
          signal: scope.signal,
          scope,
          capabilities: Object.freeze([...availableCapabilities]),
        })
      )
      void handler.catch(() => undefined)
      const result = await raceWithAbort(
        handler,
        scope.signal,
        `Tool ${name} execution canceled.`
      )
      return normalizeToolResult(result, name)
    } finally {
      externalSignal?.removeEventListener('abort', abortScope)
      await scope.dispose({ reason: 'tool-complete' })
    }
  }
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  message: string
): Promise<T> {
  if (signal.aborted) throw toToolError(signal.reason, message)
  let remove = () => {}
  let timeout: ReturnType<typeof setTimeout> | null = null
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => {
      timeout = setTimeout(
        () => reject(toToolError(signal.reason, message)),
        TOOL_CANCELLATION_GRACE_MS
      )
    }
    signal.addEventListener('abort', onAbort, { once: true })
    remove = () => signal.removeEventListener('abort', onAbort)
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    remove()
    if (timeout !== null) clearTimeout(timeout)
  }
}

function toToolError(reason: unknown, fallback: string): ToolHostError {
  return new ToolHostError(
    reason instanceof Error && reason.message !== '' ? reason.message : fallback
  )
}

const TOOL_CANCELLATION_GRACE_MS = 100

function normalizeToolResult(value: ToolResult, name: string): ToolResult {
  if (
    value === null ||
    typeof value !== 'object' ||
    (value.status !== 'success' &&
      value.status !== 'error' &&
      value.status !== 'unknown') ||
    value.output === null ||
    typeof value.output !== 'object' ||
    Array.isArray(value.output)
  ) {
    throw new ToolHostError(`Tool ${name} returned an invalid result.`)
  }
  const displayText = value.displayText
  if (displayText !== undefined && typeof displayText !== 'string') {
    throw new ToolHostError(`Tool ${name} returned invalid display text.`)
  }
  return Object.freeze({
    status: value.status,
    output: Object.freeze({ ...value.output }),
    ...(displayText === undefined ? {} : { displayText }),
  })
}
