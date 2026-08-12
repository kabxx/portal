import assert from 'node:assert/strict'
import test from 'node:test'
import type { TimelineEntry } from '../../src/terminal-ui/terminal-controller.ts'
import { TerminalTranscriptWriter } from '../../src/terminal-ui/terminal-transcript-writer.ts'

function entry(id: number, body = `message-${id}`): TimelineEntry {
  return {
    id,
    tone: 'assistant',
    label: 'assistant',
    body,
    format: 'plain',
  }
}

function createHarness(platform: NodeJS.Platform = 'linux') {
  const writes: string[] = []
  let renderCalls = 0
  const writer = new TerminalTranscriptWriter((item, width) => {
    renderCalls += 1
    return `[${item.id}@${width}]${item.body}\n`
  }, platform)
  const write = (data: string) => {
    writes.push(data)
  }

  return {
    writer,
    write,
    writes,
    get renderCalls() {
      return renderCalls
    },
  }
}

test('transcript writer appends only new completed bubbles at the same width', () => {
  const harness = createHarness()
  const first = [entry(1), entry(2)]

  assert.deepEqual(harness.writer.sync(first, 80, true, harness.write), {
    status: 'written',
  })
  harness.writes.length = 0

  assert.deepEqual(
    harness.writer.sync([...first, entry(3)], 80, false, harness.write),
    { status: 'written' }
  )
  assert.deepEqual(harness.writes, ['[3@80]message-3\n'])
})

test('transcript writer uses explicit carriage returns on Windows', () => {
  const harness = createHarness('win32')

  harness.writer.sync([entry(1), entry(2)], 80, true, harness.write)

  assert.deepEqual(harness.writes, [
    '\u001B[2J\u001B[3J\u001B[H[1@80]message-1\r\n[2@80]message-2\r\n',
  ])
})

test('transcript writer appends with explicit carriage returns on Windows', () => {
  const harness = createHarness('win32')
  const first = [entry(1)]

  harness.writer.sync(first, 80, true, harness.write)
  harness.writes.length = 0
  harness.writer.sync([...first, entry(2)], 80, false, harness.write)

  assert.deepEqual(harness.writes, ['[2@80]message-2\r\n'])
})

test('transcript writer preserves existing CRLF on Windows', () => {
  const writes: string[] = []
  const writer = new TerminalTranscriptWriter(
    (item, width) => `[${item.id}@${width}]${item.body}\r\n`,
    'win32'
  )

  writer.sync([entry(1)], 80, true, (data) => writes.push(data))

  assert.deepEqual(writes, ['\u001B[2J\u001B[3J\u001B[H[1@80]message-1\r\n'])
})

test('transcript writer rebuilds every completed bubble after a resize', () => {
  const harness = createHarness()
  const timeline = [entry(1), entry(2), entry(3)]

  harness.writer.sync(timeline, 80, true, harness.write)
  harness.writes.length = 0

  assert.deepEqual(harness.writer.sync(timeline, 120, true, harness.write), {
    status: 'written',
  })
  assert.equal(
    harness.writes.join(''),
    '\u001B[2J\u001B[3J\u001B[H[1@120]message-1\n[2@120]message-2\n[3@120]message-3\n'
  )
})

test('transcript writer reuses cached wrapping for a height-only resize', () => {
  const harness = createHarness()
  const timeline = [entry(1), entry(2), entry(3)]

  harness.writer.sync(timeline, 80, true, harness.write)
  assert.equal(harness.renderCalls, timeline.length)

  harness.writes.length = 0
  harness.writer.sync(timeline, 80, true, harness.write)
  assert.equal(harness.renderCalls, timeline.length)
  assert.equal(
    harness.writes.join('').startsWith('\u001B[2J\u001B[3J\u001B[H'),
    true
  )
})

test('transcript writer does not cap the number of rows it replays', () => {
  const harness = createHarness()
  const timeline = Array.from({ length: 10_001 }, (_, index) => entry(index))

  assert.deepEqual(harness.writer.sync(timeline, 100, true, harness.write), {
    status: 'written',
  })
  const replay = harness.writes
    .join('')
    .slice('\u001B[2J\u001B[3J\u001B[H'.length)
  assert.equal(replay.split('\n').filter(Boolean).length, timeline.length)
  assert.match(replay, /^\[0@100\]message-0/)
  assert.match(replay, /\[10000@100\]message-10000\n$/)
})

test('transcript writer skips output when the timeline is unchanged', () => {
  const harness = createHarness()
  const timeline = [entry(1)]
  harness.writer.sync(timeline, 80, true, harness.write)
  harness.writes.length = 0

  assert.deepEqual(harness.writer.sync(timeline, 80, false, harness.write), {
    status: 'unchanged',
  })
  assert.deepEqual(harness.writes, [])
})

test('transcript writer replays unchanged content after a screen reset', () => {
  const harness = createHarness()
  const timeline = [entry(1)]
  harness.writer.sync(timeline, 80, true, harness.write)
  harness.writes.length = 0

  harness.writer.reset()

  assert.deepEqual(harness.writer.sync(timeline, 80, false, harness.write), {
    status: 'written',
  })
  assert.match(harness.writes.join(''), /\[1@80\]message-1/)
})
