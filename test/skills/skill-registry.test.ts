import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  ensureSkillRegistry,
  readSkillRegistry,
  SkillRegistryError,
  updateSkillRegistry,
  writeSkillRegistry,
} from '../../src/skills/skill-registry.ts'

test('Skill registry persists deterministic versioned JSON', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-registry-'))
  const registryPath = path.join(root, 'state', 'skills.json')
  try {
    await writeSkillRegistry(
      registryPath,
      new Map([
        ['zeta-skill', { directory: '../skills/zeta', enabled: false }],
        ['alpha-skill', { directory: '../skills/alpha', enabled: true }],
      ])
    )
    const raw = parseJsonRecord(await readFile(registryPath, 'utf8'))
    assert.equal(raw.version, 1)
    assert.deepEqual(Object.keys(raw.skills), ['alpha-skill', 'zeta-skill'])
    assert.deepEqual(
      [...(await readSkillRegistry(registryPath))!.entries.keys()],
      ['alpha-skill', 'zeta-skill']
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Skill registry creates only on ensure and updates atomically', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-registry-'))
  const registryPath = path.join(root, 'state', 'skills.json')
  try {
    assert.equal(await readSkillRegistry(registryPath), null)
    await ensureSkillRegistry(registryPath, new Map())
    await updateSkillRegistry(registryPath, (registry) => {
      registry.entries.set('example', {
        directory: '../skills/example',
        enabled: true,
      })
    })
    assert.equal(
      (await readSkillRegistry(registryPath))?.entries.get('example')?.enabled,
      true
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Skill registry rejects invalid document versions and isolates bad entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-registry-'))
  const registryPath = path.join(root, 'skills.json')
  try {
    await writeFile(registryPath, '{"version":2,"skills":{}}', 'utf8')
    await assert.rejects(
      readSkillRegistry(registryPath),
      /Unsupported Skill registry version/
    )
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        skills: {
          valid: { directory: 'valid', enabled: true },
          broken: { directory: 'broken', enabled: 'yes' },
        },
      }),
      'utf8'
    )
    const parsed = await readSkillRegistry(registryPath)
    assert.deepEqual([...parsed!.entries.keys()], ['valid'])
    assert.deepEqual(
      parsed!.issues.map(({ name }) => name),
      ['broken']
    )
    await writeFile(registryPath, '{', 'utf8')
    await assert.rejects(readSkillRegistry(registryPath), SkillRegistryError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Skill registry rejects directory and symbolic-link paths', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-file-'))
  const directoryPath = path.join(root, 'directory.json')
  const targetPath = path.join(root, 'target.json')
  const linkPath = path.join(root, 'link.json')
  try {
    await mkdir(directoryPath)
    await assert.rejects(
      readSkillRegistry(directoryPath),
      /Skill registry path must be a regular file/
    )

    const contents = '{"version":1,"skills":{}}\n'
    await writeFile(targetPath, contents, 'utf8')
    try {
      await symlink(targetPath, linkPath, 'file')
    } catch (error) {
      if (isPermissionError(error)) {
        t.diagnostic('File symlinks are unavailable in this environment')
        return
      }
      throw error
    }
    await assert.rejects(
      writeSkillRegistry(linkPath, new Map()),
      /Skill registry path must be a regular file/
    )
    assert.equal(await readFile(targetPath, 'utf8'), contents)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Skill registry rejects symbolic-link lock directories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-lock-dir-'))
  const registryPath = path.join(root, 'state', 'skills.json')
  const lockDirectory = path.join(root, 'state', '.locks')
  const externalDirectory = path.join(root, 'external-locks')
  try {
    await mkdir(path.dirname(lockDirectory), { recursive: true })
    await mkdir(externalDirectory)
    await symlink(
      externalDirectory,
      lockDirectory,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await assert.rejects(
      writeSkillRegistry(registryPath, new Map()),
      /Skill lock directory path must be a regular directory/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Skill registry rejects symbolic-link lock files without changing their targets', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-lock-file-'))
  const registryPath = path.join(root, 'state', 'skills.json')
  const lockDirectory = path.join(root, 'state', '.locks')
  const lockPath = path.join(lockDirectory, 'skills.lock')
  const targetPath = path.join(root, 'external.lock')
  try {
    await mkdir(lockDirectory, { recursive: true })
    await writeFile(targetPath, 'external lock target', 'utf8')
    const before = await stat(targetPath)
    try {
      await symlink(targetPath, lockPath, 'file')
    } catch (error) {
      if (isPermissionError(error)) {
        t.diagnostic('File symlinks are unavailable in this environment')
        return
      }
      throw error
    }
    await assert.rejects(
      writeSkillRegistry(registryPath, new Map()),
      /Skill lock path must be a regular file/
    )
    assert.equal(await readFile(targetPath, 'utf8'), 'external lock target')
    assert.equal((await stat(targetPath)).mode, before.mode)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function parseJsonRecord(contents: string): {
  version: number
  skills: Record<string, unknown>
} {
  const value: unknown = JSON.parse(contents)
  if (
    !isRecord(value) ||
    typeof value.version !== 'number' ||
    !isRecord(value.skills)
  ) {
    throw new Error('Expected a versioned Skill registry object.')
  }
  return { version: value.version, skills: value.skills }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPermissionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'EPERM' || error.code === 'EACCES')
  )
}
