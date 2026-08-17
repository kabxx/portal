import { createServiceRef } from '../extensions/extension-contracts.ts'
import type {
  ToolContribution,
  ToolHost,
  ToolResult,
  ToolProgressEvent,
} from './tool-host.ts'
import type { Capability } from '../extensions/extension-contracts.ts'
import type { ChildConversationParent } from '../threads/child-conversation-service.ts'

export interface ToolRuntimeService {
  list(): readonly ToolContribution[]
  execute(
    name: string,
    input: Record<string, unknown> | string,
    requestId: string,
    options?: {
      readonly signal?: AbortSignal
      readonly availableCapabilities?: readonly Capability[]
      readonly onProgress?: (event: ToolProgressEvent) => void
      readonly invocation?: ChildConversationParent
    }
  ): Promise<ToolResult>
}

export const toolRuntimeService = createServiceRef<ToolRuntimeService>({
  id: 'portal.kernel.tools.runtime',
  version: 1,
  scope: 'portal',
})

export class ToolRuntimeServiceHost implements ToolRuntimeService {
  #delegate: ToolHost | null = null

  public bind(delegate: ToolHost): () => void {
    if (this.#delegate !== null) {
      throw new Error('Tool runtime service is already bound.')
    }
    this.#delegate = delegate
    return () => {
      if (this.#delegate === delegate) this.#delegate = null
    }
  }

  public list(): readonly ToolContribution[] {
    return this.#requireDelegate().list()
  }

  public async execute(
    name: string,
    input: Record<string, unknown> | string,
    requestId: string,
    options: Parameters<ToolHost['execute']>[3] = {}
  ): Promise<ToolResult> {
    return await this.#requireDelegate().execute(
      name,
      input,
      requestId,
      options
    )
  }

  #requireDelegate(): ToolHost {
    if (this.#delegate === null) {
      throw new Error('Tool runtime service is not active.')
    }
    return this.#delegate
  }
}
