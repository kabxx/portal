import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { z } from 'zod'

import { AttachmentFileService } from '../../src/attachments/attachment-service.ts'
import type {
  ExtensionRegistrationApi,
  ServiceAccessor,
} from '../../src/extensions/extension-contracts.ts'
import { ExtensionRegistry } from '../../src/extensions/extension-registry.ts'
import { ServiceContainer } from '../../src/extensions/service-container.ts'
import { ExtensionResourceScope } from '../../src/extensions/scope-registration.ts'
import { ResourceScope } from '../../src/shared/resource-scope.ts'
import { createAttachImagePlugin } from '../../src/tools/builtins/attach-image-plugin.ts'
import {
  defineToolHost,
  ToolHost,
  toolContributions,
  toolHandlerBindings,
} from '../../src/tools/tool-host.ts'
import { PROVIDER_ATTACHMENT_CAPABILITY } from '../../src/providers/provider-exchange.ts'
import { RunCommandJobManager } from '../../src/processes/run-command-job-manager.ts'
import { executeRunCommand } from '../../src/tools/builtins/run-command-plugin.ts'
import { createApplyPatchPlugin } from '../../src/tools/builtins/apply-patch-plugin.ts'
import { createSpawnPlugin } from '../../src/tools/builtins/spawn-plugin.ts'
import { childConversationService } from '../../src/threads/child-conversation-service.ts'

function createHost(register: (api: ExtensionRegistrationApi) => void): {
  readonly host: ToolHost
  readonly root: ResourceScope
} {
  const registry = new ExtensionRegistry({
    generation: 'tool-test',
    policies: [],
  })
  defineToolHost(registry)
  registry.register(
    {
      id: 'test.tool-package',
      version: '1.0.0',
      dependencies: [],
      capabilities: ['portal.provider.attachments'],
    },
    { register }
  )
  const graph = registry.freeze()
  const root = new ResourceScope('tool-test-root')
  const portalScope = new ExtensionResourceScope('portal', 'tool-test', root)
  return {
    host: new ToolHost({
      graph,
      parent: portalScope,
      services: new ServiceContainer(graph.servicePlan),
    }),
    root,
  }
}

test('attach_image is a Tool package that returns an AttachmentRef without a Provider', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'portal-attach-image-'))
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const imagePath = path.join(root, 'image.png')
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const attachmentService = new AttachmentFileService()
  const plugin = createAttachImagePlugin(attachmentService)
  const { host, root: scope } = createHost((api) => plugin.module.register(api))
  t.after(async () => await scope.dispose())

  const result = await host.execute(
    'attach_image',
    { path: imagePath },
    'tool-1',
    { availableCapabilities: [PROVIDER_ATTACHMENT_CAPABILITY] }
  )
  assert.equal(result.status, 'success')
  const attachment = z
    .object({
      id: z.string(),
      mediaType: z.string(),
      sizeBytes: z.number(),
      sha256: z.string(),
    })
    .parse(result.output.attachment)
  assert.equal(attachment.mediaType, 'image/png')
  assert.match(attachment.id, /^attachment:[a-f0-9]{64}$/)

  await assert.rejects(
    host.execute(
      'attach_image',
      { path: imagePath },
      'tool-without-capability'
    ),
    /requires unavailable capabilities/
  )

  await scope.dispose()
  await assert.rejects(
    attachmentService.read(attachment),
    /Attachment is not available/
  )
})

test('apply_patch executes through its graph contribution and binding', async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'portal-apply-plugin-')
  )
  t.after(async () => await rm(directory, { recursive: true, force: true }))
  const target = path.join(directory, 'created.txt')
  const plugin = createApplyPatchPlugin()
  const { host, root } = createHost((api) => plugin.module.register(api))
  t.after(async () => await root.dispose())

  const result = await host.execute(
    'apply_patch',
    [
      '*** Begin Patch',
      `*** Add File: ${target}`,
      '+created through graph',
      '*** End Patch',
    ].join('\n'),
    'apply-patch-graph'
  )

  assert.equal(result.status, 'success')
  assert.equal(await readFile(target, 'utf8'), 'created through graph')
})

test('spawn uses only the typed child-conversation service granted by its contribution', async (t) => {
  let calls = 0
  const plugin = createSpawnPlugin()
  const { host, root } = createHost((api) => {
    api.provide(childConversationService, {
      dependencies: Object.freeze([]),
      create: async () => ({
        run: async (request, parent, signal) => {
          calls += 1
          assert.equal(request.prompt, 'child task')
          assert.equal(request.providerId, 'gemini')
          assert.equal(parent.providerId, 'chatgpt')
          assert.equal(signal.aborted, false)
          return {
            provider: 'gemini',
            conversationUrl: 'https://example.com/child',
            output: 'child result',
          }
        },
      }),
    })
    plugin.module.register(api)
  })
  t.after(async () => await root.dispose())

  const result = await host.execute(
    'spawn',
    { prompt: 'child task', provider: 'gemini' },
    'spawn-graph',
    {
      invocation: {
        providerId: 'chatgpt',
        model: null,
        spawnDepth: 0,
        workingDirectory: process.cwd(),
      },
    }
  )

  assert.equal(calls, 1)
  assert.equal(result.status, 'success')
  assert.deepEqual(result.output, {
    provider: 'gemini',
    conversationUrl: 'https://example.com/child',
    output: 'child result',
  })
})

