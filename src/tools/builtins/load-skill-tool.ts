import type { AbortOptions } from '../../runtime/runtime-cancellation.ts'
import {
  createToolError,
  Tool,
  defineToolMetadata,
} from '../core/tool-definition.ts'
import type { ToolOutput } from '../core/tool-definition.ts'

interface LoadSkillInput {
  name: string
}

@defineToolMetadata({
  name: 'load_skill',
  description: [
    'Load the complete instructions for one available skill into the current conversation.',
    'Use an exact skill name from the available skill catalog.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Exact name of an available skill.',
      },
    },
    required: ['name'],
  },
})
class LoadSkillTool extends Tool<LoadSkillInput, ToolOutput> {
  public async call(
    input: LoadSkillInput,
    _options: AbortOptions = {}
  ): Promise<ToolOutput> {
    if (typeof input.name !== 'string' || input.name.trim() === '') {
      return createToolError(
        'load_skill requires a non-empty string params.name'
      )
    }
    if (this.services.loadSkill === undefined) {
      return createToolError('load_skill is not configured in this runtime')
    }
    return await this.services.loadSkill(input.name)
  }
}

export { LoadSkillTool }
