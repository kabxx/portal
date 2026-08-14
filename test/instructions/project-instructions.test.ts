import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  loadProjectInstructions,
  PROJECT_INSTRUCTION_MAX_BYTES,
} from '../../src/instructions/project-instructions.ts'

async function withTempDirectory(
  run: (directory: string) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'portal-instructions-')
  )
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('disabled project instructions do not inspect AGENTS.md', async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, 'AGENTS.md'))
    const instructions = await loadProjectInstructions({
      cwd: directory,
      enabled: false,
    })

    assert.equal(instructions.prompt, null)
  })
})

test('enabled project instructions load only cwd AGENTS.md verbatim', async () => {
  await withTempDirectory(async (parent) => {
    const cwd = path.join(parent, 'workspace')
    const nested = path.join(cwd, 'nested')
    await mkdir(nested, { recursive: true })
    await Promise.all([
      writeFile(path.join(parent, 'AGENTS.md'), 'Parent rule.', 'utf8'),
      writeFile(path.join(cwd, 'AGENTS.override.md'), 'Override rule.', 'utf8'),
      writeFile(path.join(cwd, 'CLAUDE.md'), 'Claude rule.', 'utf8'),
      writeFile(path.join(nested, 'AGENTS.md'), 'Nested rule.', 'utf8'),
      writeFile(
        path.join(cwd, 'AGENTS.md'),
        '\uFEFF# Exact cwd\n\nKeep spacing.\n',
        'utf8'
      ),
    ])

    const instructions = await loadProjectInstructions({
      cwd,
      enabled: true,
    })

    assert.equal(instructions.prompt, '# Exact cwd\n\nKeep spacing.\n')
  })
})

test('missing and empty cwd AGENTS.md are omitted', async () => {
  await withTempDirectory(async (directory) => {
    assert.equal(
      (await loadProjectInstructions({ cwd: directory, enabled: true })).prompt,
      null
    )
    await writeFile(path.join(directory, 'AGENTS.md'), ' \n\t', 'utf8')
    assert.equal(
      (await loadProjectInstructions({ cwd: directory, enabled: true })).prompt,
      null
    )
  })
})

test('project instructions reject non-files, symlinks, oversized files, and invalid UTF-8', async () => {
  await withTempDirectory(async (directory) => {
    const agentsPath = path.join(directory, 'AGENTS.md')
    await mkdir(agentsPath)
    await assert.rejects(
      loadProjectInstructions({ cwd: directory, enabled: true }),
      /regular, non-symbolic-link file/
    )
    await rm(agentsPath, { recursive: true })

    const target = path.join(directory, 'rules.md')
    await writeFile(target, 'Rule.', 'utf8')
    let symlinkCreated = false
    try {
      await symlink(target, agentsPath, 'file')
      symlinkCreated = true
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        (error.code === 'EPERM' || error.code === 'EACCES')
      )) {
        throw error
      }
    }
    if (symlinkCreated) {
      await assert.rejects(
        loadProjectInstructions({ cwd: directory, enabled: true }),
        /regular, non-symbolic-link file/
      )
      await rm(agentsPath)
    }

    await writeFile(
      agentsPath,
      Buffer.alloc(PROJECT_INSTRUCTION_MAX_BYTES + 1, 0x61)
    )
    await assert.rejects(
      loadProjectInstructions({ cwd: directory, enabled: true }),
      /exceeds/
    )

    await writeFile(agentsPath, Buffer.from([0xc3, 0x28]))
    await assert.rejects(
      loadProjectInstructions({ cwd: directory, enabled: true }),
      /valid UTF-8/
    )
  })
})
