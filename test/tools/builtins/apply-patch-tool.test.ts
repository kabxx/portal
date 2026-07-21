import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'

import {
  ApplyPatchTool,
  parsePatch,
} from '../../../src/tools/builtins/apply-patch-tool.ts'
import {
  formatToolResultMessage,
  ToolRegistry,
} from '../../../src/tools/core/tool-registry.ts'
import type { ToolOutput } from '../../../src/tools/core/tool-definition.ts'
import { createProviderAdapterStub } from '../../helpers/fakes.ts'

function expectSuccess(output: ToolOutput) {
  assert.notEqual(output.outcome, 'error')
  return output
}

function expectError(output: ToolOutput): string {
  assert.equal(output.outcome, 'error')
  const message = output.result.message
  if (typeof message !== 'string') {
    assert.fail('Expected an error message string.')
  }
  return message
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

test('ApplyPatchTool prompt teaches distinct Add and Update V4A syntax', () => {
  const prompt = new ApplyPatchTool(createProviderAdapterStub()).prompt

  assert.match(prompt, /Invoke it only as <tool name="apply_patch">/)
  assert.match(prompt, /Add File rules: do not use @@/)
  assert.match(prompt, /prefix every content line with \+/)
  assert.match(prompt, /empty content line as a single \+/)
  assert.match(
    prompt,
    /\*\*\* Add File: src\/new\.ts\n\+export const value = 1\n\+\n\+export default value/
  )
  assert.match(prompt, /Update File rules: use @@/)
  assert.match(prompt, /same top-to-bottom order/)
  assert.match(prompt, /matching only moves forward/)
  assert.match(prompt, /Do not put unprefixed blank separator lines/)
  assert.match(
    prompt,
    /export function first\(\)[\s\S]*@@\n export function second\(\)/
  )
})

test('ApplyPatchTool returns a structured error for empty input', async () => {
  const output = await new ApplyPatchTool(createProviderAdapterStub()).call('')

  assert.match(expectError(output), /input must be non-empty/)
  assert.deepEqual(output.result.resolvedPaths, [])
  assert.equal(output.displayText, output.result.message)
})

test('parsePatch extracts multiple V4A Add and Update operations', () => {
  const operations = parsePatch(
    [
      '*** Begin Patch',
      '*** Add File: new.txt',
      '+created',
      '*** Update File: existing.txt',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n')
  )

  assert.deepEqual(
    operations.map(({ kind, path: filePath }) => ({ kind, path: filePath })),
    [
      { kind: 'add', path: 'new.txt' },
      { kind: 'update', path: 'existing.txt' },
    ]
  )
})

test('ApplyPatchTool applies Add and Update files as one planned patch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-apply-patch-'))
  const createdPath = path.join(root, 'nested', 'created.txt')
  const updatedPath = path.join(root, 'updated.txt')
  const createdInputPath = path.relative(process.cwd(), createdPath)
  const updatedInputPath = path.relative(process.cwd(), updatedPath)
  const tool = new ApplyPatchTool(createProviderAdapterStub())
  await writeFile(updatedPath, 'old\n', 'utf8')

  try {
    const output = expectSuccess(
      await tool.call(
        [
          '*** Begin Patch',
          `*** Add File: ${createdInputPath}`,
          '+first',
          '+',
          '+second',
          `*** Update File: ${updatedInputPath}`,
          '@@',
          '-old',
          '+new',
          '*** End Patch',
        ].join('\n')
      )
    )

    assert.equal(await readFile(createdPath, 'utf8'), 'first\n\nsecond')
    assert.equal(await readFile(updatedPath, 'utf8'), 'new\n')
    assert.equal(output.result.operations, 2)
    assert.deepEqual(output.result.resolvedPaths, [createdPath, updatedPath])
    assert.match(output.displayText, /^2 files · \+3 -1\n\*\*\* Begin Patch/)
    assert.ok(
      output.displayText.indexOf('-old') < output.displayText.indexOf('+new')
    )
    assert.match(output.displayText, /\*\*\* Add File:/)
    assert.match(output.displayText, /\*\*\* Update File:/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ApplyPatchTool reports the actual resolved path when cwd assumptions are wrong', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-apply-patch-'))
  const intendedPath = path.join(root, 'FEATURE_PLAN.md')
  const inputPath = path.join(path.basename(root), 'FEATURE_PLAN.md')
  const resolvedPath = path.resolve(inputPath)
  const tool = new ApplyPatchTool(createProviderAdapterStub())
  await writeFile(intendedPath, 'old', 'utf8')

  try {
    const output = await tool.call(
      [
        '*** Begin Patch',
        `*** Update File: ${inputPath}`,
        '@@',
        '-old',
        '+new',
        '*** End Patch',
      ].join('\n')
    )

    assert.match(expectError(output), /missing file/i)
    assert.deepEqual(output.result.resolvedPaths, [resolvedPath])
    assert.equal(await readFile(intendedPath, 'utf8'), 'old')
    assert.equal(await exists(resolvedPath), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ApplyPatchTool reports recognized paths when later patch parsing fails', async () => {
  const firstPath = path.join('relative', 'first.txt')
  const secondPath = path.join('relative', 'second.txt')
  const firstPathAlias = path.join('relative', 'nested', '..', 'first.txt')
  const output = await new ApplyPatchTool(createProviderAdapterStub()).call(
    [
      '*** Begin Patch',
      `*** Update File: ${firstPath}`,
      '@@',
      '-old',
      '+new',
      `*** Update File: ${secondPath}`,
      '@@',
      '-old',
      '+new',
      `*** Update File: ${firstPathAlias}`,
      '@@',
      '-old',
      '+new',
    ].join('\n')
  )

  assert.match(expectError(output), /must end with/i)
  assert.deepEqual(output.result.resolvedPaths, [
    path.resolve(firstPath),
    path.resolve(secondPath),
  ])
})

test('ApplyPatchTool preserves resolved paths in the Tool Result JSON', async () => {
  const inputPath = path.join(
    `portal-missing-${process.pid}-${Date.now()}`,
    'target.txt'
  )
  const registry = new ToolRegistry(createProviderAdapterStub(), [
    ApplyPatchTool,
  ])
  const result = await registry.executeToolCall(
    [
      '*** Begin Patch',
      `*** Update File: ${inputPath}`,
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n'),
    {},
    'apply_patch'
  )
  const message = formatToolResultMessage('apply_patch', result)
  const payload: unknown = JSON.parse(message.slice(message.indexOf('\n') + 1))

  assert.ok(typeof payload === 'object' && payload !== null)
  assert.ok('result' in payload)
  const resultPayload = payload.result
  assert.ok(typeof resultPayload === 'object' && resultPayload !== null)
  assert.ok('resolvedPaths' in resultPayload)
  assert.deepEqual(resultPayload.resolvedPaths, [path.resolve(inputPath)])
})

test('ApplyPatchTool does not resolve empty or NUL paths to cwd', async () => {
  const tool = new ApplyPatchTool(createProviderAdapterStub())
  const emptyPath = await tool.call(
    [
      '*** Begin Patch',
      '*** Update File: ',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n')
  )
  const nulPath = await tool.call(
    [
      '*** Begin Patch',
      '*** Update File: bad\0path',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n')
  )

  expectError(emptyPath)
  expectError(nulPath)
  assert.deepEqual(emptyPath.result.resolvedPaths, [])
  assert.deepEqual(nulPath.result.resolvedPaths, [])
})

test('ApplyPatchTool explains malformed Add File lines to the model', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-apply-patch-'))
  const filePath = path.join(root, 'created.txt')
  const tool = new ApplyPatchTool(createProviderAdapterStub())

  try {
    const hunkHeader = await tool.call(
      [
        '*** Begin Patch',
        `*** Add File: ${filePath}`,
        '@@',
        '+# hello',
        '*** End Patch',
      ].join('\n')
    )
    assert.match(expectError(hunkHeader), /must not contain "@@"/)
    assert.match(expectError(hunkHeader), /content line must start with "\+"/)

    const missingPrefix = await tool.call(
      [
        '*** Begin Patch',
        `*** Add File: ${filePath}`,
        '# hello',
        '*** End Patch',
      ].join('\n')
    )
    assert.match(expectError(missingPrefix), /Invalid Add File line "# hello"/)
    assert.match(
      expectError(missingPrefix),
      /empty content line as a single "\+"/
    )
    assert.equal(await exists(filePath), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ApplyPatchTool explains forward-only Update File context failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-apply-patch-'))
  const filePath = path.join(root, 'ordered.txt')
  const tool = new ApplyPatchTool(createProviderAdapterStub())
  await writeFile(filePath, 'top\nmiddle\nbottom', 'utf8')

  try {
    const result = await tool.call(
      [
        '*** Begin Patch',
        `*** Update File: ${filePath}`,
        '@@',
        ' bottom',
        '+after bottom',
        '@@',
        ' top',
        '+after top',
        '*** End Patch',
      ].join('\n')
    )

    const message = expectError(result)
    assert.match(message, /matcher never moves backward/)
    assert.match(message, /same top-to-bottom order/)
    assert.match(message, /unprefixed blank separator lines/)
    assert.match(message, /Re-read the file and retry/)
    assert.equal(await readFile(filePath, 'utf8'), 'top\nmiddle\nbottom')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ApplyPatchTool rejects move and delete operations without changing files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-apply-patch-'))
  const filePath = path.join(root, 'keep.txt')
  const tool = new ApplyPatchTool(createProviderAdapterStub())
  await writeFile(filePath, 'keep', 'utf8')

  try {
    const deleteResult = await tool.call(
      ['*** Begin Patch', `*** Delete File: ${filePath}`, '*** End Patch'].join(
        '\n'
      )
    )
    assert.match(expectError(deleteResult), /use run_command instead/i)
    assert.equal(await exists(filePath), true)

    const moveResult = await tool.call(
      [
        '*** Begin Patch',
        `*** Update File: ${filePath}`,
        `*** Move to: ${path.join(root, 'moved.txt')}`,
        '*** End Patch',
      ].join('\n')
    )
    assert.match(expectError(moveResult), /use run_command instead/i)
    assert.equal(await readFile(filePath, 'utf8'), 'keep')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ApplyPatchTool rejects a conflicting update before writing any file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-apply-patch-'))
  const firstPath = path.join(root, 'first.txt')
  const missingPath = path.join(root, 'missing.txt')
  const tool = new ApplyPatchTool(createProviderAdapterStub())
  await writeFile(firstPath, 'old', 'utf8')

  try {
    const result = await tool.call(
      [
        '*** Begin Patch',
        `*** Update File: ${firstPath}`,
        '@@',
        '-old',
        '+new',
        `*** Update File: ${missingPath}`,
        '@@',
        '-missing',
        '+created',
        '*** End Patch',
      ].join('\n')
    )
    assert.match(expectError(result), /missing file/i)
    assert.equal(await readFile(firstPath, 'utf8'), 'old')
    assert.equal(await exists(missingPath), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
