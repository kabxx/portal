import test from 'node:test'
import assert from 'node:assert/strict'

import { ThreadSelectionController } from '../../src/threads/thread-selection.ts'

test('ThreadSelectionController does not activate registered API or MCP threads', () => {
  const selection = new ThreadSelectionController()
  selection.register('t-api')
  selection.register('t-mcp')

  assert.deepEqual(selection.list(), ['t-api', 't-mcp'])
  assert.equal(selection.getActiveId(), null)
})

test('ThreadSelectionController switches only to known threads and detaches selection', () => {
  const selection = new ThreadSelectionController()
  selection.registerMany(['t-1', 't-2'])

  assert.equal(selection.switch('missing'), false)
  assert.equal(selection.switch('t-2'), true)
  assert.equal(selection.getActiveId(), 't-2')
  assert.equal(selection.detach('t-2'), true)
  assert.equal(selection.getActiveId(), null)
  assert.deepEqual(selection.list(), ['t-1'])
})

test('ThreadSelectionController sync preserves a valid active thread', () => {
  const selection = new ThreadSelectionController()
  selection.registerMany(['t-1', 't-2'])
  selection.switch('t-1')

  selection.sync(['t-1', 't-3'])
  assert.equal(selection.getActiveId(), 't-1')
  assert.deepEqual(selection.list(), ['t-1', 't-3'])

  selection.sync(['t-3'])
  assert.equal(selection.getActiveId(), null)
})

test('ThreadSelectionController clears selection without forgetting threads', () => {
  const selection = new ThreadSelectionController()
  selection.registerMany(['t-1', 't-2'])
  selection.switch('t-1')

  selection.clearActive()

  assert.equal(selection.getActiveId(), null)
  assert.equal(selection.switch('t-2'), true)
})
