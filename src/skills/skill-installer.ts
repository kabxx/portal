import { randomUUID } from 'crypto'
import { cp, mkdir, readdir, rm, stat } from 'fs/promises'
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

export interface InstalledSkill extends AddedSkill {
  managed: boolean
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

  public async install(
    source: string,
    options: SkillInstallOptions = {}
  ): Promise<InstalledSkill[]> {
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
      return await this.commitCandidates(
        candidates,
        preparedSource.directory,
        operationDirectory,
        true,
        options.signal
      )
    } finally {
      await rm(operationDirectory, { recursive: true, force: true }).catch(
        () => {}
      )
    }
  }

  private async inspectLocalSource(
    source: string,
    options: AbortOptions
  ): Promise<InstalledSkill[]> {
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
    return await this.commitCandidates(
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

  private async commitCandidates(
    candidateDirectories: readonly string[],
    sourceRoot: string,
    operationDirectory: string,
    managed: boolean,
    signal?: AbortSignal
  ): Promise<InstalledSkill[]> {
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

    await mkdir(this.skillsDirectory, { recursive: true })
    for (const item of staged) {
      if (await pathExists(item.destination)) {
        throw new SkillInstallError(
          `Managed skill directory already exists: ${item.destination}`
        )
      }
    }

    const ownedDestinations: string[] = []
    try {
      for (const item of staged) {
        throwIfAborted(signal)
        try {
          await mkdir(item.destination)
        } catch (error) {
          if (isNodeError(error) && error.code === 'EEXIST') {
            throw new SkillInstallError(
              `Managed skill directory already exists: ${item.destination}`
            )
          }
          throw error
        }
        ownedDestinations.push(item.destination)
      }
      for (const item of staged) {
        throwIfAborted(signal)
        await copyDirectoryContents(item.directory, item.destination)
        await inspectSkillTree(item.destination, signal, this.policy)
        await assertManifestMatchesDirectory(
          item.destination,
          item.manifest,
          this.policy
        )
      }
    } catch (error) {
      const residuals = await removeMovedDirectories(ownedDestinations)
      const detail = error instanceof Error ? error.message : String(error)
      if (residuals.length > 0) {
        throw new SkillInstallError(
          `${detail}\nFailed to roll back managed skill directories:\n${residuals
            .map((directory) => `- ${directory}`)
            .join('\n')}`
        )
      }
      throw error
    }

    return staged.map(({ manifest, destination }) => ({
      name: manifest.name,
      description: manifest.description,
      directory: destination,
      managed: true,
    }))
  }
}

async function copyDirectoryContents(
  source: string,
  destination: string
): Promise<void> {
  for (const entry of await readdir(source)) {
    await cp(path.join(source, entry), path.join(destination, entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
    })
  }
}

async function removeMovedDirectories(
  directories: readonly string[]
): Promise<string[]> {
  const residuals: string[] = []
  for (const directory of directories) {
    try {
      await rm(directory, { recursive: true, force: true })
    } catch {
      residuals.push(directory)
    }
  }
  return residuals
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
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
