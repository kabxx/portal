import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'

import {
  ApplyPatchTool,
  parsePatch,
} from '../../../src/tools/builtins/apply-patch-tool.ts'
import type { ToolOutput } from '../../../src/tools/core/tool-definition.ts'

function expectSuccess(output: ToolOutput) {
  if (typeof output === 'string') assert.fail(output)
  return output
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
  const prompt = new ApplyPatchTool({} as any).prompt

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
  const tool = new ApplyPatchTool({} as any)
  await writeFile(updatedPath, 'old\n', 'utf8')

  try {
    const output = expectSuccess(
      await tool.call(
        [
          '*** Begin Patch',
          `*** Add File: ${createdPath}`,
          '+first',
          '+',
          '+second',
          `*** Update File: ${updatedPath}`,
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

test('ApplyPatchTool explains malformed Add File lines to the model', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-apply-patch-'))
  const filePath = path.join(root, 'created.txt')
  const tool = new ApplyPatchTool({} as any)

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
    assert.match(String(hunkHeader), /must not contain "@@"/)
    assert.match(String(hunkHeader), /content line must start with "\+"/)

    const missingPrefix = await tool.call(
      [
        '*** Begin Patch',
        `*** Add File: ${filePath}`,
        '# hello',
        '*** End Patch',
      ].join('\n')
    )
    assert.match(String(missingPrefix), /Invalid Add File line "# hello"/)
    assert.match(String(missingPrefix), /empty content line as a single "\+"/)
    assert.equal(await exists(filePath), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ApplyPatchTool explains forward-only Update File context failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-apply-patch-'))
  const filePath = path.join(root, 'ordered.txt')
  const tool = new ApplyPatchTool({} as any)
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

    assert.match(String(result), /matcher never moves backward/)
    assert.match(String(result), /same top-to-bottom order/)
    assert.match(String(result), /unprefixed blank separator lines/)
    assert.match(String(result), /Re-read the file and retry/)
    assert.equal(await readFile(filePath, 'utf8'), 'top\nmiddle\nbottom')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ApplyPatchTool rejects move and delete operations without changing files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-apply-patch-'))
  const filePath = path.join(root, 'keep.txt')
  const tool = new ApplyPatchTool({} as any)
  await writeFile(filePath, 'keep', 'utf8')

  try {
    const deleteResult = await tool.call(
      ['*** Begin Patch', `*** Delete File: ${filePath}`, '*** End Patch'].join(
        '\n'
      )
    )
    assert.match(String(deleteResult), /use run_command instead/i)
    assert.equal(await exists(filePath), true)

    const moveResult = await tool.call(
      [
        '*** Begin Patch',
        `*** Update File: ${filePath}`,
        `*** Move to: ${path.join(root, 'moved.txt')}`,
        '*** End Patch',
      ].join('\n')
    )
    assert.match(String(moveResult), /use run_command instead/i)
    assert.equal(await readFile(filePath, 'utf8'), 'keep')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ApplyPatchTool rejects a conflicting update before writing any file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-apply-patch-'))
  const firstPath = path.join(root, 'first.txt')
  const missingPath = path.join(root, 'missing.txt')
  const tool = new ApplyPatchTool({} as any)
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
    assert.match(String(result), /missing file/i)
    assert.equal(await readFile(firstPath, 'utf8'), 'old')
    assert.equal(await exists(missingPath), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
