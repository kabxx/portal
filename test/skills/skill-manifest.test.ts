import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseSkillManifest,
  SkillManifestError,
} from '../../src/skills/skill-manifest.ts'

test('parseSkillManifest reads standard Agent Skills metadata and body', () => {
  const manifest = parseSkillManifest(
    [
      '---',
      'name: pdf-processing',
      'description: Process PDF documents for users.',
      'metadata:',
      '  author: portal-test',
      '---',
      '',
      '# PDF Processing',
      '',
      'Follow the workflow.',
    ].join('\n')
  )

  assert.deepEqual(manifest, {
    name: 'pdf-processing',
    description: 'Process PDF documents for users.',
    body: '# PDF Processing\n\nFollow the workflow.',
  })
})

test('parseSkillManifest rejects invalid names and missing descriptions', () => {
  assert.throws(
    () =>
      parseSkillManifest(
        ['---', 'name: PDF Skill', 'description: invalid', '---', 'body'].join(
          '\n'
        )
      ),
    SkillManifestError
  )
  assert.throws(
    () =>
      parseSkillManifest(
        ['---', 'name: valid-skill', '---', 'body'].join('\n')
      ),
    /requires non-empty string description/
  )
})
