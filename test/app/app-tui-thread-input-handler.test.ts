import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createTuiThreadInputHandler,
  type TuiThreadInputDependencies,
} from '../../src/app/app-tui-thread-input-handler.ts'

test('TUI input handler reports the missing active-thread boundary', async () => {
  const warnings: Array<{ title: string; message: unknown }> = []
  // This focused fake implements only the no-active-thread path.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const dependencies = {
    surface: { getActiveThread: () => null },
    ui: {
      renderWarning: (title: string, message: unknown) => {
        warnings.push({ title, message })
      },
    },
  } as unknown as TuiThreadInputDependencies

  const submitThreadInput = createTuiThreadInputHandler(dependencies)
  await submitThreadInput('hello')

  assert.deepEqual(warnings, [
    {
      title: 'portal',
      message:
        'No active thread. Use /thread agent to create one, or /help to see commands.',
    },
  ])
})

test('TUI input handler starts a send and records the display input', async () => {
  const thread = {
    id: 'thread-1',
    provider: 'grok',
    runtime: { conversationUrl: 'https://grok.com/c/example' },
  }
  const userMessages: string[] = []
  const busyStates: boolean[] = []
  const activities: unknown[] = []
  let operationDone = Promise.resolve()
  // This focused fake implements only the accepted-send path.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const dependencies = {
    surface: {
      getActiveThread: () => thread,
      startMessage: (
        _threadId: string,
        _input: string,
        _onEvent: unknown,
        title: string
      ) => {
        activities.push(title)
        operationDone = Promise.resolve()
        return {
          accepted: true,
          operation: {
            threadId: 'thread-1',
            phase: 'running',
            startedAt: 1,
            done: operationDone,
            cancel: async () => true,
          },
        }
      },
    },
    ui: {
      renderUserMessage: (_thread: unknown, message: string) => {
        userMessages.push(message)
      },
      setThreadBusy: (_threadId: string, busy: boolean) => {
        busyStates.push(busy)
      },
      clearLiveCommand: () => {},
      renderThreadError: () => {},
    },
  } as unknown as TuiThreadInputDependencies

  const submitThreadInput = createTuiThreadInputHandler(dependencies)
  await submitThreadInput('runtime input', 'Display input')
  await operationDone

  assert.deepEqual(userMessages, ['Display input'])
  assert.deepEqual(busyStates, [true, false])
  assert.deepEqual(activities, ['Display input'])
})
