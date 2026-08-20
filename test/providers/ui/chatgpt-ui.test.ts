import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'

import {
  observeChatGptAccessState,
  type ChatGPTAuthenticationPage,
} from '../../../src/providers/ui/chatgpt/chatgpt-ui.ts'
import { isAbortError } from '../../../src/runtime/runtime-cancellation.ts'

interface SessionProbeArguments {
  expectedOrigin: string
  probeTimeoutMs: number
  sessionPath: string
}

interface FetchCall {
  input: string
  init: RequestInit
}

function createSessionProbeHarness({
  session,
  responseUrl = 'https://chatgpt.com/api/auth/session',
}: {
  session: unknown
  responseUrl?: string
}) {
  const originalFetchCalls: FetchCall[] = []
  let wrappedFetchCalls = 0
  let jsonCalls = 0
  const captureEntries: unknown[] = []
  const originalFetch = async (
    input: string,
    init: RequestInit = {}
  ): Promise<{
    ok: boolean
    url: string
    json(): Promise<unknown>
  }> => {
    originalFetchCalls.push({ input, init })
    return {
      ok: true,
      url: responseUrl,
      json: async () => {
        jsonCalls += 1
        return session
      },
    }
  }
  const page: ChatGPTAuthenticationPage = {
    url: () => 'https://chatgpt.com/',
    evaluate: async (
      pageFunction: (arguments_: SessionProbeArguments) => Promise<boolean>,
      arguments_: SessionProbeArguments
    ) => {
      const result: unknown = await runInNewContext(
        `(${pageFunction.toString()})(globalThis.__arguments)`,
        {
          __arguments: arguments_,
          __portalOriginalFetch: originalFetch,
          __portalFetchCaptureEntries: captureEntries,
          fetch: async () => {
            wrappedFetchCalls += 1
            throw new Error('The wrapped fetch must not be used by auth probe.')
          },
          AbortController,
          URL,
          clearTimeout,
          setTimeout,
        }
      )
      if (typeof result !== 'boolean') {
        throw new Error('Session probe returned a non-boolean result.')
      }
      return result
    },
  }

  return {
    page,
    captureEntries,
    originalFetchCalls,
    get wrappedFetchCalls() {
      return wrappedFetchCalls
    },
    get jsonCalls() {
      return jsonCalls
    },
  }
}

test('ChatGPT auth probe keeps session data inside the page and bypasses fetch capture', async () => {
  const secretSession = {
    user: { id: 'account-id', email: 'private@example.com' },
    accessToken: 'secret-token',
  }
  const harness = createSessionProbeHarness({ session: secretSession })

  const state = await observeChatGptAccessState(harness.page)

  assert.equal(state, 'authenticated')
  assert.equal(harness.wrappedFetchCalls, 0)
  assert.deepEqual(harness.captureEntries, [])
  assert.equal(harness.originalFetchCalls.length, 1)
  assert.equal(harness.originalFetchCalls[0]?.input, '/api/auth/session')
  assert.equal(harness.originalFetchCalls[0]?.init.credentials, 'include')
  assert.equal(harness.originalFetchCalls[0]?.init.redirect, 'error')
  assert.equal(harness.jsonCalls, 1)
})

test('ChatGPT auth probe treats Guest session and redirected responses as unauthenticated', async (t) => {
  await t.test('Guest session', async () => {
    const harness = createSessionProbeHarness({ session: {} })
    assert.equal(
      await observeChatGptAccessState(harness.page),
      'unauthenticated'
    )
  })

  await t.test('redirected response', async () => {
    const harness = createSessionProbeHarness({
      session: { user: { id: 'account-id' } },
      responseUrl: 'https://example.com/api/auth/session',
    })
    assert.equal(
      await observeChatGptAccessState(harness.page),
      'unauthenticated'
    )
    assert.equal(harness.jsonCalls, 0)
  })
})

test('ChatGPT auth probe fails closed after its page-side timeout', async () => {
  let aborted = false
  const page: ChatGPTAuthenticationPage = {
    url: () => 'https://chatgpt.com/',
    evaluate: async (
      pageFunction: (arguments_: SessionProbeArguments) => Promise<boolean>,
      arguments_: SessionProbeArguments
    ) => {
      const result: unknown = await runInNewContext(
        `(${pageFunction.toString()})(globalThis.__arguments)`,
        {
          __arguments: arguments_,
          __portalOriginalFetch: async (_input: string, init: RequestInit) =>
            await new Promise((_resolve, reject) => {
              init.signal?.addEventListener(
                'abort',
                () => {
                  aborted = true
                  const error = new Error('aborted')
                  error.name = 'AbortError'
                  reject(error)
                },
                { once: true }
              )
            }),
          AbortController,
          URL,
          clearTimeout,
          setTimeout,
        }
      )
      if (typeof result !== 'boolean') {
        throw new Error('Session probe returned a non-boolean result.')
      }
      return result
    },
  }

  assert.equal(await observeChatGptAccessState(page, {}, 5), 'unauthenticated')
  assert.equal(aborted, true)
})

test('ChatGPT auth probe returns promptly when restore is cancelled', async () => {
  let evaluationCalls = 0
  const page: ChatGPTAuthenticationPage = {
    url: () => 'https://chatgpt.com/',
    evaluate: async () => {
      evaluationCalls += 1
      return await new Promise<boolean>(() => {})
    },
  }
  const controller = new AbortController()
  const pending = observeChatGptAccessState(page, {
    signal: controller.signal,
  })

  controller.abort()

  await assert.rejects(pending, isAbortError)
  assert.equal(evaluationCalls, 1)
})

test('ChatGPT auth probe does not start when already cancelled', async () => {
  let evaluationCalls = 0
  const page: ChatGPTAuthenticationPage = {
    url: () => 'https://chatgpt.com/',
    evaluate: async () => {
      evaluationCalls += 1
      return true
    },
  }
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    observeChatGptAccessState(page, { signal: controller.signal }),
    isAbortError
  )
  assert.equal(evaluationCalls, 0)
})
