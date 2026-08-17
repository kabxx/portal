import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { PortalHost } from '../../src/host/portal-host.ts'
import { PluginManager } from '../../src/extensions/plugin-manager.ts'
import { JsonPluginStore } from '../../src/extensions/plugin-store.ts'
import { firstPartyPluginRecords } from '../../src/bootstrap/first-party-plugins.ts'
import { portalCommandCompletionSnapshot } from '../../src/host/portal-command-services.ts'

async function createPlugin(root: string): Promise<string> {
  const directory = path.join(root, 'installed-plugin')
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, 'portal.plugin.json'),
    `${JSON.stringify(
      {
        id: 'test.portal-plugin',
        version: '1.0.0',
        apiVersion: 1,
        entry: 'index.mjs',
        dependencies: [],
        contributions: [],
        capabilities: [],
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  await writeFile(
    path.join(directory, 'index.mjs'),
    `export const portalPlugin = {
  descriptor: {
    id: 'test.portal-plugin',
    version: '1.0.0',
    dependencies: [],
    capabilities: []
  },
  extension: { register() {} }
};
`,
    'utf8'
  )
  return directory
}

test('PortalHost consumes installed direct-load packages through the unified catalog', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-host-plugin-'))
  let host: PortalHost | null = null
  t.after(async () => {
    await host?.close()
    await rm(root, { recursive: true, force: true })
  })
  const pluginDirectory = await createPlugin(root)
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins', 'installed.json')),
  })
  await manager.addLocalDirectory(pluginDirectory)

  const preparedHost = await PortalHost.prepare({
    entrySurfaceId: 'portal.exec',
    cwd: root,
    dataDirectory: root,
  })
  host = preparedHost
  const packageIds = preparedHost.prepared.pluginPlan.extensions.map(
    (extension) => extension.packageId
  )
  assert.equal(packageIds[0], 'test.portal-plugin')
  const firstPartyPackageIds = [
    'portal.commands',
    'portal.skills',
    'portal.prompt.agent',
    'portal.prompt.chat',
    'portal.agent.default',
    'portal.agent.chat',
    'portal.command.skills',
    'portal.tool.attach-image',
    'portal.tool.run-command',
    'portal.tool.apply-patch',
    'portal.tool.spawn',
    'portal.plugins',
    'portal.surface.tui',
    'portal.surface.exec',
    'portal.surface.mcp',
    'portal.provider.chatgpt',
    'portal.provider.gemini',
    'portal.provider.deepseek',
    'portal.provider.doubao',
    'portal.provider.grok',
    'portal.provider.glm',
    'portal.provider.qwen',
    'portal.provider.kimi',
  ]
  assert.deepEqual(packageIds.slice(1), firstPartyPackageIds)
  assert.equal(
    preparedHost.prepared.pluginPlan.snapshot.packages.length,
    firstPartyPackageIds.length + 1
  )
  assert.equal(
    preparedHost.prepared.providerHost.resolveProviderId('gpt'),
    null
  )
})

test('persisted Provider disable removes graph discovery and Surface completion projection', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-provider-disable-'))
  let host: PortalHost | null = null
  t.after(async () => {
    await host?.close()
    await rm(root, { recursive: true, force: true })
  })
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins', 'installed.json')),
  })
  await manager.synchronizeBuiltIns(firstPartyPluginRecords())
  await manager.disable('portal.provider.chatgpt')

  host = await PortalHost.prepare({
    entrySurfaceId: 'portal.exec',
    cwd: root,
    dataDirectory: root,
  })
  assert.equal(host.prepared.providerHost.resolveProviderId('chatgpt'), null)
  assert.equal(host.prepared.providerHost.resolveProviderId('gemini'), 'gemini')
  const providerCandidates = portalCommandCompletionSnapshot(
    host.prepared.providerHost
  ).entries.find(({ sourceId }) => sourceId === 'portal.command.providers')
  assert.equal(
    providerCandidates?.candidates.some(({ value }) => value === 'chatgpt'),
    false
  )
})

test('disabling the MCP Surface removes its command and listener from the graph', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-mcp-disable-'))
  let host: PortalHost | null = null
  t.after(async () => {
    await host?.close()
    await rm(root, { recursive: true, force: true })
  })
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins', 'installed.json')),
  })
  await manager.synchronizeBuiltIns(firstPartyPluginRecords())
  await manager.disable('portal.surface.mcp')

  host = await PortalHost.prepare({
    entrySurfaceId: 'portal.exec',
    cwd: root,
    dataDirectory: root,
  })
  assert.equal(
    host.commandCatalog().some(({ primaryName }) => primaryName === '/mcp'),
    false
  )
  assert.equal(
    host.surfaceCatalog().some(({ id }) => id === 'portal.mcp'),
    false
  )
})

test('disabling Skill command contribution keeps Prompt skills and Providers active', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-skill-command-disable-')
  )
  let host: PortalHost | null = null
  t.after(async () => {
    await host?.close()
    await rm(root, { recursive: true, force: true })
  })
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins', 'installed.json')),
  })
  await manager.synchronizeBuiltIns(firstPartyPluginRecords())
  await manager.setContributionEnabled(
    'portal.command.skills',
    'commands.collect',
    'commands.skill',
    false
  )

  host = await PortalHost.prepare({
    entrySurfaceId: 'portal.exec',
    cwd: root,
    dataDirectory: root,
  })
  assert.equal(
    host.commandCatalog().some(({ primaryName }) => primaryName === '/skill'),
    false
  )
  assert.equal(
    host.prepared.providerHost.resolveProviderId('chatgpt'),
    'chatgpt'
  )
  assert.equal(
    host.prepared.pluginPlan.extensions.some(
      ({ packageId }) => packageId === 'portal.skills'
    ),
    true
  )
})

test('disabling Command package does not disable Prompt skills or Providers', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-command-disable-'))
  let host: PortalHost | null = null
  t.after(async () => {
    await host?.close()
    await rm(root, { recursive: true, force: true })
  })
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins', 'installed.json')),
  })
  await manager.synchronizeBuiltIns(firstPartyPluginRecords())
  await manager.disable('portal.commands')

  host = await PortalHost.prepare({
    entrySurfaceId: 'portal.exec',
    cwd: root,
    dataDirectory: root,
  })
  assert.equal(host.commandCatalog().length, 0)
  assert.equal(
    host.prepared.providerHost.resolveProviderId('chatgpt'),
    'chatgpt'
  )
  const packageIds = host.prepared.pluginPlan.extensions.map(
    ({ packageId }) => packageId
  )
  assert.equal(packageIds.includes('portal.skills'), true)
  assert.equal(packageIds.includes('portal.command.skills'), false)
})

test('disabling an Agent Prompt package removes its dependent Agent but not Providers', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-prompt-disable-'))
  let host: PortalHost | null = null
  t.after(async () => {
    await host?.close()
    await rm(root, { recursive: true, force: true })
  })
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins', 'installed.json')),
  })
  await manager.synchronizeBuiltIns(firstPartyPluginRecords())
  await manager.disable('portal.prompt.agent')

  host = await PortalHost.prepare({
    entrySurfaceId: 'portal.tui',
    cwd: root,
    dataDirectory: root,
  })
  const packages = host.prepared.pluginPlan.extensions.map(
    ({ packageId }) => packageId
  )
  assert.equal(packages.includes('portal.prompt.agent'), false)
  assert.equal(packages.includes('portal.agent.default'), false)
  assert.equal(packages.includes('portal.agent.chat'), true)
  assert.equal(packages.includes('portal.surface.exec'), false)
  assert.equal(packages.includes('portal.tool.spawn'), false)
  assert.equal(
    host.agentCatalog().some(({ id }) => id === 'portal.agent.default'),
    false
  )
  assert.equal(
    host.prepared.providerHost.resolveProviderId('chatgpt'),
    'chatgpt'
  )
})

test('disabling a Prompt contribution removes the referencing Agent from the effective catalog', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-prompt-contribution-disable-')
  )
  let host: PortalHost | null = null
  t.after(async () => {
    await host?.close()
    await rm(root, { recursive: true, force: true })
  })
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins', 'installed.json')),
  })
  await manager.synchronizeBuiltIns(firstPartyPluginRecords())
  await manager.setContributionEnabled(
    'portal.prompt.agent',
    'prompts.collect',
    'portal.prompt.agent',
    false
  )

  host = await PortalHost.prepare({
    entrySurfaceId: 'portal.tui',
    cwd: root,
    dataDirectory: root,
  })
  assert.equal(
    host.promptCatalog().some(({ id }) => id === 'portal.prompt.agent'),
    false
  )
  assert.equal(
    host.agentCatalog().some(({ id }) => id === 'portal.agent.default'),
    false
  )
  assert.equal(
    host.agentCatalog().some(({ id }) => id === 'portal.agent.chat'),
    true
  )
  assert.equal(
    host.surfaceCatalog().some(({ id }) => id === 'portal.exec'),
    false
  )
  assert.equal(
    host.prepared.toolHost.list().some(({ id }) => id === 'portal.tool.spawn'),
    false
  )
})

test('disabling the default Agent contribution removes its dependent capabilities and command route', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'portal-agent-contribution-disable-')
  )
  let host: PortalHost | null = null
  t.after(async () => {
    await host?.close()
    await rm(root, { recursive: true, force: true })
  })
  const manager = new PluginManager({
    store: new JsonPluginStore(path.join(root, 'plugins', 'installed.json')),
  })
  await manager.synchronizeBuiltIns(firstPartyPluginRecords())
  await manager.setContributionEnabled(
    'portal.agent.default',
    'agents.collect',
    'portal.agent.default',
    false
  )

  await assert.rejects(
    PortalHost.prepare({
      entrySurfaceId: 'portal.exec',
      cwd: root,
      dataDirectory: root,
    }),
    /Unknown or disabled entry Surface: portal\.exec/
  )

  host = await PortalHost.prepare({
    entrySurfaceId: 'portal.tui',
    cwd: root,
    dataDirectory: root,
  })
  assert.deepEqual(
    host.agentCatalog().map(({ descriptor }) => descriptor.mode),
    ['chat']
  )
  assert.equal(
    host.surfaceCatalog().some(({ id }) => id === 'portal.exec'),
    false
  )
  assert.equal(
    host.prepared.toolHost.list().some(({ id }) => id === 'portal.tool.spawn'),
    false
  )
  const threadRoutes = host
    .commandCatalog()
    .find(({ id }) => id === 'commands.thread')?.routes
  assert.equal(
    threadRoutes?.some(({ id }) => id === 'agent'),
    false
  )
  assert.equal(
    threadRoutes?.some(({ id }) => id === 'chat'),
    true
  )
  const session = host.openCommandSession('agent-mode-projection')
  t.after(async () => await session.close())
  assert.equal(session.prepare('/thread agent chatgpt').kind, 'invalid')
  assert.equal(session.prepare('/thread chat chatgpt').kind, 'ready')
})
