import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'

import { freezeImmutableData } from '../extensions/immutable-data.ts'
import type { AttachmentRef } from './attachment-contracts.ts'

export class AttachmentServiceError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'AttachmentServiceError'
  }
}

export class AttachmentFileService {
  readonly #maxBytes: number
  readonly #contents = new Map<string, Uint8Array>()

  public constructor(options: { readonly maxBytes?: number } = {}) {
    this.#maxBytes = options.maxBytes ?? 20 * 1024 * 1024
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes <= 0) {
      throw new RangeError('Attachment size limit must be a positive integer.')
    }
  }

  public async createRef(filePath: string): Promise<AttachmentRef> {
    if (filePath.trim() === '') {
      throw new AttachmentServiceError('Attachment path must not be empty.')
    }
    const absolutePath = path.resolve(filePath)
    const entry = await lstat(absolutePath).catch((error: unknown) => {
      throw new AttachmentServiceError(
        `Unable to inspect attachment: ${getErrorMessage(error)}`
      )
    })
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new AttachmentServiceError(
        'Attachment path must point to a regular, non-symbolic-link file.'
      )
    }
    if (entry.size > this.#maxBytes) {
      throw new AttachmentServiceError(
        `Attachment exceeds the ${this.#maxBytes} byte size limit.`
      )
    }
    const bytes = await readFile(absolutePath)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const result: AttachmentRef = {
      id: `attachment:${sha256}`,
      mediaType: mediaTypeForPath(absolutePath),
      sizeBytes: bytes.byteLength,
      sha256,
    }
    this.#contents.set(result.id, new Uint8Array(bytes))
    freezeImmutableData(result)
    return result
  }

  public async read(ref: AttachmentRef): Promise<Uint8Array> {
    const bytes = this.#contents.get(ref.id)
    if (
      bytes === undefined ||
      ref.sha256 !== ref.id.slice('attachment:'.length)
    ) {
      throw new AttachmentServiceError(
        `Attachment is not available: ${ref.id}.`
      )
    }
    return new Uint8Array(bytes)
  }
}

function mediaTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.bmp':
      return 'image/bmp'
    case '.svg':
      return 'image/svg+xml'
    default:
      return 'application/octet-stream'
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
