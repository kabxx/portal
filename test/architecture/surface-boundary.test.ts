import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const sourceRoot = path.resolve('src')

const surfaceBoundaries = {
  tui: 'app/tui-surface-plugin.ts',
  mcp: 'mcp-server/mcp-surface-plugin.ts',
  exec: 'exec/exec-surface-plugin.ts',
} as const

const surfacePlugins = {
  tui: 'app/tui-surface-plugin.ts',
  mcp: 'mcp-server/mcp-surface-plugin.ts',
  exec: 'exec/exec-surface-plugin.ts',
} as const

test('surface entry points depend on the typed SurfacePort contract', () => {
  for (const relativePath of Object.values(surfaceBoundaries)) {
    const source = readSource(relativePath)
    assert.match(
      source,
      /(?:from|import) ['"][^'"]*surfaces[\\/]surface-(?:port|extension)\.ts['"]/
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

test('resolved Surface plugins cannot import Host or implementation managers', () => {
  const forbiddenSegments = [
    '/host/portal-host',
    '/host/portal-surface-port',
    '/threads/thread-manager',
    '/threads/thread-lifecycle-service',
    '/providers/provider-catalog',
    '/providers/adapters/',
    '/runtime/runtime-core',
    '/platform/browser-cdp-launcher',
    '/processes/run-command-job-manager',
  ]
  const violations: string[] = []
  for (const [surface, relativePath] of Object.entries(surfacePlugins)) {
    for (const importedPath of importedSourcePaths(relativePath)) {
      const forbidden = forbiddenSegments.find((segment) =>
        importedPath.includes(segment)
      )
      if (forbidden !== undefined)
        violations.push(`${surface}: ${relativePath} imports ${importedPath}`)
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

test('the TUI plugin binds through SurfacePort and the entry only activates it', () => {
  const source = readFileSync(path.resolve('src/app.ts'), 'utf8')
  const tuiSource = readSource(surfacePlugins.tui)
  const controllerSource = readFileSync(
    path.resolve('src/terminal-ui/terminal-controller.ts'),
    'utf8'
  )
  assert.doesNotMatch(source, /bindThreadManager\s*\(/)
  assert.doesNotMatch(controllerSource, /bindThreadManager|getThreadManager/)
  assert.match(source, /activateSurface\(TUI_SURFACE_ID/)
  assert.match(tuiSource, /ui\.bindSurfacePort\(surface\)/)
  assert.doesNotMatch(source, /new PortalSurfacePort|new ThreadManager/)
  assert.doesNotMatch(source, /profile:\s*['"](?:tui|exec)['"]/)
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
