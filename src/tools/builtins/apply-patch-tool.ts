import { lstat, mkdir, readFile, unlink, writeFile } from 'fs/promises'
import path from 'path'
import { Tool, defineToolMetadata } from '../core/tool-definition.ts'
import type { ToolOutput } from '../core/tool-definition.ts'
import { applyDiff } from '../patch/openai-apply-diff.ts'
import { buildV4aPreview } from '../patch/v4a-preview.ts'

type PatchOperation = {
  kind: 'add' | 'update'
  path: string
  diff: string
}

interface PlannedFile {
  absolutePath: string
  displayPath: string
  originalExists: boolean
  originalContent: string
  content: string
  createdInPatch: boolean
}

const BEGIN_PATCH = '*** Begin Patch'
const END_PATCH = '*** End Patch'
const ADD_FILE = '*** Add File: '
const UPDATE_FILE = '*** Update File: '
const DELETE_FILE = '*** Delete File: '
const MOVE_TO = '*** Move to: '
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatOperationError(
  operation: PatchOperation,
  error: unknown
): string {
  const message = errorMessage(error)
  const invalidAddLine = message.match(/^Invalid Add File Line: (.*)$/s)
  if (operation.kind !== 'add' || invalidAddLine === null) {
    const invalidContext = message.match(/^Invalid Context (\d+):\n([\s\S]*)$/)
    if (operation.kind !== 'update' || invalidContext === null) {
      return message
    }

    const cursor = Number(invalidContext[1])
    const context = invalidContext[2] ?? ''
    return [
      `Invalid Update File context at or after source line ${cursor + 1}.`,
      'Update hunks are matched forward only; the matcher never moves backward.',
      'List multiple @@ sections in the same top-to-bottom order as their source locations.',
      'Do not put unprefixed blank separator lines between @@ sections.',
      'Every Update File hunk line must start with "+", "-", or a space; use a single prefixed character for a blank line.',
      'Re-read the file and retry with smaller, ordered hunks.',
      `Unmatched context:\n${context}`,
    ].join('\n')
  }

  const line = invalidAddLine[1] ?? ''
  return [
    `Invalid Add File line ${JSON.stringify(line)}.`,
    'Add File must not contain "@@".',
    'Every Add File content line must start with "+"; represent an empty content line as a single "+".',
    'Example:',
    '*** Add File: example.py',
    '+# hello',
  ].join('\n')
}

function marker(
  line: string
):
  | { kind: 'add' | 'update' | 'delete' | 'move'; path: string }
  | { kind: 'begin' | 'end' }
  | null {
  const trimmed = line.trim()
  if (trimmed === BEGIN_PATCH) return { kind: 'begin' }
  if (trimmed === END_PATCH) return { kind: 'end' }
  for (const [prefix, kind] of [
    [ADD_FILE, 'add'],
    [UPDATE_FILE, 'update'],
    [DELETE_FILE, 'delete'],
    [MOVE_TO, 'move'],
  ] as const) {
    if (trimmed.startsWith(prefix)) {
      return { kind, path: trimmed.slice(prefix.length).trim() }
    }
  }
  return null
}

function resolvePatchPaths(input: string): string[] {
  const resolvedPaths = new Set<string>()
  for (const line of input.replace(/\r\n?/g, '\n').split('\n')) {
    const header = marker(line)
    if (
      header === null ||
      !('path' in header) ||
      !header.path ||
      header.path.includes('\0')
    ) {
      continue
    }
    resolvedPaths.add(path.resolve(header.path))
  }
  return [...resolvedPaths]
}

function createApplyPatchError(
  message: string,
  resolvedPaths: readonly string[]
): ToolOutput & { outcome: 'error' } {
  return {
    outcome: 'error',
    result: { message, resolvedPaths },
    displayText: message,
  }
}

