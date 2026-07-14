import test from 'node:test'
import assert from 'node:assert/strict'

import { LoadSkillTool } from '../../../src/tools/builtins/load-skill-tool.ts'

test('LoadSkillTool loads an exact runtime skill catalog entry', async () => {
  const names: string[] = []
  const tool = new LoadSkillTool({} as any, {
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
  const tool = new LoadSkillTool({} as any)

  assert.equal(
    await tool.call({ name: '' }),
    '[ERROR] load_skill requires a non-empty string params.name'
  )
  assert.equal(
    await tool.call({ name: 'missing' }),
    '[ERROR] load_skill is not configured in this runtime'
  )
})
