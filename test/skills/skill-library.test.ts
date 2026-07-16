import test from 'node:test'
import assert from 'node:assert/strict'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'fs/promises'
import os from 'os'
import path from 'path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { createDefaultPortalConfig } from '../../src/config/portal-config.ts'
import {
  commitSkillBatch,
  SkillBatchCommitError,
  SkillLibrary,
} from '../../src/skills/skill-library.ts'
import { DEFAULT_SKILL_POLICY } from '../../src/skills/skill-policy.ts'
import { createTestSkill } from '../helpers/skills.ts'

interface SkillRegistryDocumentEntry {
  name: string
  directory: string
  enabled: unknown
}

function defaultConfig() {
  return createDefaultPortalConfig(path.resolve('data'), {
    engine: 'chromium',
    executablePath: path.resolve('test-browser'),
    profilePath: path.resolve('test-profile'),
    remoteDebuggingPort: 9222,
  })
}

async function writeSkillConfig(
  pathname: string,
  entries: readonly SkillRegistryDocumentEntry[]
): Promise<void> {
  const config = defaultConfig()
  config.skills = Object.fromEntries(
    entries.map(({ name, ...entry }) => [name, entry])
  )
  await writeFile(pathname, stringifyYaml(config), 'utf8')
}

test('SkillLibrary installs, catalogs, disables, enables, and removes skills', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-library-'))
  const sourceParent = path.join(root, 'sources')
  const source = await createTestSkill(sourceParent, 'test-skill', {
    body: '# Private workflow\n\nSECRET BODY',
    resource: true,
  })
  const library = new SkillLibrary({
    skillsDirectory: path.join(root, 'data', 'skills'),
    tempDirectory: path.join(root, 'data', 'temp', 'skill-install'),
    registryPath: path.join(root, 'data', 'config.yaml'),
  })

  try {
    const { skills } = await library.add(source)
    const installed = skills[0]
    assert.ok(installed)
    assert.equal(installed.name, 'test-skill')
    assert.equal(installed.directory, path.resolve(source))
    assert.match(
      await readFile(path.join(installed.directory, 'SKILL.md'), 'utf8'),
      /SECRET BODY/
    )
    const registryDocument = parseYaml(
      await readFile(path.join(root, 'data', 'config.yaml'), 'utf8')
    ).skills as Record<string, Omit<SkillRegistryDocumentEntry, 'name'>>
    assert.deepEqual(registryDocument, {
      'test-skill': {
        directory: path.resolve(source),
        enabled: true,
      },
    })
    assert.deepEqual(await readdir(path.join(root, 'data', 'skills')), [])
    await assert.rejects(library.add(source), /Skill already added/)

    const listed = await library.list()
    assert.deepEqual(
      listed.skills.map(({ name, enabled }) => ({ name, enabled })),
      [{ name: 'test-skill', enabled: true }]
    )
    assert.deepEqual(listed.issues, [])

    const enabledCatalog = await library.createCatalogSnapshot()
    assert.equal(enabledCatalog.size, 1)
    assert.deepEqual(enabledCatalog.names, ['test-skill'])
    assert.match(enabledCatalog.prompt ?? '', /test-skill:/)
    assert.doesNotMatch(enabledCatalog.prompt ?? '', /SECRET BODY/)
    const loaded = await enabledCatalog.load('test-skill')
    assert.ok(loaded)
    assert.match(loaded.content, /SECRET BODY/)
    assert.match(loaded.content, /references\/guide\.md/)
    assert.doesNotMatch(loaded.content, /<skill_(?:content|resources)>/)
    assert.ok(
      loaded.content.indexOf('#### Skill Resources') <
        loaded.content.indexOf('#### Skill Instructions')
    )
    assert.ok(
      loaded.content.indexOf('#### Skill Instructions') <
        loaded.content.indexOf('SECRET BODY')
    )

    await writeFile(
      path.join(installed.directory, 'SKILL.md'),
      [
        '---',
        'name: test-skill',
        'description: Updated after catalog creation.',
        '---',
        '',
        '# Updated workflow',
        '',
        'UPDATED BODY',
        '',
      ].join('\n'),
      'utf8'
    )
    const reloaded = await enabledCatalog.load('test-skill')
    assert.ok(reloaded)
    assert.match(reloaded.content, /UPDATED BODY/)
    assert.doesNotMatch(reloaded.content, /SECRET BODY/)

    assert.equal(await library.disable('test-skill'), true)
    assert.ok(await enabledCatalog.load('test-skill'))
    assert.deepEqual(enabledCatalog.names, ['test-skill'])
    const disabledCatalog = await library.createCatalogSnapshot()
    assert.equal(disabledCatalog.size, 0)
    assert.deepEqual(disabledCatalog.names, [])
    assert.equal((await library.list()).skills[0]?.enabled, false)

    assert.equal(await library.enable('test-skill'), true)
    assert.equal((await library.createCatalogSnapshot()).size, 1)
    assert.equal(await library.remove('test-skill'), true)
    assert.equal((await library.list()).skills.length, 0)
    await access(path.join(source, 'SKILL.md'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('SkillLibrary registers a recursive local skill collection in place', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-collection-'))
  const collection = path.join(root, 'collection')
  const alpha = await createTestSkill(collection, 'alpha-skill')
  const beta = await createTestSkill(
    path.join(collection, 'nested'),
    'beta-skill'
  )
  await createTestSkill(path.join(alpha, 'references'), 'embedded-skill')
  const library = new SkillLibrary({
    skillsDirectory: path.join(root, 'data', 'skills'),
    tempDirectory: path.join(root, 'data', 'temp', 'skill-install'),
    registryPath: path.join(root, 'data', 'config.yaml'),
  })

  try {
    const result = await library.add(collection)
    assert.deepEqual(
      result.skills.map(({ name }) => name),
      ['alpha-skill', 'beta-skill']
    )
    assert.deepEqual(
      result.skills.map(({ directory }) => directory),
      [path.resolve(alpha), path.resolve(beta)]
    )
    assert.deepEqual(result.warnings, [])
    assert.deepEqual(
      (await library.list()).skills.map(({ name }) => name),
      ['alpha-skill', 'beta-skill']
    )
    assert.equal(await library.remove('alpha-skill'), true)
    await access(path.join(alpha, 'SKILL.md'))
    assert.deepEqual(await readdir(path.join(root, 'data', 'skills')), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('SkillLibrary treats a source root with SKILL.md as one skill', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-root-'))
  const source = await createTestSkill(path.join(root, 'source'), 'root-skill')
  await createTestSkill(path.join(source, 'references'), 'nested-skill')
  const library = new SkillLibrary({
    skillsDirectory: path.join(root, 'data', 'skills'),
    tempDirectory: path.join(root, 'data', 'temp', 'skill-install'),
    registryPath: path.join(root, 'data', 'config.yaml'),
  })

  try {
    const result = await library.add(source)
    assert.deepEqual(
      result.skills.map(({ name }) => name),
      ['root-skill']
    )
    assert.deepEqual(
      (await library.list()).skills.map(({ name }) => name),
      ['root-skill']
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('SkillLibrary rejects an invalid local collection without registering part of it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-atomic-'))
  const collection = path.join(root, 'collection')
  await createTestSkill(collection, 'valid-skill')
  const invalid = path.join(collection, 'invalid-skill')
  await mkdir(invalid, { recursive: true })
  await writeFile(path.join(invalid, 'SKILL.md'), 'not frontmatter', 'utf8')
  const library = new SkillLibrary({
    skillsDirectory: path.join(root, 'data', 'skills'),
    tempDirectory: path.join(root, 'data', 'temp', 'skill-install'),
    registryPath: path.join(root, 'data', 'config.yaml'),
  })

  try {
    await assert.rejects(library.add(collection), /frontmatter/i)
    assert.deepEqual((await library.list()).skills, [])
    assert.deepEqual(await readdir(path.join(root, 'data', 'skills')), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('SkillLibrary rejects duplicate names across a skill collection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-duplicate-'))
  const collection = path.join(root, 'collection')
  await createTestSkill(path.join(collection, 'group-a'), 'shared-skill')
  await createTestSkill(path.join(collection, 'group-b'), 'shared-skill')
  const library = new SkillLibrary({
    skillsDirectory: path.join(root, 'data', 'skills'),
    tempDirectory: path.join(root, 'data', 'temp', 'skill-install'),
    registryPath: path.join(root, 'data', 'config.yaml'),
  })

  try {
    await assert.rejects(library.add(collection), /duplicate skill name/)
    assert.deepEqual((await library.list()).skills, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('commitSkillBatch keeps a committed batch when post-commit cleanup fails', async () => {
  const entries = new Map<string, { directory: string; enabled: boolean }>()
  const batch = [
    {
      name: 'committed-skill',
      description: 'Committed skill.',
      directory: 'C:\\skills\\committed-skill',
      registryDirectory: 'skills/committed-skill',
      managed: true,
    },
  ]

  const result = await commitSkillBatch('config.yaml', batch, {
    update: async (_registryPath, update) => {
      update({ entries, issues: [] })
      throw new Error('lock cleanup failed')
    },
    read: async () => ({ entries, issues: [] }),
  })

  assert.match(result.warnings[0] ?? '', /lock cleanup failed/)
  assert.deepEqual(entries.get('committed-skill'), {
    directory: 'skills/committed-skill',
    enabled: true,
  })
})

test('commitSkillBatch preserves a pre-commit conflict with an identical local entry', async () => {
  const directory = path.resolve('existing-skill')
  const entries = new Map([['existing-skill', { directory, enabled: true }]])
  let readCalled = false

  await assert.rejects(
    commitSkillBatch(
      'config.yaml',
      [
        {
          name: 'existing-skill',
          description: 'Existing skill.',
          directory,
          registryDirectory: directory,
          managed: false,
        },
      ],
      {
        update: async (_registryPath, update) => {
          update({ entries, issues: [] })
        },
        read: async () => {
          readCalled = true
          return { entries, issues: [] }
        },
      }
    ),
    (error: unknown) =>
      error instanceof SkillBatchCommitError &&
      error.rollbackManaged &&
      /already added/.test(error.message)
  )
  assert.equal(readCalled, false)
})

test('commitSkillBatch never rolls back directories still referenced by mismatched entries', async () => {
  const entries = new Map([
    ['managed-skill', { directory: 'skills/managed-skill', enabled: false }],
  ])

  await assert.rejects(
    commitSkillBatch(
      'config.yaml',
      [
        {
          name: 'managed-skill',
          description: 'Managed skill.',
          directory: 'C:\\skills\\managed-skill',
          registryDirectory: 'skills/managed-skill',
          managed: true,
        },
      ],
      {
        update: async (_registryPath, update) => {
          update({ entries: new Map(), issues: [] })
          throw new Error('post-commit failure')
        },
        read: async () => ({ entries, issues: [] }),
      }
    ),
    (error: unknown) =>
      error instanceof SkillBatchCommitError &&
      !error.rollbackManaged &&
      /partial batch commit/.test(error.message)
  )
})

test('SkillLibrary applies the configured resource file limit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-policy-'))
  const source = await createTestSkill(path.join(root, 'sources'), 'limited', {
    resource: true,
  })
  const library = new SkillLibrary({
    skillsDirectory: path.join(root, 'data', 'skills'),
    tempDirectory: path.join(root, 'data', 'temp', 'skill-install'),
    registryPath: path.join(root, 'data', 'config.yaml'),
    policy: { ...DEFAULT_SKILL_POLICY, maxResourceFiles: 0 },
  })

  try {
    await assert.rejects(library.add(source), /more than 0 resource files/)
    const result = await library.list()
    assert.deepEqual(result.skills, [])
    assert.deepEqual(result.issues, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('SkillLibrary preserves concurrent mutations in the Skill section', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-concurrent-'))
  const sourceParent = path.join(root, 'sources')
  const alpha = await createTestSkill(sourceParent, 'alpha-skill')
  const beta = await createTestSkill(sourceParent, 'beta-skill')
  const library = new SkillLibrary({
    skillsDirectory: path.join(root, 'data', 'skills'),
    tempDirectory: path.join(root, 'data', 'temp', 'skill-install'),
    registryPath: path.join(root, 'data', 'config.yaml'),
  })

  try {
    await Promise.all([library.add(alpha), library.add(beta)])

    assert.deepEqual(
      (await library.list()).skills.map(({ name }) => name),
      ['alpha-skill', 'beta-skill']
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('SkillLibrary initializes a missing registry without overwriting it later', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-initialize-'))
  const dataDirectory = path.join(root, 'data')
  const registryPath = path.join(dataDirectory, 'config.yaml')
  const library = new SkillLibrary({
    skillsDirectory: path.join(dataDirectory, 'skills'),
    tempDirectory: path.join(dataDirectory, 'temp', 'skill-install'),
    registryPath,
  })

  try {
    await library.initialize()
    assert.deepEqual(parseYaml(await readFile(registryPath, 'utf8')).skills, {})

    await writeFile(registryPath, 'browser: [', 'utf8')
    await library.initialize()
    assert.equal(await readFile(registryPath, 'utf8'), 'browser: [')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('SkillLibrary bootstraps existing managed skills as enabled', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-bootstrap-'))
  const dataDirectory = path.join(root, 'data')
  const skillsDirectory = path.join(dataDirectory, 'skills')
  const managedDirectory = await createTestSkill(
    skillsDirectory,
    'managed-skill'
  )
  const library = new SkillLibrary({
    skillsDirectory,
    tempDirectory: path.join(dataDirectory, 'temp', 'skill-install'),
    registryPath: path.join(dataDirectory, 'config.yaml'),
  })

  try {
    await library.initialize()
    assert.deepEqual(
      (await library.list()).skills.map(({ name, enabled }) => ({
        name,
        enabled,
      })),
      [{ name: 'managed-skill', enabled: true }]
    )
    const registry = parseYaml(
      await readFile(path.join(dataDirectory, 'config.yaml'), 'utf8')
    ).skills as Record<string, Omit<SkillRegistryDocumentEntry, 'name'>>
    assert.deepEqual(registry, {
      'managed-skill': {
        directory: 'skills/managed-skill',
        enabled: true,
      },
    })
    assert.equal(await library.remove('managed-skill'), true)
    await assert.rejects(access(managedDirectory))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('SkillLibrary reloads manual registry edits and isolates invalid entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-manual-'))
  const dataDirectory = path.join(root, 'data')
  const externalDirectory = await createTestSkill(
    path.join(root, 'external'),
    'manual-skill'
  )
  const registryPath = path.join(dataDirectory, 'config.yaml')
  await mkdir(dataDirectory, { recursive: true })
  await writeSkillConfig(registryPath, [
    {
      name: 'manual-skill',
      directory: externalDirectory,
      enabled: true,
    },
    {
      name: 'missing-skill',
      directory: path.join(root, 'missing-skill'),
      enabled: true,
    },
  ])
  await createTestSkill(
    path.join(dataDirectory, 'skills'),
    'unregistered-skill'
  )
  const library = new SkillLibrary({
    skillsDirectory: path.join(dataDirectory, 'skills'),
    tempDirectory: path.join(dataDirectory, 'temp', 'skill-install'),
    registryPath,
  })

  try {
    const listed = await library.list()
    assert.deepEqual(
      listed.skills.map(({ name }) => name),
      ['manual-skill']
    )
    assert.equal(listed.issues.length, 1)
    assert.match(listed.issues[0]?.message ?? '', /Missing SKILL\.md/)

    const config = parseYaml(await readFile(registryPath, 'utf8'))
    const document = config.skills as Record<
      string,
      Omit<SkillRegistryDocumentEntry, 'name'>
    >
    const manualSkill = document['manual-skill']
    assert.ok(manualSkill)
    manualSkill.enabled = false
    await writeSkillConfig(
      registryPath,
      Object.entries(document).map(([name, entry]) => ({ name, ...entry }))
    )
    assert.equal((await library.list()).skills[0]?.enabled, false)
    assert.equal((await library.createCatalogSnapshot()).size, 0)

    assert.equal(await library.remove('missing-skill'), true)
    assert.equal((await library.list()).issues.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('SkillLibrary never overwrites malformed registries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-invalid-'))
  const dataDirectory = path.join(root, 'data')
  const registryPath = path.join(dataDirectory, 'config.yaml')
  const source = await createTestSkill(path.join(root, 'external'), 'new-skill')
  await mkdir(dataDirectory, { recursive: true })
  await writeFile(registryPath, 'browser: [', 'utf8')
  const library = new SkillLibrary({
    skillsDirectory: path.join(dataDirectory, 'skills'),
    tempDirectory: path.join(dataDirectory, 'temp', 'skill-install'),
    registryPath,
  })

  try {
    const listed = await library.list()
    assert.equal(listed.skills.length, 0)
    assert.equal(listed.issues[0]?.directory, registryPath)
    assert.match(listed.issues[0]?.message ?? '', /Invalid YAML/)
    await assert.rejects(library.add(source), /Invalid YAML/)
    await assert.rejects(library.createCatalogSnapshot(), /Invalid YAML/)
    assert.equal(await readFile(registryPath, 'utf8'), 'browser: [')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('SkillLibrary isolates invalid registry entries and refuses lossy writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-invalid-'))
  const dataDirectory = path.join(root, 'data')
  const registryPath = path.join(dataDirectory, 'config.yaml')
  const validDirectory = await createTestSkill(
    path.join(root, 'external'),
    'valid-skill'
  )
  await mkdir(dataDirectory, { recursive: true })
  const originalEntries: SkillRegistryDocumentEntry[] = [
    {
      name: 'valid-skill',
      directory: validDirectory,
      enabled: true,
    },
    {
      name: 'broken-skill',
      directory: path.join(root, 'broken-skill'),
      enabled: 'yes',
    },
  ]
  await writeSkillConfig(registryPath, originalEntries)
  const original = await readFile(registryPath, 'utf8')
  const library = new SkillLibrary({
    skillsDirectory: path.join(dataDirectory, 'skills'),
    tempDirectory: path.join(dataDirectory, 'temp', 'skill-install'),
    registryPath,
  })

  try {
    const listed = await library.list()
    assert.deepEqual(
      listed.skills.map(({ name }) => name),
      ['valid-skill']
    )
    assert.equal(listed.issues.length, 1)
    assert.match(listed.issues[0]?.message ?? '', /broken-skill/)
    assert.equal((await library.createCatalogSnapshot()).size, 1)

    await assert.rejects(
      library.disable('valid-skill'),
      /Skill registry contains invalid entries/
    )
    assert.equal(await readFile(registryPath, 'utf8'), original)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
