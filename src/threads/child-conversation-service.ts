import { createServiceRef } from '../extensions/extension-contracts.ts'

export interface ChildConversationParent {
  readonly providerId: string
  readonly model: {
    readonly key: string
    readonly option: string | null
  } | null
  readonly spawnDepth: number
  readonly workingDirectory: string
}

export interface ChildConversationRequest {
  readonly prompt: string
  readonly providerId?: string
}

export type ChildConversationResult =
  | {
      readonly provider: string
      readonly conversationUrl: string
      readonly output: string
    }
  | { readonly kind: 'error'; readonly message: string }

export interface ChildConversationService {
  run(
    request: ChildConversationRequest,
    parent: ChildConversationParent,
    signal: AbortSignal
  ): Promise<ChildConversationResult>
}

export const childConversationService =
  createServiceRef<ChildConversationService>({
    id: 'portal.conversations.child',
    version: 1,
    scope: 'portal',
  })

export class ChildConversationServiceHost implements ChildConversationService {
  #delegate: ChildConversationService | null = null

  public bind(delegate: ChildConversationService): () => void {
    if (this.#delegate !== null) {
      throw new Error('Child conversation service is already bound.')
    }
    this.#delegate = delegate
    return () => {
      if (this.#delegate === delegate) this.#delegate = null
    }
  }

  public async run(
    request: ChildConversationRequest,
    parent: ChildConversationParent,
    signal: AbortSignal
  ): Promise<ChildConversationResult> {
    if (this.#delegate === null) {
      throw new Error('Child conversation service is not active.')
    }
    return await this.#delegate.run(request, parent, signal)
  }
}