function parsePatch(input: string): PatchOperation[] {
  const lines = input.replace(/\r\n?/g, '\n').split('\n')
  while (lines[0]?.trim() === '') lines.shift()
  while (lines.at(-1)?.trim() === '') lines.pop()

  if (lines[0]?.trim() !== BEGIN_PATCH) {
    throw new Error(`Patch must start with ${BEGIN_PATCH}`)
  }
  if (lines.at(-1)?.trim() !== END_PATCH) {
    throw new Error(`Patch must end with ${END_PATCH}`)
  }

  const operations: PatchOperation[] = []
  let index = 1
  while (index < lines.length - 1) {
    const header = marker(lines[index] ?? '')
    if (header === null) {
      throw new Error(`Expected a file operation at patch line ${index + 1}`)
    }
    if (header.kind === 'begin' || header.kind === 'end') {
      throw new Error(`Expected a file operation at patch line ${index + 1}`)
    }
    if (!('path' in header)) {
      throw new Error(`Expected a file operation at patch line ${index + 1}`)
    }
    if (!header.path || header.path.includes('\0')) {
      throw new Error(`Invalid file path at patch line ${index + 1}`)
    }
    if (header.kind === 'delete') {
      throw new Error(
        `Delete File is not supported by apply_patch; use run_command instead (${header.path})`
      )
    }
    if (header.kind === 'move') {
      throw new Error(
        `Move to is not supported by apply_patch; use run_command instead (${header.path})`
      )
    }

    index += 1
    const body: string[] = []
    while (index < lines.length - 1) {
      const next = marker(lines[index] ?? '')
      if (next !== null) {
        if (next.kind === 'delete' && 'path' in next) {
          throw new Error(
            `Delete File is not supported by apply_patch; use run_command instead (${next.path})`
          )
        }
        if (next.kind === 'move' && 'path' in next) {
          throw new Error(
            `Move to is not supported by apply_patch; use run_command instead (${next.path})`
          )
        }
        break
      }
      body.push(lines[index] ?? '')
      index += 1
    }
    if (body.length === 0) {
      throw new Error(`Empty ${header.kind} diff for ${header.path}`)
    }
    operations.push({
      kind: header.kind,
      path: header.path,
      diff: body.join('\n'),
    })
  }

  if (operations.length === 0) {
    throw new Error('Patch does not contain any file operations')
  }
  return operations
}

