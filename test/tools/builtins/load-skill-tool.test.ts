import test from 'node:test'
import assert from 'node:assert/strict'

import { LoadSkillTool } from '../../../src/tools/builtins/load-skill-tool.ts'
import { createProviderAdapterStub } from '../../helpers/fakes.ts'

test('LoadSkillTool loads an exact runtime skill catalog entry', async () => {
  const names: string[] = []
  const tool = new LoadSkillTool(createProviderAdapterStub(), {
    loadSkill: async (name) => {
      names.push(name)
      return {
        result: {
          name,
          directory: `C:\\skills\\${name}`,
          resources: [],
          instructions: 'instructions',
        },
        displayText: `Loaded skill: ${name}`,
      }
    },
  })

  const output = await tool.call({ name: 'pdf-processing' })
  assert.deepEqual(names, ['pdf-processing'])
  assert.deepEqual(output, {
    result: {
      name: 'pdf-processing',
      directory: 'C:\\skills\\pdf-processing',
      resources: [],
      instructions: 'instructions',
    },
    displayText: 'Loaded skill: pdf-processing',
  })
})

test('LoadSkillTool validates names and runtime availability', async () => {
  const tool = new LoadSkillTool(createProviderAdapterStub())

  assert.deepEqual(await tool.call({ name: '' }), {
    outcome: 'error',
    result: {
      message: 'load_skill requires a non-empty string params.name',
    },
    displayText: 'load_skill requires a non-empty string params.name',
  })
  assert.deepEqual(await tool.call({ name: 'missing' }), {
    outcome: 'error',
    result: { message: 'load_skill is not configured in this runtime' },
    displayText: 'load_skill is not configured in this runtime',
  })
})
