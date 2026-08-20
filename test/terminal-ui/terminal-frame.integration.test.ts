import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { render } from '@kabxx/ink'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
import { createElement } from 'react'

import { clearTerminalBeforeRender } from '../../src/app/app-terminal-lifecycle.ts'
import { handleTuiHostEvent } from '../../src/app/tui-surface-plugin.ts'
import { KeybindingCatalog } from '../../src/keybindings/keybinding-catalog.ts'
import { createDefaultKeybindings } from '../../src/keybindings/keybinding-config.ts'
import { TerminalController } from '../../src/terminal-ui/terminal-controller.ts'
import { TerminalScreen } from '../../src/terminal-ui/terminal-screen.tsx'
import { ThreadManager } from '../../src/threads/thread-manager.ts'
import { createBuiltinCommandTestRuntime } from '../helpers/builtin-command-runtime.ts'
import { createFakeRuntime } from '../helpers/fakes.ts'
import { createTestSurfacePort } from '../helpers/surface-port.ts'

const CLEAR_DISPLAY = '\u001B[2J'
const CLEAR_SCROLLBACK = '\u001B[3J'
const headlessModule: unknown = createRequire(import.meta.url)(
  '@xterm/headless'
)
if (!isHeadlessModule(headlessModule)) {
  throw new Error('@xterm/headless did not expose its Terminal constructor')
}
const HeadlessTerminalConstructor = headlessModule.Terminal

test('provision failure restores complete bubbles without runtime full-screen clears', async () => {
  const commandFixture = createBuiltinCommandTestRuntime()
  const manager = new ThreadManager()
  const thread = manager.addThread({
    id: 't-existing',
    provider: 'chatgpt',
    runtime: createFakeRuntime(),
    createdAt: 1,
  })
  const surface = createTestSurfacePort(manager)
  const ui = new TerminalController()
  ui.bindSurfacePort(surface)
  ui.showThreadTimeline(thread.id)
  ui.renderInfo('thread', 'existing output')

  const outputChunks: string[] = []
  const output = createTtyOutput(80, 32)
  output.on('data', (chunk: Buffer) => outputChunks.push(chunk.toString()))
  const input = createTtyInput()
  const keybindings = new KeybindingCatalog(
    'unused-keybindings.yaml',
    createDefaultKeybindings('win32'),
    () => {},
    'win32'
  )

  clearTerminalBeforeRender(output)
  const ink = render(
    createElement(TerminalScreen, {
      ui,
      commandSession: commandFixture.session,
      commandCompletionSnapshot: commandFixture.completionSnapshot,
      keybindings,
      onInterrupt: () => {},
    }),
    {
      stdin: input,
      stdout: output,
      stderr: output,
      interactive: true,
      incrementalRendering: true,
      exitOnCtrlC: false,
      patchConsole: false,
      reserveTrailingLine: false,
      kittyKeyboard: { mode: 'disabled' },
      windowsConsoleInput: { mode: 'disabled' },
    }
  )

  try {
    await ink.waitUntilRenderFlush()
    await new Promise<void>((resolve) => setImmediate(resolve))

    const pendingProvision: Parameters<
      typeof handleTuiHostEvent
    >[1]['pendingProvision'] = new Map()
    const projectThreadEvent = (
      event: Parameters<typeof handleTuiHostEvent>[0]
    ) =>
      handleTuiHostEvent(event, {
        ui,
        surface,
        pendingProvision,
        requestExit: () => assert.fail('provision events must not exit'),
      })
    projectThreadEvent({
      type: 'thread.lifecycle',
      event: {
        type: 'provision.started',
        threadId: 't-pending',
        source: 'tui',
        stage: 'resolving',
      },
    })
    projectThreadEvent({
      type: 'thread.lifecycle',
      event: {
        type: 'provision.warning',
        threadId: 't-pending',
        source: 'tui',
        title: 'login',
        lines: ['pending warning'],
      },
    })
    await ink.waitUntilRenderFlush()

    projectThreadEvent({
      type: 'thread.lifecycle',
      event: {
        type: 'provision.finished',
        threadId: 't-pending',
        source: 'tui',
        status: 'failed',
        stage: 'restore',
        message: 'first failure',
      },
    })
    ui.renderError('runtime', 'second failure')
    await ink.waitUntilRenderFlush()

    const outputBytes = outputChunks.join('')
    assert.equal(countOccurrences(outputBytes, CLEAR_DISPLAY), 1)
    assert.equal(countOccurrences(outputBytes, CLEAR_SCROLLBACK), 1)

    const terminal = new HeadlessTerminalConstructor({
      allowProposedApi: true,
      cols: 80,
      rows: 32,
      scrollback: 100,
    })
    try {
      await writeTerminal(terminal, outputBytes)
      const lines = readViewportLines(terminal)
      assertBubbleBorders(lines, 'first failure')
      assertBubbleBorders(lines, 'second failure')
    } finally {
      terminal.dispose()
    }
  } finally {
    ink.unmount()
    await ink.waitUntilExit()
    keybindings.stop()
    input.destroy()
    output.destroy()
    await commandFixture.close()
  }
})

function createTtyOutput(columns: number, rows: number): NodeJS.WriteStream {
  const stream = Object.assign(new PassThrough(), {
    columns,
    rows,
    isTTY: true,
    getColorDepth: () => 8,
    hasColors: () => true,
  })
  // Ink types require a concrete TTY stream; the renderer uses this stream protocol.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return stream as unknown as NodeJS.WriteStream
}

function createTtyInput(): NodeJS.ReadStream {
  const stream = Object.assign(new PassThrough(), {
    isRaw: false,
    isTTY: true,
    ref() {
      return this
    },
    setRawMode(enabled: boolean) {
      this.isRaw = enabled
      return this
    },
    unref() {
      return this
    },
  })
  // Ink types require a concrete TTY stream; the renderer uses this stream protocol.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return stream as unknown as NodeJS.ReadStream
}

async function writeTerminal(
  terminal: HeadlessTerminal,
  data: string
): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve))
}

function readViewportLines(terminal: HeadlessTerminal): string[] {
  const buffer = terminal.buffer.active
  return Array.from(
    { length: terminal.rows },
    (_, index) =>
      buffer.getLine(buffer.baseY + index)?.translateToString(true) ?? ''
  )
}

function assertBubbleBorders(lines: readonly string[], body: string): void {
  const matchingIndexes = lines.flatMap((line, index) =>
    line.includes(body) ? [index] : []
  )
  assert.equal(
    matchingIndexes.length,
    1,
    `expected one visible bubble body for ${body}`
  )
  const [bodyIndex = -1] = matchingIndexes
  assert.notEqual(bodyIndex, -1, `missing bubble body: ${body}`)
  const topBorder = (lines[bodyIndex - 1] ?? '').trimStart()
  const bodyLine = (lines[bodyIndex] ?? '').trimStart()
  const bottomBorder = (lines[bodyIndex + 1] ?? '').trimStart()
  assert.match(topBorder, /^┌.*┐$/u)
  assert.match(bodyLine, /^│.*│$/u)
  assert.match(bottomBorder, /^└─+┘$/u)
  assert.equal(topBorder.length, bodyLine.length)
  assert.equal(bottomBorder.length, bodyLine.length)
}

function countOccurrences(value: string, search: string): number {
  return value.split(search).length - 1
}

function isHeadlessModule(
  value: unknown
): value is { Terminal: typeof HeadlessTerminal } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'Terminal' in value &&
    typeof value.Terminal === 'function'
  )
}
