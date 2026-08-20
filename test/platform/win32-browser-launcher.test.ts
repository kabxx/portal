import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'

import { launchWin32Browser } from '../../src/platform/win32-browser-launcher.ts'

function fakeJobOperations(
  overrides: {
    onTerminate?: () => void
    onClose?: () => void
    active?: () => number
  } = {}
) {
  return {
    createJob: () => 123,
    assignPidToJob: () => true,
    isPidInJob: () => true,
    terminateJob: () => {
      overrides.onTerminate?.()
      return true
    },
    getJobActiveProcessCount: () => overrides.active?.() ?? 0,
    closeJob: () => overrides.onClose?.(),
  }
}

test(
  'Windows browser launch fails when Job Object assignment fails',
  { skip: process.platform !== 'win32' },
  async () => {
    let closedJobs = 0

    await assert.rejects(
      launchWin32Browser(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        {
          createJob: () => 123,
          assignPidToJob: () => false,
          isPidInJob: () => false,
          terminateJob: () => false,
          getJobActiveProcessCount: () => 0,
          closeJob: () => {
            closedJobs += 1
          },
        }
      ),
      /Failed to assign Windows browser helper to the Job Object/
    )
    assert.equal(closedJobs, 1)
  }
)

test('Windows helper handshake responds to caller cancellation', async () => {
  const controller = new AbortController()
  let closedJobs = 0
  const pending = launchWin32Browser(
    process.execPath,
    [],
    fakeJobOperations({ onClose: () => (closedJobs += 1) }),
    {
      helperCommand: process.execPath,
      helperArguments: ['-e', 'setInterval(() => {}, 1000)'],
      signal: controller.signal,
      startupDeadline: Date.now() + 2000,
    }
  )

  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(closedJobs, 1)
})

test('Windows helper handshake observes the shared startup deadline', async () => {
  let closedJobs = 0
  await assert.rejects(
    launchWin32Browser(
      process.execPath,
      [],
      fakeJobOperations({ onClose: () => (closedJobs += 1) }),
      {
        helperCommand: process.execPath,
        helperArguments: ['-e', 'setInterval(() => {}, 1000)'],
        startupDeadline: Date.now() + 20,
      }
    ),
    /Timed out waiting for the Windows browser helper/
  )
  assert.equal(closedJobs, 1)
})

test('Windows helper drains browser stderr and cleans its Job after exit', async () => {
  let active = 1
  let terminated = 0
  let closedJobs = 0
  const browser = await launchWin32Browser(
    process.execPath,
    [
      '-e',
      "setTimeout(() => process.stderr.write('x'.repeat(262144) + '\\nbind failed: address already in use\\n', () => process.exit(1)), 25)",
    ],
    fakeJobOperations({
      active: () => active,
      onTerminate: () => {
        terminated += 1
        active = 0
      },
      onClose: () => {
        closedJobs += 1
      },
    }),
    { cleanupTimeoutMs: 2000, startupDeadline: Date.now() + 2000 }
  )
  const stderr = browser.process.stderr
  assert.ok(stderr !== null)
  let output = ''
  stderr.on('data', (chunk: Buffer | string) => {
    output += chunk.toString()
  })

  await once(browser.process, 'exit')
  await browser.close()

  assert.match(output, /bind failed: address already in use/)
  assert.equal(terminated, 1)
  assert.equal(closedJobs, 1)
})

test(
  'Windows browser launch contains the helper before launching and closes once',
  { skip: process.platform !== 'win32' },
  async () => {
    const browser = await launchWin32Browser(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
    ])

    assert.ok(browser.browserPid > 0)
    const firstClose = browser.close()
    const secondClose = browser.close()
    assert.equal(firstClose, secondClose)
    await firstClose
    assert.ok(
      browser.process.exitCode !== null || browser.process.signalCode !== null
    )
  }
)
