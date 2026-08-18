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
    surface: {
      getActiveThread: () => null,
      listAgentModes: () => ['chat'],
    },
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
        'No active thread. Use /thread chat to create one, or /help to see commands.',
    },
  ])
})

test('TUI input handler does not advertise a disabled Agent mode', async () => {
  const warnings: unknown[] = []
  // This focused fake implements only the no-Agent path.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const dependencies = {
    surface: {
      getActiveThread: () => null,
      listAgentModes: () => [],
    },
    ui: {
      renderWarning: (_title: string, message: unknown) => {
        warnings.push(message)
      },
    },
  } as unknown as TuiThreadInputDependencies

  await createTuiThreadInputHandler(dependencies)('hello')

  assert.deepEqual(warnings, [
    'No active thread. No Agent mode is enabled; use /plugins list to inspect plugins.',
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
      clearLiveAssistant: () => {},
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

test('TUI input handler does not render a turn error again on operation rejection', async () => {
  const done = Promise.withResolvers<void>()
  const thread = {
    id: 'thread-1',
    provider: 'grok',
    runtime: { conversationUrl: 'https://grok.com/c/example' },
  }
  let onEvent: (event: unknown) => void | Promise<void> = () => {
    throw new Error('startMessage did not install its event handler')
  }
  let errorCount = 0
  // This focused fake implements the event error plus operation rejection path.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const dependencies = {
    surface: {
      getActiveThread: () => thread,
      startMessage: (
        _threadId: string,
        _input: string,
        handler: (event: unknown) => void | Promise<void>
      ) => {
        onEvent = handler
        return {
          accepted: true,
          operation: {
            threadId: 'thread-1',
            phase: 'running',
            startedAt: 1,
            done: done.promise,
            cancel: async () => true,
          },
        }
      },
    },
    ui: {
      renderUserMessage: () => {},
      setThreadBusy: () => {},
      clearLiveAssistant: () => {},
      clearLiveCommand: () => {},
      renderThreadError: () => {
        errorCount += 1
      },
    },
  } as unknown as TuiThreadInputDependencies

  await createTuiThreadInputHandler(dependencies)('input')
  await onEvent({
    type: 'turn.item',
    item: { kind: 'error', text: 'provider failure' },
  })
  done.reject(new Error('provider failure'))
  await assert.rejects(done.promise, /provider failure/)
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(errorCount, 1)
})

test('TUI input handler clears the live assistant on a Provider reset event', async () => {
  const done = Promise.withResolvers<void>()
  const thread = {
    id: 'thread-1',
    provider: 'grok',
    runtime: { conversationUrl: 'https://grok.com/c/example' },
  }
  let onEvent: (event: unknown) => void | Promise<void> = () => {
    throw new Error('startMessage did not install its event handler')
  }
  let clearCalls = 0
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const dependencies = {
    surface: {
      getActiveThread: () => thread,
      startMessage: (
        _threadId: string,
        _input: string,
        handler: (event: unknown) => void | Promise<void>
      ) => {
        onEvent = handler
        return {
          accepted: true,
          operation: {
            threadId: 'thread-1',
            phase: 'running',
            startedAt: 1,
            done: done.promise,
            cancel: async () => true,
          },
        }
      },
    },
    ui: {
      renderUserMessage: () => {},
      setThreadBusy: () => {},
      clearLiveAssistant: () => {
        clearCalls += 1
      },
      clearLiveCommand: () => {},
      renderThreadError: () => {},
    },
  } as unknown as TuiThreadInputDependencies

  await createTuiThreadInputHandler(dependencies)('input')
  await onEvent({ type: 'assistant.reset' })
  done.resolve()
  await done.promise
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(clearCalls, 2)
})
