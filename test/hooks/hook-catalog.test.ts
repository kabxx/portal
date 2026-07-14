import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'

import {
  createDefaultPortalConfig,
  ensurePortalConfig,
  updatePortalConfig,
} from '../../src/config/portal-config.ts'
import { createHookSnapshot } from '../../src/hooks/hook-config.ts'
import { HookCatalog } from '../../src/hooks/hook-catalog.ts'

test('HookCatalog reloads atomically and persists the single global switch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-hook-catalog-'))
  const configPath = path.join(root, 'data', 'config.yaml')
  try {
    const defaults = createDefaultPortalConfig(path.join(root, 'data'))
    await ensurePortalConfig(configPath, defaults)
    const catalog = new HookCatalog(
      configPath,
      createHookSnapshot(defaults.hooks)
    )
    await updatePortalConfig(
      configPath,
      (config) => {
        config.hooks = {
          enabled: true,
          maxDepth: 1,
          handlers: [
            {
              name: 'one',
              enabled: true,
              type: 'command',
              events: ['turn.started'],
              match: {},
              timeoutMs: 5000,
              onError: 'continue',
              command: ['node', '-e', 'process.exit(0)'],
            },
          ],
        }
      },
      defaults
    )
    const next = await catalog.reload()
    assert.equal(next.enabled, true)
    assert.equal(next.handlers.length, 1)
    const validContents = await readFile(configPath, 'utf8')

    await writeFile(configPath, `${stringify({ invalid: true })}`, 'utf8')
    await assert.rejects(catalog.reload())
    assert.equal(catalog.snapshot().revision, next.revision)

    await writeFile(configPath, validContents, 'utf8')
    const enabled = await catalog.setEnabled(false)
    assert.equal(enabled.enabled, false)
    const document = await readFile(configPath, 'utf8')
    assert.match(document, /enabled: false/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
