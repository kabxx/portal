import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'child_process'
import { createReadStream } from 'fs'
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { createServer } from 'http'
import os from 'os'
import path from 'path'
import { parse as parseYaml } from 'yaml'
import { promisify } from 'util'
import { path7za } from '7zip-bin'

import { SkillLibrary } from '../../src/skills/skill-library.ts'
import { isSupportedArchive } from '../../src/skills/skill-archive.ts'
import { resolveDownloadTarget } from '../../src/skills/skill-download.ts'
import { resolveGitHubDirectoryTarget } from '../../src/skills/skill-github-download.ts'
import { createTestSkill } from '../helpers/skills.ts'

const execFileAsync = promisify(execFile)

test('isSupportedArchive recognizes RAR 4 and RAR 5 signatures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-rar-signature-'))
  const archivePath = path.join(root, 'download.bin')
  try {
    for (const signature of [
      [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00],
      [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00],
    ]) {
      await writeFile(archivePath, Buffer.from(signature))
      assert.equal(await isSupportedArchive(archivePath), true)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveDownloadTarget supports GitHub repository, tree, and blob URLs', () => {
  const repository = resolveDownloadTarget(
    new URL('https://github.com/example/skills')
  )
  assert.equal(
    repository.url.href,
    'https://github.com/example/skills/archive/HEAD.zip'
  )
  assert.equal(repository.archiveSubdirectory, null)

  const tree = resolveDownloadTarget(
    new URL('https://github.com/example/skills/tree/main/skills/pdf-processing')
  )
  assert.equal(
    tree.url.href,
    'https://github.com/example/skills/archive/main.zip'
  )
  assert.equal(tree.archiveSubdirectory, 'skills/pdf-processing')
  assert.deepEqual(
    resolveGitHubDirectoryTarget(
      new URL(
        'https://github.com/example/skills/tree/main/skills/pdf-processing'
      )
    ),
    {
      owner: 'example',
      repository: 'skills',
      reference: 'main',
      directory: 'skills/pdf-processing',
    }
  )

  const blob = resolveDownloadTarget(
    new URL('https://github.com/example/skills/blob/main/SKILL.md')
  )
  assert.equal(
    blob.url.href,
    'https://raw.githubusercontent.com/example/skills/main/SKILL.md'
  )
  assert.equal(blob.expectSkillFile, true)
})

test('SkillLibrary downloads only the requested GitHub tree directory and retries transient fetch failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-github-'))
  const manifest = [
    '---',
    'name: github-tree-skill',
    'description: Installed from one GitHub directory.',
    '---',
    '# GitHub tree skill',
  ].join('\n')
  const guide = '# Guide\n'
  const requestedUrls: string[] = []
  let firstDirectoryAttempts = 0
  let guideRawAttempts = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    requestedUrls.push(url.href)

    if (
      url.hostname === 'api.github.com' &&
      url.pathname.endsWith('/contents/skills/github-tree-skill')
    ) {
      firstDirectoryAttempts += 1
      if (firstDirectoryAttempts === 1) {
        throw new TypeError('fetch failed')
      }
      return Response.json([
        {
          name: 'SKILL.md',
          type: 'file',
          size: Buffer.byteLength(manifest),
          url: 'https://api.github.com/repos/example/skills/contents/skills/github-tree-skill/SKILL.md?ref=main',
          download_url:
            'https://raw.githubusercontent.com/example/skills/main/skills/github-tree-skill/SKILL.md',
        },
        {
          name: 'references',
          type: 'dir',
          size: 0,
          url: 'https://api.github.com/repos/example/skills/contents/skills/github-tree-skill/references?ref=main',
          download_url: null,
        },
      ])
    }
    if (
      url.hostname === 'api.github.com' &&
      url.pathname.endsWith('/contents/skills/github-tree-skill/references')
    ) {
      return Response.json([
        {
          name: 'guide.md',
          type: 'file',
          size: Buffer.byteLength(guide),
          url: 'https://api.github.com/repos/example/skills/contents/skills/github-tree-skill/references/guide.md?ref=main',
          download_url:
            'https://raw.githubusercontent.com/example/skills/main/skills/github-tree-skill/references/guide.md',
        },
      ])
    }
    if (
      url.hostname === 'api.github.com' &&
      url.pathname.endsWith(
        '/contents/skills/github-tree-skill/references/guide.md'
      )
    ) {
      return new Response(guide, { status: 200 })
    }
    if (url.pathname.endsWith('/SKILL.md')) {
      return new Response(manifest, { status: 200 })
    }
    if (
      url.hostname === 'raw.githubusercontent.com' &&
      url.pathname.endsWith('/references/guide.md')
    ) {
      guideRawAttempts += 1
      throw new TypeError('fetch failed')
    }
    return new Response('Not found', { status: 404, statusText: 'Not Found' })
  }

  const library = new SkillLibrary({
    skillsDirectory: path.join(root, 'data', 'skills'),
    tempDirectory: path.join(root, 'data', 'temp', 'skill-install'),
    registryPath: path.join(root, 'data', 'config.yaml'),
  })
  try {
    const installed = await library.add(
      'https://github.com/example/skills/tree/main/skills/github-tree-skill'
    )
    assert.equal(installed.name, 'github-tree-skill')
    assert.equal(
      await readFile(
        path.join(installed.directory, 'references', 'guide.md'),
        'utf8'
      ),
      guide
    )
    assert.equal(firstDirectoryAttempts, 2)
    assert.equal(guideRawAttempts, 1)
    assert.equal(
      requestedUrls.some((url) => url.includes('/archive/')),
      false
    )
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})

