import { Tool, defineToolMetadata } from '../core/tool-definition.ts'
import type { ToolOutput } from '../core/tool-definition.ts'

@defineToolMetadata({
  name: 'attach_image',
  description: [
    'Attach local images for inspection. No manual upload required.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path of the image file to attach',
      },
    },
    required: ['path'],
  },
})
class AttachImageTool extends Tool<{ path: string }, ToolOutput> {
  public async call(input: { path: string }): Promise<ToolOutput> {
    await this.providerAdapter.attachImage(input.path)
    return {
      result: {
        attempted: true,
        path: input.path,
        note: 'Some browser AI products may silently fail to attach local images.',
        retryGuidance:
          'If the image is not available for inspection after this attempt, call attach_image once more with the same path before asking the user for help.',
      },
      displayText: `Image attachment attempted.\npath: ${input.path}`,
    }
  }
}

export { AttachImageTool }
