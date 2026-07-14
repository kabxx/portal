import path from 'path'
import type { AbortOptions } from '../runtime/runtime-cancellation.ts'
import { parseGitHubUrl } from './skill-github-download.ts'
import {
  fetchSkillHttp,
  MAX_SKILL_DOWNLOAD_BYTES,
  writeSkillHttpResponse,
} from './skill-http.ts'
import { readFilePrefix, SkillInstallError } from './skill-files.ts'

export interface DownloadTarget {
  url: URL
  archiveSubdirectory: string | null
  expectSkillFile: boolean
}

export interface DownloadedSkillFile extends DownloadTarget {
  path: string
  contentType: string
}

export function parseSkillUrl(value: string): URL | null {
  if (!/^https?:\/\//i.test(value)) return null
  try {
    return new URL(value)
  } catch {
    throw new SkillInstallError(`Invalid skill URL: ${value}`)
  }
}

export function resolveDownloadTarget(sourceUrl: URL): DownloadTarget {
  const github = parseGitHubUrl(sourceUrl)
  if (github === null) {
    return {
      url: sourceUrl,
      archiveSubdirectory: null,
      expectSkillFile: sourceUrl.pathname.toLowerCase().endsWith('/skill.md'),
    }
  }

  if (github.kind === undefined) {
    return {
      url: new URL(
        `https://github.com/${github.owner}/${github.repository}/archive/HEAD.zip`
      ),
      archiveSubdirectory: null,
      expectSkillFile: false,
    }
  }

  if (
    (github.kind === 'tree' || github.kind === 'blob') &&
    github.reference !== undefined
  ) {
    if (github.kind === 'blob') {
      if (github.relativeParts.at(-1)?.toLowerCase() !== 'skill.md') {
        throw new SkillInstallError(
          'GitHub blob URL must point to a SKILL.md file'
        )
      }
      return {
        url: new URL(
          `https://raw.githubusercontent.com/${github.owner}/${github.repository}/${encodeURIComponent(github.reference)}/${github.relativeParts.map(encodeURIComponent).join('/')}`
        ),
        archiveSubdirectory: null,
        expectSkillFile: true,
      }
    }

    return {
      url: new URL(
        `https://github.com/${github.owner}/${github.repository}/archive/${encodeURIComponent(github.reference)}.zip`
      ),
      archiveSubdirectory:
        github.relativeParts.length === 0
          ? null
          : github.relativeParts.join('/'),
      expectSkillFile: false,
    }
  }

  return { url: sourceUrl, archiveSubdirectory: null, expectSkillFile: false }
}

export async function downloadSkillFile(
  sourceUrl: URL,
  directory: string,
  options: AbortOptions
): Promise<DownloadedSkillFile> {
  const target = resolveDownloadTarget(sourceUrl)
  const response = await fetchSkillHttp(target.url, options)
  if (!response.ok) {
    throw new SkillInstallError(
      `Skill download failed with HTTP ${response.status} ${response.statusText}`
    )
  }

  const finalUrl = new URL(response.url || target.url.href)
  const fileName = getDownloadFileName(
    response.headers.get('content-disposition') ?? '',
    finalUrl
  )
  const destination = path.join(directory, fileName)
  await writeSkillHttpResponse(response, destination, {
    signal: options.signal,
    maxBytes: MAX_SKILL_DOWNLOAD_BYTES,
  })

  return {
    ...target,
    path: destination,
    contentType: response.headers.get('content-type') ?? '',
  }
}

export async function isDownloadedSkillDocument(
  downloaded: DownloadedSkillFile
): Promise<boolean> {
  if (downloaded.expectSkillFile) return true
  if (path.basename(downloaded.path).toLowerCase() === 'skill.md') return true

  const contentType = downloaded.contentType.toLowerCase()
  if (
    contentType.includes('text/markdown') ||
    contentType.includes('text/x-markdown')
  ) {
    return true
  }
  if (contentType.includes('text/html')) return false

  const prefix = await readFilePrefix(downloaded.path, 4)
  return prefix
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .startsWith('---')
}

function getDownloadFileName(
  contentDisposition: string,
  finalUrl: URL
): string {
  const encodedName = contentDisposition.match(
    /filename\*=UTF-8''([^;]+)/i
  )?.[1]
  const plainName = contentDisposition.match(
    /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i
  )
  let headerName = plainName?.[1] ?? plainName?.[2]
  if (encodedName !== undefined) {
    try {
      headerName = decodeURIComponent(encodedName)
    } catch {
      headerName = encodedName
    }
  }
  let urlName = path.posix.basename(finalUrl.pathname)
  try {
    urlName = decodeURIComponent(urlName)
  } catch {}
  const candidate = (headerName ?? urlName ?? 'download').trim()
  const safeName = path
    .basename(candidate)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
  return safeName === '' ? 'download' : safeName
}
