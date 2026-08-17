import { createServiceRef } from './extension-contracts.ts'

export interface PortalWorkspaceContext {
  readonly cwd: string
  readonly dataDirectory: string
  readonly projectInstructionsEnabled: boolean
}

export const portalWorkspaceService = createServiceRef<PortalWorkspaceContext>({
  id: 'portal.kernel.workspace',
  version: 1,
  scope: 'portal',
})
