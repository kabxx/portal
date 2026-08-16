import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { z } from 'zod'

import { AttachmentFileService } from '../../src/attachments/attachment-service.ts'
import type { ExtensionRegistrationApi } from '../../src/extensions/extension-contracts.ts'
import { ExtensionRegistry } from '../../src/extensions/extension-registry.ts'
import { ResourceScope } from '../../src/shared/resource-scope.ts'
import { createAttachImagePlugin } from '../../src/tools/builtins/attach-image-plugin.ts'
import {
  defineToolHost,
  ToolHost,
  toolContributions,
  toolHandlerBindings,
} from '../../src/tools/tool-host.ts'

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
      capabilities: [],
    },
    { register }
  )
  const root = new ResourceScope('tool-test-root')
  return {
    host: new ToolHost({ graph: registry.freeze(), parent: root }),
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
    'tool-1'
  )
  assert.equal(result.status, 'success')
  const attachment = z
    .object({ path: z.string(), mediaType: z.string() })
    .parse(result.output.attachment)
  assert.equal(attachment.mediaType, 'image/png')
  assert.equal(attachment.path, path.resolve(imagePath))
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
  const result = await execution
  assert.equal(result.status, 'unknown')
})
