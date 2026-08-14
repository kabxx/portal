import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import {
  EXEC_EXIT_INTERRUPTED,
  EXEC_EXIT_RUNTIME_ERROR,
  EXEC_EXIT_SUCCESS,
  EXEC_EXIT_TIMEOUT,
  EXEC_EXIT_USAGE,
  runExecCli,
  type ExecCliDependencies,
} from '../../src/exec/exec-command.ts'
import type {
  PortalExecSession,
  PortalExecSessionFactory,
} from '../../src/exec/exec-types.ts'

test('runExecCli writes only the final answer to stdout', async () => {
  const harness = createHarness(async (task, signal, progress) => {
    assert.equal(task, 'inspect this\n\nadditional context')
    assert.equal(signal.aborted, false)
    progress({ type: 'status', message: '\u001b[31mConnected.\u001b[0m' })
    progress({ type: 'tool', name: '\u001b[32mrun_command\u001b[0m' })
    return 'Final answer.'
  })
  harness.dependencies.input = pipedInput('additional context\n')

  const exitCode = await runExecCli(
    ['--provider', 'chatgpt', 'inspect', 'this'],
    harness.dependencies
  )

  assert.equal(exitCode, EXEC_EXIT_SUCCESS)
  assert.equal(harness.stdout.value, 'Final answer.\n')
  assert.equal(harness.stderr.value, 'Connected.\ntool: run_command\n')
  assert.equal(harness.closeCalls(), 1)
})

test('runExecCli supports explicit stdin and validates provider/model input', async () => {
  const harness = createHarness(async (task) => {
    assert.equal(task, 'stdin task')
    return 'ok'
  })
  harness.dependencies.input = pipedInput('stdin task')
  assert.equal(
    await runExecCli(['--provider', 'gpt', '-'], harness.dependencies),
    EXEC_EXIT_SUCCESS
  )

  const missing = createHarness(async () => 'unused')
  assert.equal(
    await runExecCli(['question'], missing.dependencies),
    EXEC_EXIT_USAGE
  )
  assert.match(missing.stderr.value, /required option '--provider/)

  const invalid = createHarness(async () => 'unused')
  assert.equal(
    await runExecCli(
      ['--provider', 'chatgpt', '--model', 'missing', 'question'],
      invalid.dependencies
    ),
    EXEC_EXIT_USAGE
  )
  assert.match(invalid.stderr.value, /does not support model/)
})

test('runExecCli maps runtime failures and always closes the session', async () => {
  const harness = createHarness(async () => {
    throw new Error('provider failed')
  })
  const exitCode = await runExecCli(
    ['--provider', 'gemini', 'question'],
    harness.dependencies
  )

  assert.equal(exitCode, EXEC_EXIT_RUNTIME_ERROR)
  assert.match(harness.stderr.value, /provider failed/)
  assert.equal(harness.closeCalls(), 1)
})

test('runExecCli maps timeout and Ctrl+C to stable exit codes', async () => {
  const timeoutHarness = createHarness(
    async (_task, signal) => await waitForAbort(signal)
  )
  assert.equal(
    await runExecCli(
      ['--provider', 'qwen', '--timeout', '0.01', 'wait'],
      timeoutHarness.dependencies
    ),
    EXEC_EXIT_TIMEOUT
  )

  let interrupt: (() => void) | null = null
  const interruptHarness = createHarness(
    async (_task, signal) => await waitForAbort(signal)
  )
  interruptHarness.dependencies.addSigintListener = (listener) => {
    interrupt = listener
    queueMicrotask(listener)
    return () => {
      interrupt = null
    }
  }
  assert.equal(
    await runExecCli(
      ['--provider', 'deepseek', 'wait'],
      interruptHarness.dependencies
    ),
    EXEC_EXIT_INTERRUPTED
  )
  assert.equal(interrupt, null)
})

test('runExecCli applies timeout and Ctrl+C while reading piped stdin', async () => {
  let createdForTimeout = false
  const timeoutInput = blockingInput()
  const timeoutHarness = createHarness(async () => 'unused')
  timeoutHarness.dependencies.input = timeoutInput
  timeoutHarness.dependencies.createSession = async () => {
    createdForTimeout = true
    throw new Error('must not create a session')
  }

  assert.equal(
    await runExecCli(
      ['--provider', 'qwen', '--timeout', '0.01'],
      timeoutHarness.dependencies
    ),
    EXEC_EXIT_TIMEOUT
  )
  assert.equal(createdForTimeout, false)
  assert.equal(timeoutInput.destroyed, true)
  assert.match(timeoutHarness.stderr.value, /Timed out/)

  let createdForInterrupt = false
  const interruptInput = blockingInput()
  const interruptHarness = createHarness(async () => 'unused')
  interruptHarness.dependencies.input = interruptInput
  interruptHarness.dependencies.createSession = async () => {
    createdForInterrupt = true
    throw new Error('must not create a session')
  }
  interruptHarness.dependencies.addSigintListener = (listener) => {
    queueMicrotask(listener)
    return () => {}
  }

  assert.equal(
    await runExecCli(['--provider', 'deepseek'], interruptHarness.dependencies),
    EXEC_EXIT_INTERRUPTED
  )
  assert.equal(createdForInterrupt, false)
  assert.equal(interruptInput.destroyed, true)
  assert.equal(interruptHarness.stderr.value, '')
})

test('runExecCli rejects empty TTY input without creating a session', async () => {
  let created = false
  const harness = createHarness(async () => 'unused')
  harness.dependencies.input = Object.assign(Readable.from([]), { isTTY: true })
  harness.dependencies.createSession = async () => {
    created = true
    throw new Error('must not run')
  }

  assert.equal(
    await runExecCli(['--provider', 'kimi'], harness.dependencies),
    EXEC_EXIT_USAGE
  )
  assert.equal(created, false)
})

function createHarness(
  run: (
    task: string,
    signal: AbortSignal,
    progress: Parameters<PortalExecSessionFactory>[0]['onProgress']
  ) => Promise<string>
): {
  dependencies: ExecCliDependencies
  stdout: { value: string }
  stderr: { value: string }
  closeCalls(): number
} {
  const stdout = { value: '' }
  const stderr = { value: '' }
  let closes = 0
  const dependencies: ExecCliDependencies = {
    cwd: '/workspace',
    input: Object.assign(Readable.from([]), { isTTY: true }),
    output: { write: (text) => (stdout.value += text) },
    errorOutput: { write: (text) => (stderr.value += text) },
    addSigintListener: () => () => {},
    createSession: async (options) =>
      ({
        run: async (task, signal) =>
          await run(task, signal, options.onProgress),
        close: async () => {
          closes += 1
        },
      }) satisfies PortalExecSession,
  }
  return { dependencies, stdout, stderr, closeCalls: () => closes }
}

function pipedInput(value: string): Readable & { isTTY?: boolean } {
  return Object.assign(Readable.from([value]), { isTTY: false })
}

function blockingInput(): Readable & { isTTY?: boolean } {
  return Object.assign(
    new Readable({
      read() {},
    }),
    { isTTY: false }
  )
}

async function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('Operation aborted.')
  }
  return await new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error('Operation aborted.')
        ),
      { once: true }
    )
  })
}
