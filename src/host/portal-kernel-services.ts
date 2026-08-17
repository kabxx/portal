import type { PortalExtensionRegistration } from '../extensions/portal-hooks.ts'
import type { ExtensionRegistrationApi } from '../extensions/extension-contracts.ts'
import {
  portalWorkspaceService,
  type PortalWorkspaceContext,
} from '../extensions/portal-workspace-service.ts'
import {
  childConversationService,
  type ChildConversationService,
} from '../threads/child-conversation-service.ts'
import {
  portalBrowserSessionService,
  type PortalBrowserSessionService,
} from '../platform/browser-session-service.ts'
import {
  toolRuntimeService,
  type ToolRuntimeService,
} from '../tools/tool-runtime-service.ts'

export function createPortalKernelServicesRegistration(services: {
  readonly childConversations: ChildConversationService
  readonly workspace: PortalWorkspaceContext
  readonly browserSession: PortalBrowserSessionService
  readonly tools: ToolRuntimeService
}): PortalExtensionRegistration {
  return Object.freeze({
    descriptor: Object.freeze({
      id: 'portal.kernel.domain-services',
      version: '1.0.0',
      dependencies: Object.freeze([]),
      capabilities: Object.freeze([]),
    }),
    module: Object.freeze({
      register(api: ExtensionRegistrationApi): void {
        api.provide(childConversationService, {
          dependencies: Object.freeze([]),
          create: async () => services.childConversations,
        })
        api.provide(portalWorkspaceService, {
          dependencies: Object.freeze([]),
          create: async () => services.workspace,
        })
        api.provide(portalBrowserSessionService, {
          dependencies: Object.freeze([]),
          create: async () => services.browserSession,
        })
        api.provide(toolRuntimeService, {
          dependencies: Object.freeze([]),
          create: async () => services.tools,
        })
      },
    }),
  })
}
