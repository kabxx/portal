import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { stringify as stringifyYaml } from 'yaml'
import { createDefaultPortalConfig } from '../../src/config/portal-config.ts'

import {
  ensureSkillRegistry,
  readSkillRegistry,
  SkillRegistryError,
  writeSkillRegistry,
} from '../../src/skills/skill-registry.ts'
import { parseYamlRecord } from '../helpers/yaml.ts'

function defaultConfig() {
  return createDefaultPortalConfig(path.resolve('data'), {
    engine: 'chromium',
    executablePath: path.resolve('test-browser'),
    profilePath: path.resolve('test-profile'),
    remoteDebuggingPort: 9222,
  })
}

async function writeConfig(pathname: string, skills: unknown): Promise<void> {
  const config = defaultConfig()
  config.skills = skills as Record<string, unknown>
  await writeFile(pathname, stringifyYaml(config), 'utf8')
}

test('skill registry persists deterministic user-editable YAML', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-registry-'))
  const registryPath = path.join(root, 'data', 'config.yaml')

  try {
    await writeSkillRegistry(
      registryPath,
      new Map([
        ['zeta-skill', { directory: 'D:/skills/zeta-skill', enabled: false }],
        ['alpha-skill', { directory: 'skills/alpha-skill', enabled: true }],
      ])
    )

    const contents = await readFile(registryPath, 'utf8')
    assert.ok(contents.indexOf('alpha-skill') < contents.indexOf('zeta-skill'))
    assert.deepEqual(parseYamlRecord(contents).skills, {
      'alpha-skill': {
        directory: 'skills/alpha-skill',
        enabled: true,
      },
      'zeta-skill': {
        directory: 'D:/skills/zeta-skill',
        enabled: false,
      },
    })

    const reopened = await readSkillRegistry(registryPath)
    assert.ok(reopened)
    assert.deepEqual(
      [...reopened.entries],
      [
        ['alpha-skill', { directory: 'skills/alpha-skill', enabled: true }],
        ['zeta-skill', { directory: 'D:/skills/zeta-skill', enabled: false }],
      ]
    )
    assert.deepEqual(reopened.issues, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('skill registry bootstrap preserves a config created after its scan', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-bootstrap-'))
  const registryPath = path.join(root, 'config.yaml')
  const concurrentSkills = {
    'concurrent-skill': {
      directory: 'skills/concurrent-skill',
      enabled: true,
    },
  }

  try {
    await writeConfig(registryPath, concurrentSkills)
    const result = await ensureSkillRegistry(
      registryPath,
      new Map([
        ['stale-scan', { directory: 'skills/stale-scan', enabled: true }],
      ])
    )

    assert.deepEqual(
      [...result.entries],
      [
        [
          'concurrent-skill',
          { directory: 'skills/concurrent-skill', enabled: true },
        ],
      ]
    )
    assert.deepEqual(
      parseYamlRecord(await readFile(registryPath, 'utf8')).skills,
      concurrentSkills
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('skill registry rejects whole-file errors and isolates invalid entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-registry-'))
  const registryPath = path.join(root, 'config.yaml')

  try {
    await writeFile(registryPath, '{ invalid json', 'utf8')
    await assert.rejects(readSkillRegistry(registryPath), SkillRegistryError)

    await writeConfig(registryPath, [])
    await assert.rejects(
      readSkillRegistry(registryPath),
      /skills must be an object keyed by name/
    )

    await writeConfig(registryPath, {
      'valid-skill': {
        directory: 'D:/skills/valid-skill',
        enabled: true,
      },
      'broken-skill': {
        directory: 'D:/skills/broken-skill',
        enabled: 'yes',
      },
      'annotated-skill': {
        directory: 'D:/skills/annotated-skill',
        enabled: true,
        comment: 'unsupported',
      },
      'Invalid Name': {
        directory: 'D:/skills/invalid-name',
        enabled: true,
      },
    })
    const parsed = await readSkillRegistry(registryPath)
    assert.ok(parsed)
    assert.deepEqual([...parsed.entries.keys()], ['valid-skill'])
    assert.deepEqual(parsed.issues, [
      {
        name: 'broken-skill',
        message: 'Entry requires a boolean enabled value',
      },
      {
        name: 'annotated-skill',
        message: 'Unsupported entry fields: comment',
      },
      {
        name: 'Invalid Name',
        message:
          'Invalid skill name "Invalid Name". Use 1-64 lowercase letters, numbers, and single hyphens.',
      },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('skill registry rejects duplicate YAML keys as a whole-file error', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-registry-'))
  const registryPath = path.join(root, 'config.yaml')

  try {
    const contents = stringifyYaml(defaultConfig()).replace(
      'skills: {}',
      [
        'skills:',
        '  duplicate-skill:',
        '    directory: D:/skills/first',
        '    enabled: true',
        '  duplicate-skill:',
        '    directory: D:/skills/second',
        '    enabled: false',
      ].join('\n')
    )
    await writeFile(registryPath, contents, 'utf8')

    await assert.rejects(readSkillRegistry(registryPath), /Invalid YAML/)
    assert.equal(await readFile(registryPath, 'utf8'), contents)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