test('ToolHost revokes a Tool scope on cancellation before the handler settles', async (t) => {
  const { host, root } = createHost((api) => {
    api.contribute(toolContributions, {
      id: 'test.wait-tool',
      value: {
        id: 'test.wait-tool',
        descriptor: {
          name: 'wait_tool',
          description: 'Waits for cancellation.',
          inputSchema: {},
        },
        requiredCapabilities: [],
        handlerBindingId: 'test.wait-tool.handler',
      },
      requiredServices: [],
      requiredCapabilities: [],
    })
    api.bind(toolHandlerBindings, {
      id: 'test.wait-tool.handler',
      targetId: 'test.wait-tool',
      binding: async (_input, context) => {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), {
            once: true,
          })
        })
        return { status: 'unknown', output: {} }
      },
    })
  })
  t.after(async () => await root.dispose())
  const controller = new AbortController()
  const execution = host.execute('wait_tool', {}, 'tool-cancel', {
    signal: controller.signal,
  })
  controller.abort(new Error('user canceled'))
  await assert.rejects(execution, /user canceled/)
})

test('ToolHost bounds cancellation when a handler ignores its signal', async (t) => {
  let rejectHandler!: (error: Error) => void
  const { host, root } = createHost((api) => {
    api.contribute(toolContributions, {
      id: 'test.ignore-cancel-tool',
      value: {
        id: 'test.ignore-cancel-tool',
        descriptor: {
          name: 'ignore_cancel_tool',
          description: 'Ignores cancellation.',
          inputSchema: {},
        },
        requiredCapabilities: [],
        handlerBindingId: 'test.ignore-cancel-tool.handler',
      },
      requiredServices: [],
      requiredCapabilities: [],
    })
    api.bind(toolHandlerBindings, {
      id: 'test.ignore-cancel-tool.handler',
      targetId: 'test.ignore-cancel-tool',
      binding: async () =>
        await new Promise<never>((_resolve, reject) => {
          rejectHandler = reject
        }),
    })
  })
  t.after(async () => await root.dispose())

  const controller = new AbortController()
  const execution = host.execute('ignore_cancel_tool', {}, 'tool-ignore', {
    signal: controller.signal,
  })
  controller.abort(new Error('user canceled'))
  await assert.rejects(execution, /user canceled/)

  rejectHandler(new Error('late handler failure'))
  await new Promise<void>((resolve) => setImmediate(resolve))
})

test('run_command plugin stops its child process when the Tool scope is canceled', async (t) => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), 'portal-run-command-plugin-')
  )
  t.after(async () => await rm(tempDir, { recursive: true, force: true }))
  const ready = path.join(tempDir, 'ready.txt')
  const finished = path.join(tempDir, 'finished.txt')
  const manager = new RunCommandJobManager()
  const scope = new ResourceScope('run-command-plugin-test')
  t.after(async () => await scope.dispose())
  const command =
    process.platform === 'win32'
      ? `Set-Content -Path '${ready.replaceAll("'", "''")}' -Value ready; Start-Sleep -Seconds 30; Set-Content -Path '${finished.replaceAll("'", "''")}' -Value finished`
      : `${process.execPath} -e "require('fs').writeFileSync('${ready.replaceAll("'", "\\'")}','ready');setTimeout(()=>require('fs').writeFileSync('${finished.replaceAll("'", "\\'")}','finished'),30000)"`
  const controller = new AbortController()
  const execution = executeRunCommand(
    manager,
    { command, shell: process.platform === 'win32' ? 'powershell' : 'sh' },
    {
      requestId: 'run-command-cancel',
      signal: controller.signal,
      scope,
      capabilities: [],
      services: unavailableServices,
      invocation: null,
    }
  )
  await waitForPath(ready)
  controller.abort(new Error('cancel run_command'))
  await assert.rejects(execution, /cancel run_command|canceled/)
  await waitUntil(() => manager.list().length === 0)
  assert.equal(existsSync(finished), false)
})

async function waitForPath(filePath: string): Promise<void> {
  await waitUntil(() => existsSync(filePath))
}

const unavailableServices: ServiceAccessor = Object.freeze({
  get: async () => {
    throw new Error('No services are available in this test.')
  },
})

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for test state.')
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
}
