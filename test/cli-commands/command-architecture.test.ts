import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const commandRoot = path.resolve('src/cli-commands')
const forbiddenSegments = [
  '/host/',
  '/keybindings/',
  '/mcp-server/',
  '/processes/',
  '/providers/',
  '/runtime/',
  '/skills/',
  '/terminal-ui/',
  '/threads/',
]

test('Command modules depend only on contracts and narrow extension services', () => {
  const violations: string[] = []
  for (const file of typescriptFiles(commandRoot)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    )
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
      const resolved = path
        .resolve(path.dirname(file), statement.moduleSpecifier.text)
        .replaceAll('\\', '/')
      const forbidden = forbiddenSegments.find((segment) =>
        resolved.includes(segment)
      )
      if (forbidden !== undefined) {
        violations.push(
          `${path.relative(commandRoot, file)} imports ${statement.moduleSpecifier.text}`
        )
      }
    }
  }
  assert.deepEqual(violations, [])
})

test('legacy Command registries, contexts, and static command sets stay removed', () => {
  for (const relativePath of [
    'command-set.ts',
    'core/command-registry.ts',
    'core/command-types.ts',
  ]) {
    assert.equal(
      existsSync(path.join(commandRoot, relativePath)),
      false,
      relativePath
    )
  }
  const legacyDirectory = path.join(commandRoot, 'commands')
  assert.deepEqual(
    existsSync(legacyDirectory) ? typescriptFiles(legacyDirectory) : [],
    []
  )
})

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return typescriptFiles(target)
    return entry.isFile() && entry.name.endsWith('.ts') ? [target] : []
  })
}
