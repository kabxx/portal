import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createJob,
  assignPidToJob,
  closeJob,
} from '../../src/platform/win32-process-job.ts'

test('createJob returns a valid handle on Windows', () => {
  if (process.platform !== 'win32') {
    assert.equal(createJob(), null)
    return
  }

  const job = createJob()
  assert.ok(job !== null, 'Job handle should not be null')
  assert.ok(typeof job === 'number', 'Job handle should be a number')
  assert.ok(job > 0, 'Job handle should be positive')

  // Clean up
  closeJob(job)
})

test('assignPidToJob returns false for invalid PID', () => {
  if (process.platform !== 'win32') {
    assert.equal(assignPidToJob(0, 0), false)
    return
  }

  const job = createJob()
  assert.ok(job !== null)

  // PID 0 is the System Idle Process — can't be assigned to a job
  const result = assignPidToJob(job, 0)
  assert.equal(result, false)

  closeJob(job)
})

test('createJob creates independent handles', () => {
  if (process.platform !== 'win32') return

  const j1 = createJob()
  const j2 = createJob()
  assert.ok(j1 !== null)
  assert.ok(j2 !== null)
  assert.notEqual(j1, j2, 'Each call should create a new job')

  closeJob(j1)
  closeJob(j2)
})
