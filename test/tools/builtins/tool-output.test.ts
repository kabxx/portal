import test from 'node:test'
import assert from 'node:assert/strict'

import { AttachImageTool } from '../../../src/tools/builtins/attach-image-tool.ts'
import { createProviderAdapterStub } from '../../helpers/fakes.ts'

test('AttachImageTool preserves model content and provides display text', async () => {
  const attached: string[] = []
  const adapter = createProviderAdapterStub()
  adapter.attachImage = async (value: string) => {
    attached.push(value)
  }
  const tool = new AttachImageTool(adapter)

  const output = await tool.call({ path: 'C:\\images\\sample.png' })
  assert.deepEqual(attached, ['C:\\images\\sample.png'])
  assert.equal(output.result.attempted, true)
  assert.equal(output.result.path, 'C:\\images\\sample.png')
  assert.match(String(output.result.note), /silently fail/i)
  assert.equal(
    output.displayText,
    'Image attachment attempted.\npath: C:\\images\\sample.png'
  )
})
