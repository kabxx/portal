import { Tool, defineToolMetadata } from '../core/tool-definition.ts'
import type { ToolOutput } from '../core/tool-definition.ts'

@defineToolMetadata({
  name: 'attach_image',
  description: [
    'Attach a local image file to the current browser conversation so the browser model can inspect it if the upload succeeds.',
    'Use this tool when the user asks you to inspect an image and provides its local path.',
    'Do not ask the user to upload the image manually when this tool can attach the provided path.',
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
  examples: [
    {
      params: {
        path: 'C:\\Users\\XXX\\Pictures\\image.webp',
      },
    },
  ],
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
