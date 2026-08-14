import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ExecUsageError,
  MAX_EXEC_TIMEOUT_SECONDS,
  parseExecTimeoutSeconds,
  resolveExecTask,
} from '../../src/exec/exec-input.ts'

test('resolveExecTask accepts argv, stdin, and argv plus stdin context', () => {
  assert.equal(
    resolveExecTask(['summarize', 'this'], '', true),
    'summarize this'
  )
  assert.equal(resolveExecTask([], 'from stdin\n', false), 'from stdin')
  assert.equal(
    resolveExecTask(['review'], 'const value = 1\n', false),
    'review\n\nconst value = 1'
  )
})

test('resolveExecTask treats a lone dash as explicit stdin', () => {
  assert.equal(resolveExecTask(['-'], 'piped task\n', false), 'piped task')
  assert.throws(
    () => resolveExecTask(['-', 'extra'], 'task', false),
    ExecUsageError
  )
  assert.throws(() => resolveExecTask(['-'], '', true), ExecUsageError)
})

test('resolveExecTask rejects empty interactive input', () => {
  assert.throws(() => resolveExecTask([], '', true), ExecUsageError)
  assert.throws(() => resolveExecTask([], '  ', false), ExecUsageError)
})

test('parseExecTimeoutSeconds accepts positive values only', () => {
  assert.equal(parseExecTimeoutSeconds(undefined), null)
  assert.equal(parseExecTimeoutSeconds('1.5'), 1.5)
  assert.equal(
    parseExecTimeoutSeconds(String(MAX_EXEC_TIMEOUT_SECONDS)),
    MAX_EXEC_TIMEOUT_SECONDS
  )
  for (const value of ['0', '-1', 'NaN', 'Infinity']) {
    assert.throws(() => parseExecTimeoutSeconds(value), ExecUsageError)
  }
  assert.throws(
    () => parseExecTimeoutSeconds(String(MAX_EXEC_TIMEOUT_SECONDS + 0.001)),
    ExecUsageError
  )
})
