import path from 'path'
import { validateSkillName } from './skill-manifest.ts'
import {
  createDefaultPortalConfig,
  PortalConfigError,
  readPortalConfig,
  updatePortalConfig,
} from '../config/portal-config.ts'

export interface SkillRegistryEntry {
  directory: string
  enabled: boolean
}

export interface SkillRegistryIssue {
  name: string
  message: string
}

export interface SkillRegistryData {
  entries: Map<string, SkillRegistryEntry>
  issues: readonly SkillRegistryIssue[]
}

export class SkillRegistryError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'SkillRegistryError'
  }
}

export async function readSkillRegistry(
  registryPath: string
): Promise<SkillRegistryData | null> {
  let config
  try {
    config = await readPortalConfig(registryPath)
  } catch (error) {
    if (error instanceof PortalConfigError) {
      throw new SkillRegistryError(error.message)
    }
    throw error
  }
  if (config === null) {
    return null
  }
  return parseSkillRegistry(config.skills)
}

export function parseSkillRegistry(document: unknown): SkillRegistryData {
  if (!Array.isArray(document)) {
    throw new SkillRegistryError('skills must be an array')
  }

  const entries = new Map<string, SkillRegistryEntry>()
  const issues: SkillRegistryIssue[] = []
  const seenNames = new Set<string>()
  for (const [index, value] of document.entries()) {
    let issueName = `entry[${index}]`
    try {
      if (!isRecord(value)) {
        throw new SkillRegistryError('Entry must be an object')
      }
      if (typeof value.name !== 'string' || value.name.trim() === '') {
        throw new SkillRegistryError('Entry requires a non-empty name')
      }
      validateSkillName(value.name)
      issueName = value.name
      if (seenNames.has(value.name)) {
        entries.delete(value.name)
        throw new SkillRegistryError('Duplicate skill name')
      }
      seenNames.add(value.name)
      const unsupportedEntryFields = Object.keys(value).filter(
        (field) =>
          field !== 'name' && field !== 'directory' && field !== 'enabled'
      )
      if (unsupportedEntryFields.length > 0) {
        throw new SkillRegistryError(
          `Unsupported entry fields: ${unsupportedEntryFields.join(', ')}`
        )
      }
      if (
        typeof value.directory !== 'string' ||
        value.directory.trim() === ''
      ) {
        throw new SkillRegistryError('Entry requires a non-empty directory')
      }
      if (typeof value.enabled !== 'boolean') {
        throw new SkillRegistryError('Entry requires a boolean enabled value')
      }
      entries.set(value.name, {
        directory: value.directory,
        enabled: value.enabled,
      })
    } catch (error) {
      issues.push({ name: issueName, message: getErrorMessage(error) })
    }
  }

  return { entries, issues }
}

export async function writeSkillRegistry(
  registryPath: string,
  entries: ReadonlyMap<string, SkillRegistryEntry>
): Promise<void> {
  await updatePortalConfig(
    registryPath,
    (config) => {
      config.skills = serializeSkillRegistry(entries)
    },
    createDefaultPortalConfig(path.dirname(registryPath))
  )
}

export async function updateSkillRegistry<T>(
  registryPath: string,
  update: (registry: SkillRegistryData) => T
): Promise<T> {
  let result!: T
  try {
    await updatePortalConfig(
      registryPath,
      (config) => {
        const registry = parseSkillRegistry(config.skills)
        result = update(registry)
        config.skills = serializeSkillRegistry(registry.entries)
      },
      createDefaultPortalConfig(path.dirname(registryPath))
    )
  } catch (error) {
    if (error instanceof PortalConfigError) {
      throw new SkillRegistryError(error.message)
    }
    throw error
  }
  return result
}

export function resolveSkillDirectory(
  registryPath: string,
  directory: string
): string {
  return path.resolve(path.dirname(registryPath), directory)
}

function serializeSkillRegistry(
  entries: ReadonlyMap<string, SkillRegistryEntry>
): unknown[] {
  return [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entry]) => ({ name, ...entry }))
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
