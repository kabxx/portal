import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  downloadSkillFromHub,
  parseSkillRegistryUrl,
} from '../../src/skills/skill-hub-download.ts'

async function withServer(
  handler: RequestListener,
  run: (baseUrl: URL) => Promise<void>
): Promise<void> {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  try {
    await run(new URL(`http://127.0.0.1:${address.port}/registry/`))
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    })
  }
}

function writeJson(response: Parameters<RequestListener>[1], value: unknown) {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

test('parseSkillRegistryUrl accepts HTTP registries and strips URL state', () => {
  assert.equal(
    parseSkillRegistryUrl(
      'https://registry.example/skills?token=secret#fragment'
    ).href,
    'https://registry.example/skills'
  )
  assert.throws(
    () => parseSkillRegistryUrl('not a URL'),
    /Invalid skill registry URL/
  )
  assert.throws(
    () => parseSkillRegistryUrl('file:///tmp/registry'),
    /Unsupported skill registry protocol/
  )
})

test('downloadSkillFromHub validates the requested slug before fetching', async () => {
  await assert.rejects(
    downloadSkillFromHub(
      'Invalid Name',
      new URL('https://registry.example/'),
      'unused',
      {}
    ),
    /Invalid skill name/
  )
})

test('downloadSkillFromHub rejects metadata for another skill', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-hub-'))
  try {
    await withServer(
      (request, response) => {
        if (request.url === '/registry/.well-known/clawhub.json') {
          writeJson(response, { apiBase: '/api/' })
          return
        }
        writeJson(response, {
          skill: { slug: 'another-skill' },
          latestVersion: { version: '1.0.0' },
        })
      },
      async (registryUrl) => {
        await assert.rejects(
          downloadSkillFromHub('example-skill', registryUrl, root, {}),
          /metadata does not match requested skill/
        )
      }
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('downloadSkillFromHub rejects metadata returned as the archive', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-hub-'))
  try {
    await withServer(
      (request, response) => {
        if (request.url === '/registry/.well-known/clawhub.json') {
          writeJson(response, { apiBase: '/api/' })
          return
        }
        if (request.url?.startsWith('/api/skills/example-skill')) {
          writeJson(response, {
            skill: { slug: 'example-skill' },
            latestVersion: { version: '1.0.0' },
          })
          return
        }
        writeJson(response, { error: 'not an archive' })
      },
      async (registryUrl) => {
        await assert.rejects(
          downloadSkillFromHub('example-skill', registryUrl, root, {}),
          /returned metadata instead of a skill archive/
        )
      }
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
