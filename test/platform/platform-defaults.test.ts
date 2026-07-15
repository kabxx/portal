import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getDefaultBrowserExecutableCandidates,
  getDefaultShell,
  getShellCommand,
  getSupportedShells,
} from '../../src/platform/platform-defaults.ts'

test('browser defaults include native macOS application paths', () => {
  const candidates = getDefaultBrowserExecutableCandidates(
    'darwin',
    {},
    '/Users/tester'
  )

  assert.deepEqual(candidates.slice(0, 3), [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ])
  assert.ok(
    candidates.includes(
      '/Users/tester/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    )
  )
})

test('browser defaults include Windows installation roots', () => {
  const candidates = getDefaultBrowserExecutableCandidates(
    'win32',
    {
      ProgramFiles: 'D:\\Program Files',
      'ProgramFiles(x86)': 'D:\\Program Files (x86)',
      LOCALAPPDATA: 'D:\\Users\\tester\\AppData\\Local',
    },
    'C:\\Users\\tester'
  )

  assert.equal(
    candidates[0],
    'D:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  )
  assert.ok(
    candidates.includes(
      'D:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'
    )
  )
})

test('browser defaults include Linux distribution and PATH locations', () => {
  const candidates = getDefaultBrowserExecutableCandidates('linux', {
    PATH: '/custom/bin:/usr/local/bin',
  })

  assert.equal(candidates[0], '/usr/bin/microsoft-edge')
  assert.ok(candidates.includes('/snap/bin/chromium'))
  assert.ok(candidates.includes('/custom/bin/chromium'))
})

test('default shell follows the platform and login shell', () => {
  assert.equal(getDefaultShell('win32', {}), 'powershell')
  assert.equal(
    getDefaultShell('darwin', { SHELL: '/bin/zsh' }, () => true),
    'zsh'
  )
  assert.equal(
    getDefaultShell('linux', { SHELL: '/bin/fish' }, () => true),
    'fish'
  )
  assert.equal(
    getDefaultShell(
      'linux',
      { SHELL: '/missing/zsh', PATH: '/bin' },
      (filePath) => filePath === '/bin/bash'
    ),
    'bash'
  )
})

test('supported shells do not expose cmd on POSIX', () => {
  assert.deepEqual(getSupportedShells('win32', {}), ['powershell', 'cmd'])
  assert.equal(getSupportedShells('darwin', {}).includes('cmd'), false)
})

test('shell command uses the selected shell executable', () => {
  assert.deepEqual(
    getShellCommand('zsh', 'pwd', 'darwin', {}, () => true),
    {
      file: '/bin/zsh',
      args: ['-lc', 'pwd'],
    }
  )
  assert.deepEqual(
    getShellCommand('sh', 'pwd', 'linux', {}, () => true),
    {
      file: '/bin/sh',
      args: ['-c', 'pwd'],
    }
  )
  assert.throws(
    () => getShellCommand('cmd', 'dir', 'linux', {}),
    /only available on Windows/
  )
})

test('shell command preserves an available custom login shell path', () => {
  assert.deepEqual(
    getShellCommand(
      'zsh',
      'pwd',
      'darwin',
      { SHELL: '/opt/custom/zsh' },
      (filePath) => filePath === '/opt/custom/zsh'
    ),
    {
      file: '/opt/custom/zsh',
      args: ['-lc', 'pwd'],
    }
  )
})
