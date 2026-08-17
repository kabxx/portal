import type {
  ExtensionModule,
  ExtensionRegistrationApi,
} from '../../extensions/extension-contracts.ts'
import { executeApplyPatch } from './apply-patch-tool.ts'
import {
  toolContributions,
  toolHandlerBindings,
  type ToolResult,
} from '../tool-host.ts'

export const applyPatchContribution = Object.freeze({
  id: 'portal.tool.apply-patch',
  descriptor: Object.freeze({
    name: 'apply_patch',
    description: 'Create or update UTF-8 files; use it for file writes.',
    inputFormat: 'freeform' as const,
    inputSchema: Object.freeze({ type: 'string' }),
  }),
  requiredCapabilities: Object.freeze([]),
  handlerBindingId: 'portal.tool.apply-patch.handler',
})

export function createApplyPatchPlugin(): {
  readonly descriptor: {
    readonly id: string
    readonly version: string
    readonly dependencies: readonly string[]
    readonly capabilities: readonly string[]
  }
  readonly module: ExtensionModule
} {
  return Object.freeze({
    descriptor: Object.freeze({
      id: 'portal.tool.apply-patch',
      version: '1.0.0',
      dependencies: Object.freeze([]),
      capabilities: Object.freeze([]),
    }),
    module: Object.freeze({
      register(api: ExtensionRegistrationApi): void {
        api.contribute(toolContributions, {
          id: applyPatchContribution.id,
          value: applyPatchContribution,
          requiredServices: Object.freeze([]),
          requiredCapabilities: Object.freeze([]),
        })
        api.bind(toolHandlerBindings, {
          id: applyPatchContribution.handlerBindingId,
          targetId: applyPatchContribution.id,
          binding: async (input): Promise<ToolResult> => {
            const result = await executeApplyPatch(
              typeof input === 'string' ? input : ''
            )
            return {
              status: result.outcome ?? 'success',
              output: result.result,
              displayText: result.displayText,
            }
          },
        })
      },
    }),
  })
}