async function readExistingFile(
  absolutePath: string
): Promise<{ exists: boolean; content: string }> {
  let stats
  try {
    stats = await lstat(absolutePath)
  } catch (error) {
    if (isNotFound(error)) return { exists: false, content: '' }
    throw error
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(
      `Path is not a regular file (directories and symbolic links are not allowed): ${absolutePath}`
    )
  }
  const bytes = await readFile(absolutePath)
  try {
    return { exists: true, content: UTF8_DECODER.decode(bytes) }
  } catch {
    throw new Error(`File is not valid UTF-8 text: ${absolutePath}`)
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

async function planPatch(operations: PatchOperation[]): Promise<PlannedFile[]> {
  const planned = new Map<string, PlannedFile>()

  for (const operation of operations) {
    const absolutePath = path.resolve(operation.path)
    let file = planned.get(absolutePath)
    if (file === undefined) {
      const existing = await readExistingFile(absolutePath)
      file = {
        absolutePath,
        displayPath: operation.path,
        originalExists: existing.exists,
        originalContent: existing.content,
        content: existing.content,
        createdInPatch: false,
      }
      planned.set(absolutePath, file)
    }

    try {
      if (operation.kind === 'add') {
        if (file.originalExists) {
          throw new Error(`Cannot add existing file: ${operation.path}`)
        }
        if (file.createdInPatch) {
          throw new Error(
            `Cannot add the same file more than once: ${operation.path}`
          )
        }
        file.content = applyDiff('', operation.diff, 'create')
        file.createdInPatch = true
      } else {
        if (!file.originalExists && !file.createdInPatch) {
          throw new Error(`Cannot update missing file: ${operation.path}`)
        }
        file.content = applyDiff(file.content, operation.diff)
      }
    } catch (error) {
      throw new Error(
        `${operation.path}: ${formatOperationError(operation, error)}`,
        { cause: error }
      )
    }
  }

  return [...planned.values()]
}

async function commitPatch(files: PlannedFile[]): Promise<void> {
  const committed: PlannedFile[] = []
  try {
    for (const file of files) {
      if (!file.originalExists) {
        await mkdir(path.dirname(file.absolutePath), { recursive: true })
        await writeFile(file.absolutePath, file.content, {
          encoding: 'utf8',
          flag: 'wx',
        })
      } else {
        await writeFile(file.absolutePath, file.content, 'utf8')
      }
      committed.push(file)
    }
  } catch (error) {
    for (const file of committed.reverse()) {
      try {
        if (file.originalExists) {
          await writeFile(file.absolutePath, file.originalContent, 'utf8')
        } else {
          await unlink(file.absolutePath)
        }
      } catch {
        // Preserve the original failure even if a rollback step also fails.
      }
    }
    throw new Error(`Patch commit failed: ${errorMessage(error)}`, {
      cause: error,
    })
  }
}

@defineToolMetadata({
  name: 'apply_patch',
  inputFormat: 'freeform',
  description: [
    'Apply OpenAI V4A patches to local UTF-8 files.',
    'Use this tool for creating and updating files with long or multi-file changes.',
    'The payload is raw Patch text, not JSON and not a Markdown code fence.',
    'Invoke it only as <tool name="apply_patch"> with raw Patch text inside.',
    'Add File rules: do not use @@; prefix every content line with +; represent an empty content line as a single +.',
    'Update File rules: use @@ for change sections; prefix inserted lines with +, removed lines with -, and context lines with a space.',
    'For multiple Update File @@ sections, list them in the same top-to-bottom order as their locations in the source file; matching only moves forward.',
    'Do not put unprefixed blank separator lines between @@ sections. A blank inserted, removed, or context line must still be prefixed with +, -, or a single space.',
    'Use run_command for moving or deleting files.',
    'The patch must contain exactly one Begin/End envelope and may contain multiple file operations.',
  ].join('\n'),
  examples: [
    {
      input: [
        '*** Begin Patch',
        '*** Add File: src/new.ts',
        '+export const value = 1',
        '+',
        '+export default value',
        '*** End Patch',
      ].join('\n'),
    },
    {
      input: [
        '*** Begin Patch',
        '*** Update File: src/multiple.ts',
        '@@',
        ' export function first() {',
        '-  return 1',
        '+  return 2',
        ' }',
        '@@',
        ' export function second() {',
        '+  logCall()',
        '   return true',
        ' }',
        '*** End Patch',
      ].join('\n'),
    },
    {
      input: [
        '*** Begin Patch',
        '*** Update File: src/index.ts',
        '@@',
        '-const enabled = false',
        '+const enabled = true',
        '*** End Patch',
      ].join('\n'),
    },
  ],
})
class ApplyPatchTool extends Tool<string, ToolOutput> {
  public async call(input: string): Promise<ToolOutput> {
    if (typeof input !== 'string' || !input.trim()) {
      return createApplyPatchError(
        'apply_patch input must be non-empty freeform Patch text',
        []
      )
    }

    let resolvedPaths: string[] = []
    try {
      resolvedPaths = resolvePatchPaths(input)
      const operations = parsePatch(input)
      const files = await planPatch(operations)
      await commitPatch(files)
      return {
        result: {
          operations: operations.length,
          files: files.map((file) => file.displayPath),
          resolvedPaths,
        },
        displayText: buildV4aPreview(files),
      }
    } catch (error) {
      return createApplyPatchError(errorMessage(error), resolvedPaths)
    }
  }
}

export { ApplyPatchTool, parsePatch }
