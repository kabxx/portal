import type { PortalExtensionRegistration } from '../extensions/portal-hooks.ts'
import { ExtensionCatalogBuilder } from '../extensions/extension-catalog.ts'
import {
  createPortalCommandsRegistration,
  portalCommandsDescriptor,
  type BuiltinCommandDefinition,
} from '../cli-commands/command-extension.ts'
import { CommandServiceHost } from '../cli-commands/core/command-services.ts'
import { createAttachImagePlugin } from '../tools/builtins/attach-image-plugin.ts'

// First-party and installed packages enter the same catalog path. The command
// package is compiled into Portal for now; it no longer has a special registry path.
export function buildPortalExtensionCatalog(options: {
  readonly commandServices: CommandServiceHost
  readonly commandDefinitions: readonly BuiltinCommandDefinition[]
  readonly installed: readonly PortalExtensionRegistration[]
  readonly testExtensions?: readonly PortalExtensionRegistration[]
}): readonly PortalExtensionRegistration[] {
  const builder = new ExtensionCatalogBuilder()
  const commandRegistration = createPortalCommandsRegistration(
    options.commandServices,
    options.commandDefinitions
  )
  builder.add({
    packageId: portalCommandsDescriptor.id,
    descriptor: commandRegistration.descriptor,
    module: commandRegistration.module,
  })
  const attachImage = createAttachImagePlugin()
  builder.add({
    packageId: attachImage.descriptor.id,
    descriptor: attachImage.descriptor,
    module: attachImage.module,
  })
  for (const registration of options.installed) {
    builder.add({
      packageId: registration.descriptor.id,
      descriptor: registration.descriptor,
      module: registration.module,
    })
  }
  for (const registration of options.testExtensions ?? []) {
    builder.add({
      packageId: registration.descriptor.id,
      descriptor: registration.descriptor,
      module: registration.module,
    })
  }
  return Object.freeze(
    builder
      .build()
      .map(({ descriptor, module }) => Object.freeze({ descriptor, module }))
  )
}
