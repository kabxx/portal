import { ExtensionCatalogBuilder } from '../extensions/extension-catalog.ts'
import type { PortalExtensionRegistration } from '../extensions/portal-hooks.ts'
import type { ChildConversationService } from '../threads/child-conversation-service.ts'
import { createPortalKernelServicesRegistration } from './portal-kernel-services.ts'
import type { PortalWorkspaceContext } from '../extensions/portal-workspace-service.ts'
import type { PortalBrowserSessionService } from '../platform/browser-session-service.ts'
import type { ToolRuntimeService } from '../tools/tool-runtime-service.ts'

/** Compose only already-resolved packages plus the non-plugin Kernel service bridge. */
export function buildPortalExtensionCatalog(options: {
  readonly resolved: readonly PortalExtensionRegistration[]
  readonly testExtensions?: readonly PortalExtensionRegistration[]
  readonly childConversations: ChildConversationService
  readonly workspace: PortalWorkspaceContext
  readonly browserSession: PortalBrowserSessionService
  readonly tools: ToolRuntimeService
}): readonly PortalExtensionRegistration[] {
  const builder = new ExtensionCatalogBuilder()
  const add = (registration: PortalExtensionRegistration) => {
    builder.add({
      packageId: registration.descriptor.id,
      descriptor: registration.descriptor,
      module: registration.module,
    })
  }

  add(
    createPortalKernelServicesRegistration({
      childConversations: options.childConversations,
      workspace: options.workspace,
      browserSession: options.browserSession,
      tools: options.tools,
    })
  )
  for (const registration of options.resolved) add(registration)
  for (const registration of options.testExtensions ?? []) add(registration)

  return Object.freeze(
    builder
      .build()
      .map(({ descriptor, module }) => Object.freeze({ descriptor, module }))
  )
}
