import { randomUUID } from 'crypto'
import { cp, mkdir, rename, rm, stat } from 'fs/promises'
import path from 'path'
import type { AbortOptions } from '../runtime/runtime-cancellation.ts'
import { throwIfAborted } from '../runtime/runtime-cancellation.ts'
import { extractSkillArchive, isSupportedArchive } from './skill-archive.ts'
import {
  downloadSkillFile,
  isDownloadedSkillDocument,
  parseSkillUrl,
} from './skill-download.ts'
import {
  downloadGitHubDirectory,
  resolveGitHubDirectoryTarget,
} from './skill-github-download.ts'
import {
  findSkillCandidate,
  inspectSkillTree,
  pathExists,
  SkillInstallError,
} from './skill-files.ts'
import {
  downloadSkillFromHub,
  parseSkillRegistryUrl,
} from './skill-hub-download.ts'
import { readSkillManifest, type SkillManifest } from './skill-manifest.ts'
import { DEFAULT_SKILL_POLICY, type SkillPolicy } from './skill-policy.ts'

export { SkillInstallError } from './skill-files.ts'

export interface AddedSkill {
  name: string
  description: string
  directory: string
}

export interface SkillAddOptions {
  registryUrl?: string
}

export interface SkillInstallOptions extends AbortOptions, SkillAddOptions {}

interface SkillInstallResult extends AddedSkill {
  managed: boolean
}

export class SkillInstaller {
  public constructor(
    private readonly skillsDirectory: string,
    private readonly tempDirectory: string,
    private readonly policy: SkillPolicy = DEFAULT_SKILL_POLICY
  ) {}

  public async install(
    source: string,
    options: SkillInstallOptions = {}
  ): Promise<SkillInstallResult> {
    const normalizedSource = source.trim()
    if (normalizedSource === '') {
      throw new SkillInstallError('Skill source is empty')
    }

    const registryUrl =
      options.registryUrl === undefined
        ? null
        : parseSkillRegistryUrl(options.registryUrl)
    const remoteUrl =
      registryUrl === null ? parseSkillUrl(normalizedSource) : null
    if (registryUrl === null && remoteUrl === null) {
      return await this.inspectLocalSource(normalizedSource, options)
    }

    const operationDirectory = path.join(this.tempDirectory, randomUUID())
    await mkdir(operationDirectory, { recursive: true })

    try {
      throwIfAborted(options.signal)
      const candidate =
        registryUrl === null
          ? await this.prepareRemoteSource(
              remoteUrl!,
              operationDirectory,
              options
            )
          : await this.prepareHubSource(
              normalizedSource,
              registryUrl,
              operationDirectory,
              options
            )

      throwIfAborted(options.signal)
      return await this.commitCandidate(candidate, operationDirectory)
    } finally {
      await rm(operationDirectory, { recursive: true, force: true }).catch(
        () => {}
      )
    }
  }

  private async inspectLocalSource(
    source: string,
    options: AbortOptions
  ): Promise<SkillInstallResult> {
    const sourceDirectory = path.resolve(source)
    let sourceStat
    try {
      sourceStat = await stat(sourceDirectory)
    } catch {
      throw new SkillInstallError(`Local skill directory not found: ${source}`)
    }
    if (!sourceStat.isDirectory()) {
      throw new SkillInstallError(
        `Local skill source is not a directory: ${source}`
      )
    }

    await inspectSkillTree(sourceDirectory, options.signal, this.policy)
    const manifest = await readSkillManifest(
      sourceDirectory,
      this.policy.maxManifestBytes
    )
    if (path.basename(sourceDirectory) !== manifest.name) {
      throw new SkillInstallError(
        `Skill folder "${path.basename(sourceDirectory)}" does not match manifest name "${manifest.name}"`
      )
    }
    return {
      name: manifest.name,
      description: manifest.description,
      directory: sourceDirectory,
      managed: false,
    }
  }

