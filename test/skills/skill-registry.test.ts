import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { stringify as stringifyYaml } from 'yaml'
import { createDefaultPortalConfig } from '../../src/config/portal-config.ts'

import {
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
  config.skills = skills as unknown[]
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
    assert.deepEqual(parseYamlRecord(contents).skills, [
      {
        name: 'alpha-skill',
        directory: 'skills/alpha-skill',
        enabled: true,
      },
      {
        name: 'zeta-skill',
        directory: 'D:/skills/zeta-skill',
        enabled: false,
      },
    ])

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

test('skill registry rejects whole-file errors and isolates invalid entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-registry-'))
  const registryPath = path.join(root, 'config.yaml')

  try {
    await writeFile(registryPath, '{ invalid json', 'utf8')
    await assert.rejects(readSkillRegistry(registryPath), SkillRegistryError)

    await writeConfig(registryPath, {})
    await assert.rejects(
      readSkillRegistry(registryPath),
      /skills must be an array/
    )

    await writeConfig(registryPath, [
      {
        name: 'valid-skill',
        directory: 'D:/skills/valid-skill',
        enabled: true,
      },
      {
        name: 'broken-skill',
        directory: 'D:/skills/broken-skill',
        enabled: 'yes',
      },
      {
        name: 'annotated-skill',
        directory: 'D:/skills/annotated-skill',
        enabled: true,
        comment: 'unsupported',
      },
      {
        directory: 'D:/skills/missing-name',
        enabled: true,
      },
      {
        name: 'Invalid Name',
        directory: 'D:/skills/invalid-name',
        enabled: true,
      },
    ])
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
        name: 'entry[3]',
        message: 'Entry requires a non-empty name',
      },
      {
        name: 'entry[4]',
        message:
          'Invalid skill name "Invalid Name". Use 1-64 lowercase letters, numbers, and single hyphens.',
      },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('skill registry excludes every entry with a duplicate name', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-registry-'))
  const registryPath = path.join(root, 'config.yaml')

  try {
    await writeConfig(registryPath, [
      {
        name: 'duplicate-skill',
        directory: 'D:/skills/first',
        enabled: true,
      },
      {
        name: 'other-skill',
        directory: 'D:/skills/other',
        enabled: true,
      },
      {
        name: 'duplicate-skill',
        directory: 'D:/skills/second',
        enabled: false,
      },
    ])

    const parsed = await readSkillRegistry(registryPath)
    assert.ok(parsed)
    assert.deepEqual([...parsed.entries.keys()], ['other-skill'])
    assert.deepEqual(parsed.issues, [
      { name: 'duplicate-skill', message: 'Duplicate skill name' },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
