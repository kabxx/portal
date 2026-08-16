import { z } from 'zod'

import type {
  ExtensionModule,
  ExtensionRegistrationApi,
} from '../../extensions/extension-contracts.ts'
import { AttachmentFileService } from '../../attachments/attachment-service.ts'
import { PROVIDER_ATTACHMENT_CAPABILITY } from '../../providers/provider-exchange.ts'
import {
  toolContributions,
  toolHandlerBindings,
  type ToolResult,
} from '../tool-host.ts'

export const attachImageContribution = Object.freeze({
  id: 'portal.tool.attach-image',
  descriptor: Object.freeze({
    name: 'attach_image',
    description: 'Attach a local image for inspection.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    }),
  }),
  requiredCapabilities: Object.freeze([PROVIDER_ATTACHMENT_CAPABILITY]),
  handlerBindingId: 'portal.tool.attach-image.handler',
})

const attachImageInput = z.object({ path: z.string().trim().min(1) }).strict()

export function createAttachImagePlugin(
  attachments = new AttachmentFileService()
): {
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
      id: 'portal.tool.attach-image',
      version: '1.0.0',
      dependencies: Object.freeze([]),
      capabilities: Object.freeze([PROVIDER_ATTACHMENT_CAPABILITY]),
    }),
    module: Object.freeze({
      register(api: ExtensionRegistrationApi): void {
        api.contribute(toolContributions, {
          id: attachImageContribution.id,
          value: attachImageContribution,
          requiredServices: [],
          requiredCapabilities: [PROVIDER_ATTACHMENT_CAPABILITY],
        })
        api.bind(toolHandlerBindings, {
          id: attachImageContribution.handlerBindingId,
          targetId: attachImageContribution.id,
          binding: async (
            input: Record<string, unknown> | string
          ): Promise<ToolResult> => {
            try {
              const { path } = attachImageInput.parse(input)
              const attachment = await attachments.createRef(path)
              return {
                status: 'success' as const,
                output: { attachment },
                displayText: `Image prepared for the next Provider exchange.\nattachment: ${attachment.id}`,
              }
            } catch (error) {
              return {
                status: 'error' as const,
                output: {
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              }
            }
          },
        })
      },
    }),
  })
}