  private async prepareRemoteSource(
    sourceUrl: URL,
    operationDirectory: string,
    options: AbortOptions
  ): Promise<string> {
    const githubDirectory = resolveGitHubDirectoryTarget(sourceUrl)
    if (githubDirectory !== null) {
      const candidateDirectory = path.join(operationDirectory, 'github-source')
      await downloadGitHubDirectory(
        githubDirectory,
        candidateDirectory,
        options,
        this.policy
      )
      return candidateDirectory
    }

    const downloadDirectory = path.join(operationDirectory, 'download')
    await mkdir(downloadDirectory, { recursive: true })
    const downloaded = await downloadSkillFile(
      sourceUrl,
      downloadDirectory,
      options,
      this.policy
    )

    if (await isDownloadedSkillDocument(downloaded)) {
      return await prepareDownloadedSkillFile(
        downloaded.path,
        operationDirectory,
        this.policy
      )
    }
    if (!(await isSupportedArchive(downloaded.path))) {
      if (downloaded.contentType.toLowerCase().includes('text/html')) {
        throw new SkillInstallError(
          'URL returned an HTML page instead of a downloadable skill file'
        )
      }
      throw new SkillInstallError(
        'Downloaded file is neither SKILL.md nor a supported archive'
      )
    }

    const extractedDirectory = await extractSkillArchive(
      downloaded.path,
      path.join(operationDirectory, 'extracted'),
      options.signal,
      this.policy
    )
    return await findSkillCandidate(
      extractedDirectory,
      downloaded.archiveSubdirectory,
      this.policy
    )
  }

  private async prepareHubSource(
    slug: string,
    registryUrl: URL,
    operationDirectory: string,
    options: AbortOptions
  ): Promise<string> {
    const downloadDirectory = path.join(operationDirectory, 'hub-download')
    await mkdir(downloadDirectory, { recursive: true })
    const downloadedPath = await downloadSkillFromHub(
      slug,
      registryUrl,
      downloadDirectory,
      options,
      this.policy
    )
    if (!(await isSupportedArchive(downloadedPath))) {
      throw new SkillInstallError(
        'Skill registry download is not a supported archive'
      )
    }

    const extractedDirectory = await extractSkillArchive(
      downloadedPath,
      path.join(operationDirectory, 'extracted'),
      options.signal,
      this.policy
    )
    return await findSkillCandidate(extractedDirectory, null, this.policy)
  }

  private async commitCandidate(
    candidateDirectory: string,
    operationDirectory: string
  ): Promise<SkillInstallResult> {
    await inspectSkillTree(candidateDirectory, undefined, this.policy)
    const manifest = await readSkillManifest(
      candidateDirectory,
      this.policy.maxManifestBytes
    )
    const normalizedDirectory = path.join(
      operationDirectory,
      'install',
      manifest.name
    )
    await mkdir(path.dirname(normalizedDirectory), { recursive: true })
    await cp(candidateDirectory, normalizedDirectory, { recursive: true })
    await inspectSkillTree(normalizedDirectory, undefined, this.policy)
    await assertManifestMatchesDirectory(
      normalizedDirectory,
      manifest,
      this.policy
    )

    await mkdir(this.skillsDirectory, { recursive: true })
    const destination = path.join(this.skillsDirectory, manifest.name)
    if (await pathExists(destination)) {
      throw new SkillInstallError(
        `Managed skill directory already exists: ${destination}`
      )
    }

    await rename(normalizedDirectory, destination)
    return {
      name: manifest.name,
      description: manifest.description,
      directory: destination,
      managed: true,
    }
  }
}

async function prepareDownloadedSkillFile(
  filePath: string,
  operationDirectory: string,
  policy: SkillPolicy
): Promise<string> {
  const rawDirectory = path.join(operationDirectory, 'raw-skill')
  await mkdir(rawDirectory, { recursive: true })
  await cp(filePath, path.join(rawDirectory, 'SKILL.md'))
  await readSkillManifest(rawDirectory, policy.maxManifestBytes)
  return rawDirectory
}

async function assertManifestMatchesDirectory(
  directory: string,
  expected: SkillManifest,
  policy: SkillPolicy
): Promise<void> {
  const installed = await readSkillManifest(directory, policy.maxManifestBytes)
  if (
    installed.name !== path.basename(directory) ||
    installed.name !== expected.name
  ) {
    throw new SkillInstallError(
      `Installed skill folder does not match manifest name: ${installed.name}`
    )
  }
}
