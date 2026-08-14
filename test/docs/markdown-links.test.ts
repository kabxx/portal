import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
const markdownLinkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g
const externalTargetPattern = /^[a-z][a-z\d+.-]*:/i

function listMarkdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      return listMarkdownFiles(target)
    }
    return entry.isFile() && entry.name.endsWith('.md') ? [target] : []
  })
}

function extractTarget(rawTarget: string): string {
  const trimmed = rawTarget.trim()
  if (trimmed.startsWith('<')) {
    const closingBracket = trimmed.indexOf('>')
    return closingBracket === -1 ? trimmed : trimmed.slice(1, closingBracket)
  }
  return trimmed.split(/\s+/, 1)[0] ?? ''
}

test('local Markdown links resolve to existing files', () => {
  const rootDocuments = [
    'README.md',
    'README.zh-CN.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
  ].map((name) => path.join(repositoryRoot, name))
  for (const rootDocument of rootDocuments) {
    assert.equal(
      existsSync(rootDocument),
      true,
      `missing root document: ${path.basename(rootDocument)}`
    )
  }
  const markdownFiles = [
    ...rootDocuments,
    ...listMarkdownFiles(path.join(repositoryRoot, 'docs')),
  ]
  const failures: string[] = []

  for (const markdownFile of markdownFiles) {
    const content = readFileSync(markdownFile, 'utf8')
    for (const match of content.matchAll(markdownLinkPattern)) {
      const target = extractTarget(match[1] ?? '')
      if (
        target === '' ||
        target.startsWith('#') ||
        target.startsWith('//') ||
        externalTargetPattern.test(target)
      ) {
        continue
      }

      const fileTarget = target.split('#', 1)[0]?.split('?', 1)[0] ?? ''
      if (fileTarget === '') {
        continue
      }

      let decodedTarget: string
      try {
        decodedTarget = decodeURIComponent(fileTarget)
      } catch {
        failures.push(
          `${path.relative(repositoryRoot, markdownFile)} -> ${target} (invalid encoding)`
        )
        continue
      }

      const resolved = path.resolve(path.dirname(markdownFile), decodedTarget)
      if (!existsSync(resolved)) {
        failures.push(
          `${path.relative(repositoryRoot, markdownFile)} -> ${target}`
        )
      }
    }
  }

  assert.deepEqual(failures, [])
})
