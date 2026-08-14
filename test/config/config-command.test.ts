import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'

import { runConfigCli } from '../../src/config/config-command.ts'

test('portal config prints one absolute path without creating state', async () => {
  let stdout = ''
  let stderr = ''
  const exitCode = await runConfigCli([], {
    cwd: 'C:\\work',
    env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
    homeDirectory: 'C:\\Users\\test',
    platform: 'win32',
    output: { write: (text) => (stdout += text) },
    errorOutput: { write: (text) => (stderr += text) },
  })

  assert.equal(exitCode, 0)
  assert.equal(
    stdout,
    `${path.win32.join('C:\\Users\\test\\AppData\\Local', 'portal', 'config.yaml')}\n`
  )
  assert.equal(stderr, '')
})

test('portal config honors explicit and environment data directories', async () => {
  for (const [argv, env, expected] of [
    [
      ['--data-dir', '../explicit'],
      { PORTAL_DATA_DIR: '../environment' },
      'C:\\explicit\\config.yaml',
    ],
    [[], { PORTAL_DATA_DIR: '../environment' }, 'C:\\environment\\config.yaml'],
  ] as const) {
    let stdout = ''
    assert.equal(
      await runConfigCli(argv, {
        cwd: 'C:\\work',
        env,
        homeDirectory: 'C:\\Users\\test',
        platform: 'win32',
        output: { write: (text) => (stdout += text) },
        errorOutput: { write: () => {} },
      }),
      0
    )
    assert.equal(stdout, `${expected}\n`)
  }
})

test('portal config rejects subcommands', async () => {
  let stderr = ''
  assert.equal(
    await runConfigCli(['path'], {
      output: { write: () => {} },
      errorOutput: { write: (text) => (stderr += text) },
    }),
    2
  )
  assert.match(stderr, /too many arguments/i)
})

test('portal config reports invalid paths as usage without stdout', async () => {
  let stdout = ''
  let stderr = ''
  assert.equal(
    await runConfigCli(['--data-dir', ' '], {
      output: { write: (text) => (stdout += text) },
      errorOutput: { write: (text) => (stderr += text) },
    }),
    2
  )
  assert.equal(stdout, '')
  assert.match(stderr, /--data-dir must not be empty/)
})

test('portal config uses the selected platform path syntax', async () => {
  let stdout = ''
  assert.equal(
    await runConfigCli([], {
      cwd: '/work',
      env: { XDG_DATA_HOME: '/var/data' },
      homeDirectory: '/home/test',
      platform: 'linux',
      output: { write: (text) => (stdout += text) },
      errorOutput: { write: () => {} },
    }),
    0
  )
  assert.equal(stdout, '/var/data/portal/config.yaml\n')
})
