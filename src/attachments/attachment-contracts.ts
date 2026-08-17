import { createServiceRef } from '../extensions/extension-contracts.ts'

export interface AttachmentRef {
  readonly id: string
  readonly mediaType: string
  readonly sizeBytes: number
  readonly sha256: string
}

export interface AttachmentReader {
  read(ref: AttachmentRef): Promise<Uint8Array>
  release?(ref: AttachmentRef): void | Promise<void>
}

export interface AttachmentStore extends AttachmentReader {
  createRef(filePath: string): Promise<AttachmentRef>
}

export const attachmentStoreService = createServiceRef<AttachmentStore>({
  id: 'portal.attachments.store',
  version: 1,
  scope: 'portal',
})
