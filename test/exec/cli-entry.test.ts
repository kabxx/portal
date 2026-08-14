import assert from 'node:assert/strict'
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
