import {
  ResourceScope,
  type ResourceDisposer,
} from '../shared/resource-scope.ts'
import type {
  ResourceScopeKind,
  ResourceScopeRegistration,
  ScopedResourceDisposer,
  ScopedResourceFactory,
} from './extension-contracts.ts'
import { ExtensionCapabilityExpiredError } from './extension-errors.ts'

export class ExtensionResourceScope {
  readonly #registration: ResourceScopeRegistration

  public constructor(
    public readonly kind: ResourceScopeKind,
    public readonly resourceId: string,
    public readonly resourceScope: ResourceScope,
    public readonly parent: ExtensionResourceScope | null = null
  ) {
    this.#registration = this.createRegistration()
  }

  public get registration(): ResourceScopeRegistration {
    return this.#registration
  }

  public createRegistration(
    options: {
      readonly signal?: AbortSignal
      readonly assertActive?: () => void
    } = {}
  ): ResourceScopeRegistration {
    const signal = options.signal ?? this.resourceScope.signal
    const assertActive =
      options.assertActive ??
      (() => {
        if (this.resourceScope.state !== 'open') {
          throw new ExtensionCapabilityExpiredError('Resource registration')
        }
      })
    return Object.freeze({
      kind: this.kind,
      signal,
      defer: (label: string, disposer: ResourceDisposer) => {
        assertActive()
        return this.resourceScope.defer(label, disposer)
      },
      acquire: async <Resource>(
        label: string,
        factory: ScopedResourceFactory<Resource>,
        disposer: ScopedResourceDisposer<Resource>
      ) => {
        assertActive()
        const resource = await this.resourceScope.acquire(
          label,
          async () => {
            assertActive()
            return await factory(signal)
          },
          disposer
        )
        assertActive()
        return resource
      },
    })
  }

  public createChild(
    kind: ResourceScopeKind,
    resourceId: string
  ): ExtensionResourceScope {
    return new ExtensionResourceScope(
      kind,
      resourceId,
      this.resourceScope.createChild(`${kind}:${resourceId}`),
      this
    )
  }

  public find(kind: ResourceScopeKind): ExtensionResourceScope | null {
    return findMatchingScope(this, kind)
  }
}

function findMatchingScope(
  start: ExtensionResourceScope,
  kind: ResourceScopeKind
): ExtensionResourceScope | null {
  let match: ExtensionResourceScope | null = null
  let current: ExtensionResourceScope | null = start
  while (current !== null) {
    if (current.kind === kind) match = current
    current = current.parent
  }
  return match
}