for (const archiveType of ['zip', '7z', 'tar.gz'] as const) {
  test(`SkillLibrary installs a ${archiveType} skill from an ordinary download URL`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-download-'))
    const sourceParent = path.join(root, 'source')
    const skillName = `download-${archiveType.replace('.', '-')}`
    await createTestSkill(sourceParent, skillName, {
      resource: true,
    })
    const archivePath = path.join(root, `skill.${archiveType}`)
    if (archiveType === 'tar.gz') {
      const tarPath = path.join(root, 'skill.tar')
      await execFileAsync(path7za, ['a', '-ttar', tarPath, skillName], {
        cwd: sourceParent,
      })
      await execFileAsync(path7za, ['a', '-tgzip', archivePath, tarPath])
    } else {
      await execFileAsync(
        path7za,
        ['a', `-t${archiveType}`, archivePath, skillName],
        { cwd: sourceParent }
      )
    }

    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="skill-download.bin"',
      })
      createReadStream(archivePath).pipe(response)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')

    const library = new SkillLibrary({
      skillsDirectory: path.join(root, 'data', 'skills'),
      tempDirectory: path.join(root, 'data', 'temp', 'skill-install'),
      registryPath: path.join(root, 'data', 'config.yaml'),
    })
    try {
      const installed = await library.add(
        `http://127.0.0.1:${address.port}/ordinary-page`
      )
      assert.equal(installed.name, skillName)
      assert.match(
        await readFile(path.join(installed.directory, 'SKILL.md'), 'utf8'),
        new RegExp(`name: ${skillName}`)
      )
      assert.deepEqual(
        await readdir(path.join(root, 'data', 'temp', 'skill-install')),
        []
      )
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('SkillLibrary installs a named skill through a Hub registry protocol', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-hub-'))
  const sourceParent = path.join(root, 'source')
  const skillName = 'hub-skill'
  await createTestSkill(sourceParent, skillName, { resource: true })
  const archivePath = path.join(root, 'hub-skill.zip')
  await execFileAsync(path7za, ['a', '-tzip', archivePath, skillName], {
    cwd: sourceParent,
  })

  const requestedUrls: string[] = []
  const server = createServer((request, response) => {
    const requestUrl = new URL(
      request.url ?? '/',
      `http://${request.headers.host ?? '127.0.0.1'}`
    )
    requestedUrls.push(`${requestUrl.pathname}${requestUrl.search}`)

    if (requestUrl.pathname === '/.well-known/clawhub.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ apiBase: '/api/v1' }))
      return
    }
    if (requestUrl.pathname === `/api/v1/skills/${skillName}`) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          skill: { slug: skillName },
          latestVersion: { version: '20260404.065514' },
        })
      )
      return
    }
    if (requestUrl.pathname === '/api/v1/download') {
      response.writeHead(200, { 'Content-Type': 'application/zip' })
      createReadStream(archivePath).pipe(response)
      return
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' })
    response.end('Not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const library = new SkillLibrary({
    skillsDirectory: path.join(root, 'data', 'skills'),
    tempDirectory: path.join(root, 'data', 'temp', 'skill-install'),
    registryPath: path.join(root, 'data', 'config.yaml'),
  })
  try {
    const installed = await library.add(skillName, {
      registryUrl: `http://127.0.0.1:${address.port}`,
    })
    assert.equal(installed.name, skillName)
    assert.match(
      await readFile(path.join(installed.directory, 'SKILL.md'), 'utf8'),
      new RegExp(`name: ${skillName}`)
    )
    assert.deepEqual(requestedUrls, [
      '/.well-known/clawhub.json',
      `/api/v1/skills/${skillName}`,
      `/api/v1/download?slug=${skillName}&version=20260404.065514`,
    ])
    assert.deepEqual(
      await readdir(path.join(root, 'data', 'temp', 'skill-install')),
      []
    )
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    await rm(root, { recursive: true, force: true })
  }
})

test('SkillLibrary installs a directly downloaded SKILL.md', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-skill-markdown-'))
  const contents = [
    '---',
    'name: direct-skill',
    'description: A directly downloaded skill.',
    '---',
    '# Direct skill',
  ].join('\n')
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': 'attachment; filename="SKILL.md"',
    })
    response.end(contents)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const library = new SkillLibrary({
    skillsDirectory: path.join(root, 'data', 'skills'),
    tempDirectory: path.join(root, 'data', 'temp', 'skill-install'),
    registryPath: path.join(root, 'data', 'config.yaml'),
  })
  try {
    const installed = await library.add(
      `http://127.0.0.1:${address.port}/download`
    )
    assert.equal(installed.name, 'direct-skill')
    const registry = parseYaml(
      await readFile(path.join(root, 'data', 'config.yaml'), 'utf8')
    ).skills as Array<{ name: string; directory: string; enabled: boolean }>
    assert.deepEqual(registry, [
      {
        name: 'direct-skill',
        directory: 'skills/direct-skill',
        enabled: true,
      },
    ])
    assert.equal(await library.remove('direct-skill'), true)
    await assert.rejects(access(installed.directory))
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    await rm(root, { recursive: true, force: true })
  }
})
