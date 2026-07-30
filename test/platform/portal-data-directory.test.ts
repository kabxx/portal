import assert from 'node:assert/strict'
import test from 'node:test'

import { resolvePortalDataDirectory } from '../../src/platform/portal-data-directory.ts'

test('command-line data directory overrides the environment', () => {
  assert.equal(
    resolvePortalDataDirectory({
      cwd: '/workspace',
      dataDirectory: 'state',
      env: { PORTAL_DATA_DIR: '/environment-state' },
      homeDirectory: '/home/portal',
      platform: 'linux',
    }),
    '/workspace/state'
  )
})

test('environment data directory resolves from the working directory', () => {
  assert.equal(
    resolvePortalDataDirectory({
      cwd: '/workspace',
      env: { PORTAL_DATA_DIR: '../portal-state' },
      homeDirectory: '/home/portal',
      platform: 'linux',
    }),
    '/portal-state'
  )
})

test('Windows defaults to LOCALAPPDATA', () => {
  assert.equal(
    resolvePortalDataDirectory({
      cwd: 'C:\\workspace',
      env: { LOCALAPPDATA: 'C:\\Users\\portal\\AppData\\Local' },
      homeDirectory: 'C:\\Users\\portal',
      platform: 'win32',
    }),
    'C:\\Users\\portal\\AppData\\Local\\portal'
  )
})

test('macOS defaults to Application Support', () => {
  assert.equal(
    resolvePortalDataDirectory({
      cwd: '/workspace',
      env: {},
      homeDirectory: '/Users/portal',
      platform: 'darwin',
    }),
    '/Users/portal/Library/Application Support/portal'
  )
})

test('Linux uses absolute XDG_DATA_HOME and ignores relative values', () => {
  assert.equal(
    resolvePortalDataDirectory({
      cwd: '/workspace',
      env: { XDG_DATA_HOME: '/var/lib/portal-user' },
      homeDirectory: '/home/portal',
      platform: 'linux',
    }),
    '/var/lib/portal-user/portal'
  )
  assert.equal(
    resolvePortalDataDirectory({
      cwd: '/workspace',
      env: { XDG_DATA_HOME: 'relative' },
      homeDirectory: '/home/portal',
      platform: 'linux',
    }),
    '/home/portal/.local/share/portal'
  )
})

test('empty command-line data directory is rejected', () => {
  assert.throws(
    () =>
      resolvePortalDataDirectory({
        cwd: '/workspace',
        dataDirectory: '  ',
        env: {},
        homeDirectory: '/home/portal',
        platform: 'linux',
      }),
    /--data-dir must not be empty/
  )
})
