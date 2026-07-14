import { stat, readFile } from 'fs/promises'
import path from 'path'
import { parse } from 'yaml'

const SKILL_FILE_NAME = 'SKILL.md'
const MAX_SKILL_FILE_BYTES = 512 * 1024
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface SkillManifest {
  name: string
  description: string
  body: string
}

export class SkillManifestError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'SkillManifestError'
  }
}

export async function readSkillManifest(
  skillDirectory: string,
  maxSkillFileBytes = MAX_SKILL_FILE_BYTES
): Promise<SkillManifest> {
  const manifestPath = path.join(skillDirectory, SKILL_FILE_NAME)
  let fileStat
  try {
    fileStat = await stat(manifestPath)
  } catch {
    throw new SkillManifestError(`Missing ${SKILL_FILE_NAME}: ${manifestPath}`)
  }

  if (!fileStat.isFile()) {
    throw new SkillManifestError(`${SKILL_FILE_NAME} is not a file`)
  }
  if (fileStat.size > maxSkillFileBytes) {
    throw new SkillManifestError(
      `${SKILL_FILE_NAME} exceeds ${maxSkillFileBytes} bytes`
    )
  }

  return parseSkillManifest(await readFile(manifestPath, 'utf8'))
}

export function parseSkillManifest(contents: string): SkillManifest {
  const normalized = contents.replace(/^\uFEFF/, '')
  const match = normalized.match(
    /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/
  )
  if (match === null) {
    throw new SkillManifestError(
      'SKILL.md must start with YAML frontmatter enclosed by --- lines'
    )
  }

  let frontmatter: unknown
  try {
    frontmatter = parse(match[1] ?? '')
  } catch (error) {
    throw new SkillManifestError(`Invalid YAML frontmatter: ${String(error)}`)
  }
  if (!isRecord(frontmatter)) {
    throw new SkillManifestError('SKILL.md frontmatter must be a YAML object')
  }

  const name = frontmatter.name
  if (typeof name !== 'string') {
    throw new SkillManifestError('SKILL.md frontmatter requires string name')
  }
  validateSkillName(name)

  const description = frontmatter.description
  if (typeof description !== 'string' || description.trim() === '') {
    throw new SkillManifestError(
      'SKILL.md frontmatter requires non-empty string description'
    )
  }
  if (description.length > 1024) {
    throw new SkillManifestError('Skill description exceeds 1024 characters')
  }

  const body = (match[2] ?? '').trim()
  if (body === '') {
    throw new SkillManifestError('SKILL.md instruction body is empty')
  }

  return {
    name,
    description: description.trim(),
    body,
  }
}

export function validateSkillName(name: string): void {
  if (name.length < 1 || name.length > 64 || !SKILL_NAME_PATTERN.test(name)) {
    throw new SkillManifestError(
      `Invalid skill name "${name}". Use 1-64 lowercase letters, numbers, and single hyphens.`
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
