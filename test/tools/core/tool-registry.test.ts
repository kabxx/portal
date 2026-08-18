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
  isToolCallAtResponseEnd,
  parseToolCallPayload,
  projectStreamingAssistantText,
  type ToolResult,
} from '../../../src/tools/core/tool-registry.ts'
import { createProviderAdapterStub } from '../../helpers/fakes.ts'
import { PORTAL_ACTION_PROTOCOL } from '../../../src/providers/portal-action-protocol.ts'
import { createTestToolRegistry } from '../../helpers/tool-host.ts'

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

@defineToolMetadata({
  name: 'json_echo',
  description: 'Returns its JSON input.',
  inputSchema: {
    type: 'object',
    properties: {
      value: { type: 'string' },
    },
    required: ['value'],
  },
})
class JsonEchoTool extends Tool<Record<string, unknown>, ToolOutput> {
  public async call(input: Record<string, unknown>): Promise<ToolOutput> {
    return {
      result: { input },
      displayText: JSON.stringify(input),
    }
  }
}

@defineToolMetadata({
  name: 'freeform_echo',
  description: 'Returns its freeform input.',
  inputFormat: 'freeform',
})
class FreeformEchoTool extends Tool<string, ToolOutput> {
  public async call(input: string): Promise<ToolOutput> {
    return {
      result: { input },
      displayText: input,
    }
  }
}

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

test('named payload parsing follows the declared tool input format', () => {
  assert.deepEqual(
    parseToolCallPayload('{"value":"json"}', 'json_echo', 'json'),
    { tool: 'json_echo', params: { value: 'json' } }
  )
  assert.equal(parseToolCallPayload('[]', 'json_echo', 'json'), null)
  assert.deepEqual(
    parseToolCallPayload('{"value":"raw"}', 'freeform_echo', 'freeform'),
    { tool: 'freeform_echo', params: '{"value":"raw"}' }
  )
  assert.equal(
    parseToolCallPayload('{"tool":"json_echo","params":{"value":"legacy"}}'),
    null
  )
})

test('Portal Action Protocol converts JSON and freeform actions into internal ToolCalls', async () => {
  const registry = createTestToolRegistry(
    createProviderAdapterStub(),
    [JsonEchoTool, FreeformEchoTool],
    { protocol: PORTAL_ACTION_PROTOCOL }
  )

  const json = await registry.extractToolCall(
    'Before\n<action name="json_echo">{"value":"json"}</action>'
  )
  assert.deepEqual(json, {
    leadingText: 'Before\n',
    declaredToolName: 'json_echo',
    rawPayload: '{"value":"json"}',
    trailingText: '',
  })
  assert.deepEqual(
    registry.parseToolCallPayload(
      json?.rawPayload ?? '',
      json?.declaredToolName
    ),
    { tool: 'json_echo', params: { value: 'json' } }
  )

  const freeform = await registry.extractToolCall(
    '<action name="freeform_echo">raw payload</action>'
  )
  assert.deepEqual(
    registry.parseToolCallPayload(
      freeform?.rawPayload ?? '',
      freeform?.declaredToolName
    ),
    { tool: 'freeform_echo', params: 'raw payload' }
  )

  const result = registry.formatToolResultMessage('json_echo', {
    outcome: 'success',
    result: { value: 'done' },
  })
  assert.equal(
    result,
    '### Action Result ###\n' +
      JSON.stringify(
        {
          action: 'json_echo',
          outcome: 'success',
          result: { value: 'done' },
        },
        null,
        2
      )
  )
})

test('ToolRegistry with a null text protocol does not advertise or parse text Tools', async () => {
  const registry = createTestToolRegistry(
    createProviderAdapterStub(),
    [JsonEchoTool],
    { protocol: null }
  )

  assert.equal(registry.prompt, '')
  assert.equal(
    await registry.extractToolCall(
      '<tool name="json_echo">{"value":"x"}</tool>'
    ),
    null
  )
  assert.equal(
    registry.projectStreamingAssistantText(
      'Answer <tool name="json_echo">{"value":"x"}</tool>'
    ),
    'Answer <tool name="json_echo">{"value":"x"}</tool>'
  )
  assert.throws(
    () =>
      registry.formatToolResultMessage('json_echo', {
        outcome: 'success',
        result: { value: 'x' },
      }),
    /Text Tool protocol is disabled/
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

test('streaming assistant projection restores non-terminal tool blocks', () => {
  const response = [
    'Before',
    '<tool name="json_echo">{"value":"example"}</tool>',
    'After',
  ].join('\n')
  const extracted = extractToolCall(response)

  assert.ok(extracted)
  assert.equal(isToolCallAtResponseEnd(extracted), false)
  assert.equal(projectStreamingAssistantText(response), response)
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
  const registry = createTestToolRegistry(adapter, [ApplyPatchTool])

  try {
    assert.match(registry.prompt, /^### apply_patch/)
    assert.doesNotMatch(registry.prompt, /Examples?:|<tool name=/)
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
    assert.match(jsonAttempt.displayText ?? '', /tool calls require/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ToolRegistry can hide a registered tool from its prompt', async () => {
  const registry = createTestToolRegistry(
    createProviderAdapterStub(),
    [JsonEchoTool],
    { hiddenToolNames: ['json_echo'] }
  )

  assert.doesNotMatch(registry.prompt, /### json_echo/)
  const result = await registry.executeToolCall(
    '{"value":"hidden"}',
    {},
    'json_echo'
  )
  assert.equal(result.outcome, 'success')
  assert.deepEqual(result.result, { input: { value: 'hidden' } })
})

test('ToolRegistry advertises only names, descriptions, and parameters', async () => {
  const registry = createTestToolRegistry(createProviderAdapterStub(), [
    JsonEchoTool,
    FreeformEchoTool,
  ])

  assert.equal(
    registry.prompt,
    [
      '### json_echo',
      'Description: Returns its JSON input.',
      'Parameters (JSON): {value: string}',
      '',
      '### freeform_echo',
      'Description: Returns its freeform input.',
      'Parameters (freeform): raw text',
    ].join('\n')
  )
  assert.doesNotMatch(registry.prompt, /Examples?:|<tool name=|```/)

  const namedJson = await registry.executeToolCall(
    '{"value":"named"}',
    {},
    'json_echo'
  )
  assert.equal(namedJson.outcome, 'success')
  assert.deepEqual(namedJson.result, { input: { value: 'named' } })

  const legacyJson = await registry.executeToolCall(
    '{"tool":"json_echo","params":{"value":"legacy"}}'
  )
  assert.equal(legacyJson.outcome, 'error')
  assert.match(legacyJson.displayText ?? '', /tool calls require/i)

  const jsonLookingFreeform = await registry.executeToolCall(
    '{"value":"raw"}',
    {},
    'freeform_echo'
  )
  assert.equal(jsonLookingFreeform.outcome, 'success')
  assert.deepEqual(jsonLookingFreeform.result, { input: '{"value":"raw"}' })

  const invalidJson = await registry.executeToolCall('[]', {}, 'json_echo')
  assert.equal(invalidJson.outcome, 'error')
  assert.match(
    invalidJson.displayText ?? '',
    /Tool json_echo payload must be a JSON object/
  )
})
