export interface AttachmentRef {
  readonly id: string
  readonly mediaType: string
  readonly sizeBytes: number
  readonly sha256: string
}

export interface AttachmentReader {
  read(ref: AttachmentRef): Promise<Uint8Array>
}
