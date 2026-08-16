import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'

import { runPortalCli } from '../../src/cli-entry.ts'

test('runPortalCli dispatches exec without starting the TUI', async () => {
  let tuiCalls = 0
  let execArguments: readonly string[] | null = null
  const exitCode = await runPortalCli(
    ['node', 'portal', 'exec', '--provider', 'chatgpt', 'question'],
    {
      runTui: async () => {
        tuiCalls += 1
      },
      runExec: async (argv) => {
        execArguments = argv
        return 0
      },
    }
  )

  assert.equal(exitCode, 0)
  assert.equal(tuiCalls, 0)
  assert.deepEqual(execArguments, ['--provider', 'chatgpt', 'question'])
})

test('runPortalCli dispatches config without starting exec or the TUI', async () => {
  let tuiCalls = 0
  let execCalls = 0
  let configArguments: readonly string[] | null = null
  const exitCode = await runPortalCli(['node', 'portal', 'config'], {
    runTui: async () => {
      tuiCalls += 1
    },
    runExec: async () => {
      execCalls += 1
      return 0
    },
    runConfig: async (argv) => {
      configArguments = argv
      return 0
    },
  })

  assert.equal(exitCode, 0)
  assert.equal(tuiCalls, 0)
  assert.equal(execCalls, 0)
  assert.deepEqual(configArguments, [])
})

test('runPortalCli dispatches plugins recovery commands without starting the TUI', async () => {
  let tuiCalls = 0
  let pluginArguments: readonly string[] | null = null
  const exitCode = await runPortalCli(
    ['node', 'portal', 'plugins', 'diagnose'],
    {
      runTui: async () => {
        tuiCalls += 1
      },
      runPlugins: async (argv) => {
        pluginArguments = argv
        return 0
      },
    }
  )

  assert.equal(exitCode, 0)
  assert.equal(tuiCalls, 0)
  assert.deepEqual(pluginArguments, ['diagnose'])
})

test('the exec module graph does not load the TUI surface', () => {
  const fixture = path.resolve('test/fixtures/exec-without-tui.mjs')
  const result = spawnSync(process.execPath, ['--import', 'tsx', fixture], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
