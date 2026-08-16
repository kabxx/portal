import type {
  ExtensionDescriptor,
  ExtensionModule,
} from './extension-contracts.ts'
export interface CatalogExtensionRegistration {
  readonly packageId: string
  readonly descriptor: ExtensionDescriptor
  readonly module: ExtensionModule
}

export class ExtensionCatalogBuilder {
  readonly #registrations = new Map<string, CatalogExtensionRegistration>()

  public add(registration: CatalogExtensionRegistration): void {
    if (this.#registrations.has(registration.packageId)) {
      throw new Error(
        `Duplicate extension package in catalog: ${registration.packageId}`
      )
    }
    if (registration.descriptor.id !== registration.packageId) {
      throw new Error(
        `Catalog package ${registration.packageId} does not match descriptor ${registration.descriptor.id}.`
      )
    }
    this.#registrations.set(registration.packageId, Object.freeze(registration))
  }

  public build(): readonly CatalogExtensionRegistration[] {
    return Object.freeze(
      [...this.#registrations.values()].sort((a, b) =>
        a.packageId.localeCompare(b.packageId)
      )
    )
  }
}
