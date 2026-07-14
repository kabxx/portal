export interface SkillPolicy {
  downloadTimeoutMs: number
  maxDownloadBytes: number
  maxExtractedBytes: number
  maxFiles: number
  maxResourceFiles: number
  maxManifestBytes: number
  maxRedirects: number
}

export const DEFAULT_SKILL_POLICY: SkillPolicy = {
  downloadTimeoutMs: 60_000,
  maxDownloadBytes: 100 * 1024 * 1024,
  maxExtractedBytes: 500 * 1024 * 1024,
  maxFiles: 5000,
  maxResourceFiles: 2000,
  maxManifestBytes: 512 * 1024,
  maxRedirects: 5,
}
