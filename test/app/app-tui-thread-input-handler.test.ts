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
    threadManager: { getActiveThread: () => null },
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
    threadManager: {
      getActiveThread: () => thread,
      submitThreadInput: async () => ({ assistant: 'done' }),
    },
    threadLifecycle: {
      startSend: (
        _threadId: string,
        _input: string,
        runner: (signal: AbortSignal) => Promise<void>
      ) => {
        operationDone = runner(new AbortController().signal)
        return {
          accepted: true,
          operation: { done: operationDone },
        }
      },
      recordActivity: async (activity: unknown) => {
        activities.push(activity)
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
    runCommandJobs: { list: () => [] },
    browserProfileDir: 'C:/portal-profile',
  } as unknown as TuiThreadInputDependencies

  const submitThreadInput = createTuiThreadInputHandler(dependencies)
  await submitThreadInput('runtime input', 'Display input')
  await operationDone

  assert.deepEqual(userMessages, ['Display input'])
  assert.deepEqual(busyStates, [true, false])
  assert.deepEqual(activities, [
    {
      threadId: 'thread-1',
      provider: 'grok',
      conversationUrl: 'https://grok.com/c/example',
      title: 'Display input',
    },
  ])
})
