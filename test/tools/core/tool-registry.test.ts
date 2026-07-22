import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'

import { ApplyPatchTool } from '../../../src/tools/builtins/apply-patch-tool.ts'
import {
  defineToolMetadata,
  Tool,
  type ToolOutput,
} from '../../../src/tools/core/tool-definition.ts'
import {
  extractToolCall,
  formatToolResultMessage,
  parseToolCallPayload,
  projectStreamingAssistantText,
  ToolRegistry,
  type ToolResult,
} from '../../../src/tools/core/tool-registry.ts'
import { createProviderAdapterStub } from '../../helpers/fakes.ts'

@defineToolMetadata({
  name: 'base_metadata',
  description: 'Inherited metadata.',
})
class BaseMetadataTool extends Tool<Record<string, unknown>, ToolOutput> {
  public async call(): Promise<ToolOutput> {
    return { result: {}, displayText: '' }
  }
}

class InheritedMetadataTool extends BaseMetadataTool {}

test('Tool metadata remains inherited through the constructor prototype chain', () => {
  const tool = new InheritedMetadataTool(createProviderAdapterStub())

  assert.equal(tool.name, 'base_metadata')
  assert.equal(tool.metadata.description, 'Inherited metadata.')
})

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
    parseToolCallPayload(extracted.rawPayload, extracted.declaredToolName),
    { tool: 'apply_patch', params: extracted.rawPayload }
  )
})

test('streaming assistant projection hides tool candidates and payloads', () => {
  assert.equal(
    projectStreamingAssistantText('Ordinary response'),
    'Ordinary response'
  )
  assert.equal(projectStreamingAssistantText('Before\n<tool'), 'Before')
  assert.equal(
    projectStreamingAssistantText(
      'Before\n<tool name="apply_patch">\n*** Begin Patch'
    ),
    'Before'
  )
  assert.equal(
    projectStreamingAssistantText(`<tool>\n${'x'.repeat(100_000)}\n</tool>`),
    ''
  )
})

test('streaming assistant projection buffers partial tool prefixes without hiding ordinary tags', () => {
  for (const suffix of ['<', '<t', '<to', '<too']) {
    assert.equal(projectStreamingAssistantText(`Before ${suffix}`), 'Before')
  }

  assert.equal(
    projectStreamingAssistantText('Before <toolbar>'),
    'Before <toolbar>'
  )
  assert.equal(
    projectStreamingAssistantText('Before <toolbox>'),
    'Before <toolbox>'
  )
})

test('streaming assistant projection preserves tool syntax in Markdown code', () => {
  assert.equal(
    projectStreamingAssistantText('Use `<tool>` for a tool call.'),
    'Use `<tool>` for a tool call.'
  )
  assert.equal(
    projectStreamingAssistantText('```xml\n<tool>example\n```'),
    '```xml\n<tool>example\n```'
  )
})

test('streaming assistant projection defers to complete tool extraction', () => {
  assert.equal(
    projectStreamingAssistantText('`unfinished code\n<tool>payload</tool>'),
    '`unfinished code'
  )
})

test('tool result messages add delivery only when the original result is omitted', () => {
  const normalResult: ToolResult = {
    outcome: 'success',
    result: { content: 'complete result' },
  }
  assert.deepEqual(
    JSON.parse(
      formatToolResultMessage('future_tool', normalResult).slice(
        '### Tool Result ###\n'.length
      )
    ),
    {
      tool: 'future_tool',
      outcome: 'success',
      result: { content: 'complete result' },
    }
  )

  for (const outcome of ['success', 'error', 'unknown'] as const) {
    const toolResult: ToolResult = {
      outcome,
      result: { content: `private ${outcome} result` },
    }
    assert.deepEqual(
      JSON.parse(
        formatToolResultMessage('future_tool', toolResult, {
          status: 'not_delivered',
          code: 'COMPOSER_LIMIT_EXCEEDED',
          message: 'The original result was not delivered.',
          measured: 200_000,
          limit: 100_000,
        }).slice('### Tool Result ###\n'.length)
      ),
      {
        tool: 'future_tool',
        outcome,
        result: null,
        delivery: {
          status: 'not_delivered',
          code: 'COMPOSER_LIMIT_EXCEEDED',
          message: 'The original result was not delivered.',
          measured: 200_000,
          limit: 100_000,
        },
      }
    )
    assert.deepEqual(toolResult.result, {
      content: `private ${outcome} result`,
    })
  }
})

test('ToolRegistry keeps JSON tools and executes named freeform tools', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-tool-registry-'))
  const filePath = path.join(root, 'created.txt')
  const adapter = createProviderAdapterStub()
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
