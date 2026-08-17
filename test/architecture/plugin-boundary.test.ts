import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

function source(relativePath: string): string {
  return readFileSync(path.resolve('src', relativePath), 'utf8')
}

test('Runtime can execute Tools only through the resolved ToolHost graph', () => {
  const factory = source('runtime/runtime-factory.ts')
  const registry = source('tools/core/tool-registry.ts')

  assert.doesNotMatch(factory, /ToolConstructor|ToolServices|tools\/builtins/)
  assert.doesNotMatch(
    registry,
    /ToolConstructor|ToolServices|new ToolClass|this\.tools/
  )
  assert.match(factory, /toolHost/)
  assert.match(registry, /\.execute\(/)
  assert.doesNotMatch(factory, /toolHost\?\s*:/)
  assert.doesNotMatch(registry, /ToolHost\s*\|\s*null|toolHost\?\s*:/)
})

test('Kernel Provider IDs remain graph data rather than a first-party union', () => {
  assert.equal(existsSync(path.resolve('src/providers/provider-id.ts')), false)
  assert.match(
    source('providers/first-party-provider-id.ts'),
    /FIRST_PARTY_PROVIDER_IDS/
  )
  for (const relativePath of [
    'providers/provider-exchange.ts',
    'providers/provider-host.ts',
    'threads/conversation-host.ts',
    'surfaces/surface-port.ts',
  ]) {
    assert.doesNotMatch(source(relativePath), /first-party-provider-id/)
  }
})

test('Portal composition does not construct product Tool or Job implementations', () => {
  for (const relativePath of [
    'host/portal-host.ts',
    'host/portal-catalog.ts',
  ]) {
    const text = source(relativePath)
    assert.doesNotMatch(text, /tools\/builtins/)
    assert.doesNotMatch(text, /run-command-job-manager/)
    assert.doesNotMatch(text, /AttachmentFileService/)
  }
})

test('PortalHost exposes platform services while Provider plugins own endpoint construction', () => {
  const host = source('host/portal-host.ts')
  const provider = source('providers/first-party-provider-plugin.ts')

  assert.doesNotMatch(
    host,
    /FirstPartyProviderEndpointHost|createWebProviderEndpoint|ProviderAdapter|initializeRuntimeWithLoginWait/
  )
  assert.match(provider, /createWebProviderEndpointFactory/)
  assert.match(provider, /portalBrowserSessionService/)
  assert.match(provider, /toolRuntimeService/)
})

test('spawn uses the typed child-conversation service without a Tool-side runtime bridge', () => {
  assert.equal(
    existsSync(path.resolve('src/tools/spawn-tool-services.ts')),
    false
  )
  const plugin = source('tools/builtins/spawn-plugin.ts')
  assert.match(plugin, /childConversationService/)
  assert.doesNotMatch(
    plugin,
    /BrowserContext|ProviderAdapter|provider-catalog|RuntimeCore/
  )
})

test('Thread lifecycle and PortalHost do not own Provider initialization policy', () => {
  const lifecycle = source('threads/thread-lifecycle-service.ts')
  const host = source('host/portal-host.ts')
  for (const text of [lifecycle, host]) {
    assert.doesNotMatch(
      text,
      /ProviderAdapter|createAdapterForProvider|initializeRuntimeWithLoginWait|waitForLogin|provider-catalog|RuntimeCore/
    )
  }
  assert.doesNotMatch(host, /SkillLibrary|loadProjectInstructions/)
  assert.match(lifecycle, /openRuntime/)
  assert.match(host, /conversationHost\.open/)
})

test('Provider endpoint plugins own web Adapter and retry implementation', () => {
  const endpoint = source('providers/web-provider-endpoint.ts')
  assert.match(endpoint, /initializeRuntimeWithLoginWait/)
  assert.match(endpoint, /createFirstPartyWebProviderAdapter/)
  assert.match(endpoint, /submitWithRetry/)
})
