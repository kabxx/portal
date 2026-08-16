import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const sourceRoot = path.resolve('src')

const surfaceBoundaries = {
  tui: 'app/app-tui-thread-input-handler.ts',
  mcp: 'app/app-mcp-handlers.ts',
  exec: 'exec/portal-exec-session.ts',
} as const

test('surface entry points depend on the typed SurfacePort contract', () => {
  for (const relativePath of Object.values(surfaceBoundaries)) {
    const source = readSource(relativePath)
    assert.match(
      source,
      /(?:from|import) ['"][^'"]*surfaces[\\/]surface-port\.ts['"]/
    )
  }
})

test('surface entry points cannot import Portal implementation objects', () => {
  const forbiddenSegments = [
    '/threads/thread-manager',
    '/threads/thread-lifecycle-service',
    '/providers/provider-catalog',
  ]
  const violations: string[] = []

  for (const [surface, relativePath] of Object.entries(surfaceBoundaries)) {
    for (const importedPath of importedSourcePaths(relativePath)) {
      const forbidden = forbiddenSegments.find((segment) =>
        importedPath.includes(segment)
      )
      if (forbidden !== undefined) {
        violations.push(`${surface}: ${relativePath} imports ${importedPath}`)
      }
    }
  }

  assert.deepEqual(violations, [])
})

test('MCP is a Surface and does not drive TUI rendering', () => {
  const source = readSource(surfaceBoundaries.mcp)
  assert.doesNotMatch(source, /terminal-ui[\\/]terminal-controller/)
  assert.doesNotMatch(source, /render(?:User|Assistant|Tool|Thread)/)
  assert.doesNotMatch(
    source,
    /setThreadBusy|removeThreadTimeline|clearLiveCommand/
  )
})

test('the application binds TUI through SurfacePort only', () => {
  const source = readFileSync(path.resolve('src/app.ts'), 'utf8')
  const controllerSource = readFileSync(
    path.resolve('src/terminal-ui/terminal-controller.ts'),
    'utf8'
  )
  assert.doesNotMatch(source, /bindThreadManager\s*\(/)
  assert.doesNotMatch(controllerSource, /bindThreadManager|getThreadManager/)
  assert.match(source, /ui\.bindSurfacePort\(surfacePort\)/)
})

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(sourceRoot, relativePath), 'utf8')
}

function importedSourcePaths(relativePath: string): string[] {
  const file = path.resolve(sourceRoot, relativePath)
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  return sourceFile.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement)) return []
    if (!ts.isStringLiteral(statement.moduleSpecifier)) return []
    return [
      path
        .resolve(path.dirname(file), statement.moduleSpecifier.text)
        .replaceAll('\\', '/'),
    ]
  })
}
