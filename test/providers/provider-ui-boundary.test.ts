import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import test from 'node:test'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..')

test('adapters and runtime do not own provider DOM selectors', () => {
  const files = [
    ...listTypeScriptFiles(
      resolve(REPOSITORY_ROOT, 'src', 'providers', 'adapters')
    ),
    ...listTypeScriptFiles(resolve(REPOSITORY_ROOT, 'src', 'runtime')),
  ]

  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const label = relative(REPOSITORY_ROOT, file)
    assert.doesNotMatch(
      source,
      /\.locator\s*\(/,
      `${label} must delegate provider DOM access to a Provider UI component.`
    )
    assert.doesNotMatch(
      source,
      /document\.querySelector(?:All)?\s*\(/,
      `${label} must not query provider DOM directly.`
    )
    assert.doesNotMatch(
      source,
      /\b(?:defineProviderUiSelectors|joinCssLocatorCandidates|mapCssLocatorCandidates|resolveUniqueVisibleLocator)\b/,
      `${label} must not import Provider UI selector helpers.`
    )
  }
})

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return listTypeScriptFiles(path)
    }
    return extname(entry.name) === '.ts' ? [path] : []
  })
}
