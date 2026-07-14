import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'

import { ApplyPatchTool } from '../../../src/tools/builtins/apply-patch-tool.ts'
import {
  extractToolCall,
  parseToolCallPayload,
  ToolRegistry,
} from '../../../src/tools/core/tool-registry.ts'

test('tool extraction preserves named freeform payloads', () => {
  const extracted = extractToolCall(
    'Before\n<tool name="apply_patch">\n*** Begin Patch\n*** End Patch\n</tool>\nAfter'
  )

  assert.deepEqual(extracted, {
    leadingText: 'Before\n',
    declaredToolName: 'apply_patch',
    rawPayload: '\n*** Begin Patch\n*** End Patch\n',
    trailingText: '\nAfter',
  })
  assert.deepEqual(
    parseToolCallPayload(extracted!.rawPayload, extracted!.declaredToolName),
    { tool: 'apply_patch', params: extracted!.rawPayload }
  )
})

test('ToolRegistry keeps JSON tools and executes named freeform tools', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-tool-registry-'))
  const filePath = path.join(root, 'created.txt')
  const adapter = {} as any
  const registry = new ToolRegistry(adapter, [ApplyPatchTool])

  try {
    assert.match(registry.prompt, /<tool name="apply_patch">/)
    const payload = [
      '*** Begin Patch',
      `*** Add File: ${filePath}`,
      '+hello',
      '*** End Patch',
    ].join('\n')
    const result = await registry.executeToolCall(payload, {}, 'apply_patch')
    assert.equal(result.outcome, 'success')
    assert.equal(await readFile(filePath, 'utf8'), 'hello')

    const jsonAttempt = await registry.executeToolCall(
      JSON.stringify({ tool: 'apply_patch', params: payload })
    )
    assert.equal(jsonAttempt.outcome, 'error')
    assert.match(jsonAttempt.displayText ?? '', /freeform payload/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
