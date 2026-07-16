import test from 'node:test'
import assert from 'node:assert/strict'

import { launchWin32BrowserMinimized } from '../../src/platform/win32-minimized-browser-launcher.ts'

test(
  'Windows browser launch fails when Job Object assignment fails',
  { skip: process.platform !== 'win32' },
  async () => {
    let closedJobs = 0

    await assert.rejects(
      launchWin32BrowserMinimized(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        {
          createJob: () => 123,
          assignPidToJob: () => false,
          closeJob: () => {
            closedJobs += 1
          },
        }
      ),
      /Failed to assign browser process to Windows Job Object/
    )
    assert.equal(closedJobs, 1)
  }
)
