import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'

import { launchPosixBrowser } from '../../src/platform/posix-browser-launcher.ts'

test(
  'POSIX browser close waits for the complete process group',
  { skip: process.platform === 'win32' },
  async () => {
    const browser = launchPosixBrowser(
      process.execPath,
      [
        '-e',
        [
          "const { spawn } = require('node:child_process')",
          "const child = spawn(process.execPath, ['-e', 'process.on(\\'SIGTERM\\', () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
          "process.stderr.write('READY:' + child.pid + '\\n')",
          "process.on('SIGTERM', () => {})",
          'setInterval(() => {}, 1000)',
        ].join(';'),
      ],
      { cleanupTimeoutMs: 2000, termGraceMs: 25 }
    )

    await waitForReady(browser.process)
    const firstClose = browser.close()
    const secondClose = browser.close()
    assert.equal(firstClose, secondClose)
    await firstClose
    assert.equal(processGroupExists(browser.browserPid), false)
  }
)

test(
  'POSIX browser close cleans descendants after the root exits first',
  { skip: process.platform === 'win32' },
  async () => {
    const browser = launchPosixBrowser(
      process.execPath,
      [
        '-e',
        [
          "const { spawn } = require('node:child_process')",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
          'child.unref()',
          "process.stderr.write('READY:' + child.pid + '\\n')",
        ].join(';'),
      ],
      { cleanupTimeoutMs: 2000, termGraceMs: 100 }
    )

    await waitForReady(browser.process)
    await once(browser.process, 'exit')
    assert.equal(processGroupExists(browser.browserPid), true)

    await waitUntil(() => !processGroupExists(browser.browserPid))
    assert.equal(processGroupExists(browser.browserPid), false)
    await browser.close()
  }
)

async function waitForReady(
  child: ReturnType<typeof launchPosixBrowser>['process']
): Promise<void> {
  const stderr = child.stderr
  assert.ok(stderr !== null)
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer | string) => {
      if (chunk.toString().includes('READY:')) {
        cleanup()
        resolve()
      }
    }
    const onExit = () => {
      cleanup()
      reject(new Error('POSIX test process exited before READY.'))
    }
    const cleanup = () => {
      stderr.off('data', onData)
      child.off('exit', onExit)
    }
    stderr.on('data', onData)
    child.once('exit', onExit)
  })
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for automatic process-group cleanup.')
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}
