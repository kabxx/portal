import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { AttachmentFileService } from '../../src/attachments/attachment-service.ts'

test('AttachmentFileService retains shared bytes until every reference is released', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'portal-attachments-'))
  const filePath = path.join(directory, 'same.png')
  await writeFile(filePath, Buffer.from([1, 2, 3]))
  try {
    const service = new AttachmentFileService()
    const first = await service.createRef(filePath)
    const second = await service.createRef(filePath)

    service.release(first)
    assert.deepEqual(await service.read(second), new Uint8Array([1, 2, 3]))

    service.release(second)
    await assert.rejects(service.read(second), /Attachment is not available/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
