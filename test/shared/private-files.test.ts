import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  ensurePrivateDirectory,
  ensurePrivateDirectorySync,
  ensurePrivateFile,
  ensurePrivateFileSync,
} from '../../src/shared/private-files.ts'

test(
  'private file helpers preserve stricter POSIX owner permissions',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'portal-private-mode-'))
    const asyncDirectory = path.join(root, 'async-directory')
    const syncDirectory = path.join(root, 'sync-directory')
    const asyncFile = path.join(root, 'async-file')
    const syncFile = path.join(root, 'sync-file')

    try {
      await mkdir(asyncDirectory)
      await mkdir(syncDirectory)
      await writeFile(asyncFile, 'private')
      await writeFile(syncFile, 'private')
      await chmod(asyncDirectory, 0o500)
      await chmod(syncDirectory, 0o500)
      await chmod(asyncFile, 0o400)
      await chmod(syncFile, 0o400)

      await ensurePrivateDirectory(asyncDirectory)
      ensurePrivateDirectorySync(syncDirectory)
      await ensurePrivateFile(asyncFile)
      ensurePrivateFileSync(syncFile)

      assert.equal((await stat(asyncDirectory)).mode & 0o777, 0o500)
      assert.equal(fs.statSync(syncDirectory).mode & 0o777, 0o500)
      assert.equal((await stat(asyncFile)).mode & 0o777, 0o400)
      assert.equal(fs.statSync(syncFile).mode & 0o777, 0o400)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
