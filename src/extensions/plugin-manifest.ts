import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { valid, validRange } from 'semver'
import { z } from 'zod'

import { freezeImmutableData } from './immutable-data.ts'
import type { PluginManifest } from './plugin-contracts.ts'

export const PLUGIN_MANIFEST_FILE = 'portal.plugin.json'

export class PluginManifestError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'PluginManifestError'
  }
}

const stableIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._:/-]*$/, 'must be a lowercase stable ID')
const dependencySchema = z
  .object({ id: stableIdSchema, versionRange: z.string().trim().min(1) })
  .strict()
const contributionSchema = z
  .object({
    point: stableIdSchema,
    id: stableIdSchema,
    version: z.number().int().positive(),
  })
  .strict()
const manifestSchema = z
  .object({
    id: stableIdSchema,
    version: z.string().trim().min(1),
    apiVersion: z.number().int().positive(),
    entry: z.string().trim().min(1),
    dependencies: z.array(dependencySchema),
    contributions: z.array(contributionSchema),
    capabilities: z.array(stableIdSchema),
    configSchema: z.string().optional(),
  })
  .strict()

export async function readPluginManifest(
  packageDirectory: string
): Promise<PluginManifest> {
  const manifestPath = path.join(packageDirectory, PLUGIN_MANIFEST_FILE)
  let rawText: string
  try {
    rawText = await readFile(manifestPath, 'utf8')
  } catch (error) {
    throw new PluginManifestError(
      `Unable to read ${PLUGIN_MANIFEST_FILE}: ${getErrorMessage(error)}`
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(rawText) as unknown
  } catch (error) {
    throw new PluginManifestError(
      `Invalid JSON in ${PLUGIN_MANIFEST_FILE}: ${getErrorMessage(error)}`
    )
  }
  return parsePluginManifest(raw)
}

export function parsePluginManifest(raw: unknown): PluginManifest {
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) {
    throw new PluginManifestError(formatSchemaError(parsed.error))
  }
  const value = parsed.data
  const seenDependencies = new Set<string>()
  for (const dependency of value.dependencies) {
    if (seenDependencies.has(dependency.id)) {
      throw new PluginManifestError(`Duplicate dependency: ${dependency.id}`)
    }
    seenDependencies.add(dependency.id)
  }
  const seenContributions = new Set<string>()
  for (const contribution of value.contributions) {
    const key = `${contribution.point}:${contribution.id}`
    if (seenContributions.has(key)) {
      throw new PluginManifestError(`Duplicate contribution: ${key}`)
    }
    seenContributions.add(key)
  }
  if (new Set(value.capabilities).size !== value.capabilities.length) {
    throw new PluginManifestError(
      'manifest.capabilities must not contain duplicates.'
    )
  }
  if (valid(value.version) === null) {
    throw new PluginManifestError(
      'manifest.version must be a valid semantic version.'
    )
  }
  for (const dependency of value.dependencies) {
    if (validRange(dependency.versionRange) === null) {
      throw new PluginManifestError(
        `Dependency ${dependency.id} has an invalid semantic version range.`
      )
    }
  }
  const { id, version, apiVersion, entry } = value
  if (path.isAbsolute(entry) || entry.includes('..')) {
    throw new PluginManifestError(
      'manifest.entry must be a relative package path without traversal.'
    )
  }

  const result: PluginManifest = {
    id,
    version,
    apiVersion,
    entry,
    dependencies: value.dependencies,
    contributions: value.contributions,
    capabilities: value.capabilities,
    ...(value.configSchema === undefined
      ? {}
      : { configSchema: value.configSchema }),
  }
  freezeImmutableData(result)
  return result
}

function formatSchemaError(error: z.ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) return 'Invalid plugin manifest.'
  const location =
    issue.path.length === 0 ? 'manifest' : `manifest.${issue.path.join('.')}`
  return `${location} ${issue.message}.`
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
