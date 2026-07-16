import { randomUUID } from 'crypto'
import { cp, mkdir, rm, stat } from 'fs/promises'
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
  findSkillCandidates,
  inspectSkillTree,
  listSkillResources,
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

export interface PreparedSkill extends AddedSkill {
  managed: boolean
  stagedDirectory: string | null
  finalDirectory: string
}

export interface PreparedSkillBatch {
  skills: readonly PreparedSkill[]
  cleanup(): Promise<void>
}

interface PreparedSkillSource {
  directory: string
  requestedSubdirectory: string | null
}

export class SkillInstaller {
  public constructor(
    private readonly skillsDirectory: string,
    private readonly tempDirectory: string,
    private readonly policy: SkillPolicy = DEFAULT_SKILL_POLICY
  ) {}

  public async prepare(
    source: string,
    options: SkillInstallOptions = {}
  ): Promise<PreparedSkillBatch> {
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
      return {
        skills: await this.inspectLocalSource(normalizedSource, options),
        cleanup: async () => {},
      }
    }

    const operationDirectory = path.join(this.tempDirectory, randomUUID())
    await mkdir(operationDirectory, { recursive: true })

    try {
      throwIfAborted(options.signal)
      const preparedSource =
        registryUrl === null
          ? await this.prepareRemoteSource(
              remoteUrl!,
              operationDirectory,
              options
            )
          : {
              directory: await this.prepareHubSource(
                normalizedSource,
                registryUrl,
                operationDirectory,
                options
              ),
              requestedSubdirectory: null,
            }

      throwIfAborted(options.signal)
      await inspectSkillTree(
        preparedSource.directory,
        options.signal,
        this.policy
      )
      const candidates = await findSkillCandidates(
        preparedSource.directory,
        preparedSource.requestedSubdirectory,
        options.signal
      )
      const skills = await this.prepareCandidates(
        candidates,
        preparedSource.directory,
        operationDirectory,
        true,
        options.signal
      )
      return {
        skills,
        cleanup: async () => {
          await rm(operationDirectory, { recursive: true, force: true })
        },
      }
    } catch (error) {
      await rm(operationDirectory, { recursive: true, force: true }).catch(
        () => {}
      )
      throw error
    }
  }

  private async inspectLocalSource(
    source: string,
    options: AbortOptions
  ): Promise<PreparedSkill[]> {
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
    const candidates = await findSkillCandidates(
      sourceDirectory,
      null,
      options.signal
    )
    return await this.prepareCandidates(
      candidates,
      sourceDirectory,
      sourceDirectory,
      false,
      options.signal
    )
  }

  private async prepareRemoteSource(
    sourceUrl: URL,
    operationDirectory: string,
    options: AbortOptions
  ): Promise<PreparedSkillSource> {
    const githubDirectory = resolveGitHubDirectoryTarget(sourceUrl)
    if (githubDirectory !== null) {
      const candidateDirectory = path.join(operationDirectory, 'github-source')
      await downloadGitHubDirectory(
        githubDirectory,
        candidateDirectory,
        options,
        this.policy
      )
      return { directory: candidateDirectory, requestedSubdirectory: null }
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
      return {
        directory: await prepareDownloadedSkillFile(
          downloaded.path,
          operationDirectory,
          this.policy
        ),
        requestedSubdirectory: null,
      }
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
    return {
      directory: extractedDirectory,
      requestedSubdirectory: downloaded.archiveSubdirectory,
    }
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
    const candidates = await findSkillCandidates(
      extractedDirectory,
      null,
      options.signal
    )
    if (candidates.length !== 1) {
      throw new SkillInstallError(
        'Skill registry download must contain exactly one skill'
      )
    }
    const manifest = await readSkillManifest(
      candidates[0]!,
      this.policy.maxManifestBytes
    )
    if (manifest.name !== slug) {
      throw new SkillInstallError(
        `Skill registry slug "${slug}" does not match manifest name "${manifest.name}"`
      )
    }
    return candidates[0]!
  }

  private async prepareCandidates(
    candidateDirectories: readonly string[],
    sourceRoot: string,
    operationDirectory: string,
    managed: boolean,
    signal?: AbortSignal
  ): Promise<PreparedSkill[]> {
    if (candidateDirectories.length === 0) {
      throw new SkillInstallError('Skill source does not contain a skill')
    }

    const manifests: Array<{
      directory: string
      manifest: SkillManifest
    }> = []
    const names = new Set<string>()
    for (const directory of candidateDirectories) {
      throwIfAborted(signal)
      const manifest = await readSkillManifest(
        directory,
        this.policy.maxManifestBytes
      )
      await listSkillResources(directory, this.policy.maxResourceFiles, signal)
      const isPreparedRemoteRoot =
        managed && path.resolve(directory) === path.resolve(sourceRoot)
      if (!isPreparedRemoteRoot && path.basename(directory) !== manifest.name) {
        throw new SkillInstallError(
          `Skill folder "${path.basename(directory)}" does not match manifest name "${manifest.name}"`
        )
      }
      if (names.has(manifest.name)) {
        throw new SkillInstallError(
          `Skill source contains duplicate skill name: ${manifest.name}`
        )
      }
      names.add(manifest.name)
      manifests.push({ directory, manifest })
    }

    if (!managed) {
      return manifests.map(({ directory, manifest }) => ({
        name: manifest.name,
        description: manifest.description,
        directory,
        managed: false,
        stagedDirectory: null,
        finalDirectory: directory,
      }))
    }

    const staged: Array<{
      manifest: SkillManifest
      directory: string
      destination: string
    }> = []
    for (const { directory, manifest } of manifests) {
      throwIfAborted(signal)
      const stagedDirectory = path.join(
        operationDirectory,
        'install',
        manifest.name
      )
      await mkdir(path.dirname(stagedDirectory), { recursive: true })
      await cp(directory, stagedDirectory, { recursive: true })
      await inspectSkillTree(stagedDirectory, signal, this.policy)
      await assertManifestMatchesDirectory(
        stagedDirectory,
        manifest,
        this.policy
      )
      staged.push({
        manifest,
        directory: stagedDirectory,
        destination: path.join(this.skillsDirectory, manifest.name),
      })
    }

    return staged.map(({ manifest, directory, destination }) => ({
      name: manifest.name,
      description: manifest.description,
      directory,
      managed: true,
      stagedDirectory: directory,
      finalDirectory: destination,
    }))
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
