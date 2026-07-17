import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type RequestListener } from 'node:http'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  fetchSkillHttp,
  writeSkillHttpResponse,
} from '../../src/skills/skill-http.ts'
import { PortalAbortError } from '../../src/runtime/runtime-cancellation.ts'

async function withServer(
  handler: RequestListener,
  run: (baseUrl: URL) => Promise<void>
): Promise<void> {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('Expected the test server to listen on a TCP address.')
  }
  try {
    await run(new URL(`http://127.0.0.1:${address.port}/`))
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    })
  }
}

test('fetchSkillHttp follows redirects and retries transient responses', async () => {
  let retryRequests = 0
  let receivedHeader: string | undefined

  await withServer(
    (request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, { Location: '/download' })
        response.end()
        return
      }
      retryRequests += 1
      const header = request.headers['x-test']
      receivedHeader = Array.isArray(header) ? header[0] : header
      if (retryRequests === 1) {
        response.writeHead(503)
        response.end('retry')
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/plain' })
      response.end('skill data')
    },
    async (baseUrl) => {
      const response = await fetchSkillHttp(new URL('start', baseUrl), {
        headers: { 'X-Test': 'present' },
        retryDelays: [0],
        timeoutMs: 1000,
        maxRedirects: 2,
      })

      assert.equal(await response.text(), 'skill data')
    }
  )

  assert.equal(retryRequests, 2)
  assert.equal(receivedHeader, 'present')
})

test('fetchSkillHttp rejects unsafe and excessive redirects', async () => {
  await withServer(
    (request, response) => {
      response.writeHead(302, {
        Location: request.url === '/unsafe' ? 'file:///tmp/skill.zip' : '/loop',
      })
      response.end()
    },
    async (baseUrl) => {
      await assert.rejects(
        fetchSkillHttp(new URL('unsafe', baseUrl), {
          retryDelays: [],
          maxRedirects: 1,
        }),
        /redirected to unsupported protocol: file:/
      )
      await assert.rejects(
        fetchSkillHttp(new URL('loop', baseUrl), {
          retryDelays: [],
          maxRedirects: 1,
        }),
        /exceeded 1 redirects/
      )
    }
  )
})

test('fetchSkillHttp reports request timeouts without leaking URL secrets', async () => {
  await withServer(
    (_request, response) => {
      setTimeout(() => {
        response.writeHead(200)
        response.end('late')
      }, 50)
    },
    async (baseUrl) => {
      const source = new URL('slow?token=secret#fragment', baseUrl)

      await assert.rejects(
        fetchSkillHttp(source, {
          retryDelays: [],
          timeoutMs: 10,
        }),
        (error: Error) => {
          assert.match(error.message, /timed out after 10 ms/)
          assert.doesNotMatch(error.message, /secret|fragment/)
          return true
        }
      )
    }
  )
})

test('fetchSkillHttp honors pre-abort and redacts failed credential URLs', async () => {
  const controller = new AbortController()
  const cancellation = new PortalAbortError('installation cancelled')
  controller.abort(cancellation)

  await assert.rejects(
    fetchSkillHttp(new URL('https://example.com/skill.zip'), {
      signal: controller.signal,
    }),
    (error) => error === cancellation
  )

  const source = new URL(
    'http://user:password@127.0.0.1/skill.zip?token=secret#fragment'
  )
  await assert.rejects(
    fetchSkillHttp(source, { retryDelays: [0] }),
    (error: Error) => {
      assert.match(error.message, /failed after 2 attempts/)
      assert.match(error.message, /http:\/\/127\.0\.0\.1\/skill\.zip/)
      assert.doesNotMatch(error.message, /user|password|token|secret|fragment/)
      return true
    }
  )
})

test('writeSkillHttpResponse enforces limits and removes partial files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-http-'))
  const declaredPath = path.join(root, 'declared.zip')
  const streamedPath = path.join(root, 'streamed.zip')
  const abortedPath = path.join(root, 'aborted.zip')
  const failedPath = path.join(root, 'failed.zip')
  const successPath = path.join(root, 'success.zip')

  try {
    await assert.rejects(
      writeSkillHttpResponse(
        new Response('1234', { headers: { 'Content-Length': '4' } }),
        declaredPath,
        { maxBytes: 3 }
      ),
      /exceeds 3 bytes/
    )
    await assert.rejects(access(declaredPath), { code: 'ENOENT' })

    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('12'))
        controller.enqueue(Buffer.from('34'))
        controller.close()
      },
    })
    await assert.rejects(
      writeSkillHttpResponse(new Response(oversizedStream), streamedPath, {
        maxBytes: 3,
        limitMessage: 'custom limit',
      }),
      /custom limit/
    )
    await assert.rejects(access(streamedPath), { code: 'ENOENT' })

    await assert.rejects(
      writeSkillHttpResponse(new Response(null), failedPath, { maxBytes: 3 }),
      /empty response body/
    )
    await assert.rejects(access(failedPath), { code: 'ENOENT' })

    const controller = new AbortController()
    const cancellation = new PortalAbortError('installation cancelled')
    controller.abort(cancellation)
    await assert.rejects(
      writeSkillHttpResponse(new Response('ok'), abortedPath, {
        signal: controller.signal,
        maxBytes: 3,
      }),
      (error) => error === cancellation
    )
    await assert.rejects(access(abortedPath), { code: 'ENOENT' })

    let pulls = 0
    const failingStream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        pulls += 1
        if (pulls === 1) {
          streamController.enqueue(Buffer.from('a'))
          return
        }
        streamController.error(new Error('stream failed'))
      },
    })
    await assert.rejects(
      writeSkillHttpResponse(new Response(failingStream), failedPath, {
        maxBytes: 3,
      }),
      /Skill download failed while reading the response: stream failed/
    )
    await assert.rejects(access(failedPath), { code: 'ENOENT' })

    const bytes = await writeSkillHttpResponse(
      new Response('ok'),
      successPath,
      { maxBytes: 3 }
    )
    assert.equal(bytes, 2)
    assert.equal(await readFile(successPath, 'utf8'), 'ok')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
