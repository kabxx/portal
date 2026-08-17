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
  readonly #maxTotalBytes: number
  readonly #contents = new Map<
    string,
    { readonly bytes: Uint8Array; references: number }
  >()
  #totalBytes = 0

  public constructor(
    options: {
      readonly maxBytes?: number
      readonly maxTotalBytes?: number
    } = {}
  ) {
    this.#maxBytes = options.maxBytes ?? 20 * 1024 * 1024
    this.#maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes <= 0) {
      throw new RangeError('Attachment size limit must be a positive integer.')
    }
    if (
      !Number.isSafeInteger(this.#maxTotalBytes) ||
      this.#maxTotalBytes < this.#maxBytes
    ) {
      throw new RangeError(
        'Attachment total size limit must be an integer no smaller than the per-file limit.'
      )
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
    const existing = this.#contents.get(result.id)
    if (existing !== undefined) {
      existing.references += 1
    } else {
      if (this.#totalBytes + bytes.byteLength > this.#maxTotalBytes) {
        throw new AttachmentServiceError(
          `Attachments exceed the ${this.#maxTotalBytes} byte total size limit.`
        )
      }
      this.#contents.set(result.id, {
        bytes: new Uint8Array(bytes),
        references: 1,
      })
      this.#totalBytes += bytes.byteLength
    }
    freezeImmutableData(result)
    return result
  }

  public async read(ref: AttachmentRef): Promise<Uint8Array> {
    const entry = this.#contents.get(ref.id)
    if (
      entry === undefined ||
      ref.sha256 !== ref.id.slice('attachment:'.length)
    ) {
      throw new AttachmentServiceError(
        `Attachment is not available: ${ref.id}.`
      )
    }
    return new Uint8Array(entry.bytes)
  }

  public release(ref: AttachmentRef): void {
    const entry = this.#contents.get(ref.id)
    if (entry === undefined) return
    entry.references -= 1
    if (entry.references > 0) return
    this.#contents.delete(ref.id)
    this.#totalBytes -= entry.bytes.byteLength
  }

  public clear(): void {
    this.#contents.clear()
    this.#totalBytes = 0
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
