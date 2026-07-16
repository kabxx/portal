import path from 'node:path'
import {
  createDefaultPortalConfig,
  PortalConfigError,
  readPortalConfig,
  updatePortalConfig,
} from '../config/portal-config.ts'

export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 15_000
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000
export const DEFAULT_MCP_MAX_OUTPUT_CHARS = 100_000

interface McpServerDefaults {
  enabled?: boolean
  connectTimeoutMs?: number
  toolTimeoutMs?: number
  maxOutputChars?: number
}

export interface McpStdioServerConfig extends McpServerDefaults {
  transport: 'stdio'
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

export interface McpHttpServerConfig extends McpServerDefaults {
  transport: 'streamable-http'
  url: string
  headers?: Record<string, string>
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig

export interface McpConfigIssue {
  server: string | null
  message: string
}

export interface McpConfigData {
  servers: Map<string, McpServerConfig>
  issues: readonly McpConfigIssue[]
}

export type McpConfigErrorKind =
  | 'invalid-input'
  | 'duplicate-name'
  | 'stored-config-invalid'

export class McpConfigError extends Error {
  public constructor(
    message: string,
    public readonly kind: McpConfigErrorKind = 'invalid-input'
  ) {
    super(message)
    this.name = 'McpConfigError'
  }
}

export class McpDuplicateNameError extends McpConfigError {
  public constructor(name: string) {
    super(`MCP server already exists: ${name}`, 'duplicate-name')
    this.name = 'McpDuplicateNameError'
  }
}

export class McpStoredConfigError extends McpConfigError {
  public constructor(message: string) {
    super(message, 'stored-config-invalid')
    this.name = 'McpStoredConfigError'
  }
}

const COMMON_SERVER_FIELDS = new Set([
  'transport',
  'enabled',
  'connectTimeoutMs',
  'toolTimeoutMs',
  'maxOutputChars',
])
const STDIO_SERVER_FIELDS = new Set([
  ...COMMON_SERVER_FIELDS,
  'command',
  'args',
  'cwd',
  'env',
])
const HTTP_SERVER_FIELDS = new Set([...COMMON_SERVER_FIELDS, 'url', 'headers'])
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export async function readMcpConfig(
  configPath: string
): Promise<McpConfigData | null> {
  try {
    const config = await readPortalConfig(configPath)
    return config === null ? null : parseMcpConfig(config.mcpServers)
  } catch (error) {
    if (error instanceof PortalConfigError || error instanceof McpConfigError) {
      throw new McpStoredConfigError(getErrorMessage(error))
    }
    throw error
  }
}

export function parseMcpConfig(document: unknown): McpConfigData {
  if (!isRecord(document)) {
    throw new McpConfigError('mcpServers must be an object keyed by name')
  }

  const servers = new Map<string, McpServerConfig>()
  const issues: McpConfigIssue[] = []
  for (const [name, value] of Object.entries(document)) {
    try {
      validateMcpServerName(name)
      servers.set(name, parseMcpServerConfig(value))
    } catch (error) {
      issues.push({ server: name, message: getErrorMessage(error) })
    }
  }

  return { servers, issues }
}

export function validateMcpServerName(name: string): void {
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    throw new McpConfigError(
      'Server name must start with an alphanumeric character and contain only letters, numbers, dots, underscores, or hyphens'
    )
  }
}

export function parseMcpServerConfig(value: unknown): McpServerConfig {
  if (!isRecord(value)) {
    throw new McpConfigError('Server config must be an object')
  }
  const defaults = parseServerDefaults(value)

  if (value.transport === 'stdio') {
    assertSupportedFields(value, STDIO_SERVER_FIELDS, 'stdio server')
    const command = requireNonEmptyString(value.command, 'command')
    const args = parseOptionalStringArray(value.args, 'args')
    const cwd = parseOptionalNonEmptyString(value.cwd, 'cwd')
    const env = parseOptionalStringRecord(value.env, 'env')
    return {
      transport: 'stdio',
      command,
      ...(args !== undefined ? { args } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(env !== undefined ? { env } : {}),
      ...defaults,
    }
  }

  if (value.transport === 'streamable-http') {
    assertSupportedFields(value, HTTP_SERVER_FIELDS, 'HTTP server')
    const url = requireNonEmptyString(value.url, 'url')
    const headers = parseOptionalStringRecord(value.headers, 'headers', true)
    return {
      transport: 'streamable-http',
      url,
      ...(headers !== undefined ? { headers } : {}),
      ...defaults,
    }
  }

  throw new McpConfigError(
    'transport must be either "stdio" or "streamable-http"'
  )
}

export async function writeMcpConfig(
  configPath: string,
  servers: ReadonlyMap<string, McpServerConfig>
): Promise<void> {
  await updatePortalConfig(
    configPath,
    (config) => {
      config.mcpServers = serializeMcpConfig(servers)
    },
    createDefaultPortalConfig(path.dirname(configPath))
  )
}

export async function updateMcpConfig<T>(
  configPath: string,
  update: (servers: Map<string, McpServerConfig>) => T
): Promise<T> {
  let result!: T
  try {
    await updatePortalConfig(
      configPath,
      (config) => {
        let current: McpConfigData
        try {
          current = parseMcpConfig(config.mcpServers)
        } catch (error) {
          if (error instanceof McpConfigError) {
            throw new McpStoredConfigError(error.message)
          }
          throw error
        }
        if (current.issues.length > 0) {
          throw new McpStoredConfigError(
            [
              'config.yaml contains invalid MCP servers. Fix them before modifying it.',
              ...current.issues.map(
                ({ server, message }) => `- ${server ?? 'config'}: ${message}`
              ),
            ].join('\n')
          )
        }
        const servers = new Map(current.servers)
        result = update(servers)
        config.mcpServers = serializeMcpConfig(servers)
      },
      createDefaultPortalConfig(path.dirname(configPath))
    )
  } catch (error) {
    if (error instanceof PortalConfigError) {
      throw new McpStoredConfigError(error.message)
    }
    throw error
  }
  return result
}

function serializeMcpConfig(
  servers: ReadonlyMap<string, McpServerConfig>
): Record<string, unknown> {
  const sortedServers = Object.fromEntries(
    [...servers.entries()].sort(([left], [right]) => left.localeCompare(right))
  )
  return sortedServers
}

function parseServerDefaults(
  value: Record<string, unknown>
): McpServerDefaults {
  const enabled = value.enabled
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new McpConfigError('enabled must be a boolean')
  }
  const connectTimeoutMs = parseOptionalPositiveInteger(
    value.connectTimeoutMs,
    'connectTimeoutMs'
  )
  const toolTimeoutMs = parseOptionalPositiveInteger(
    value.toolTimeoutMs,
    'toolTimeoutMs'
  )
  const maxOutputChars = parseOptionalPositiveInteger(
    value.maxOutputChars,
    'maxOutputChars'
  )
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(connectTimeoutMs !== undefined ? { connectTimeoutMs } : {}),
    ...(toolTimeoutMs !== undefined ? { toolTimeoutMs } : {}),
    ...(maxOutputChars !== undefined ? { maxOutputChars } : {}),
  }
}

function parseOptionalPositiveInteger(
  value: unknown,
  field: string
): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new McpConfigError(`${field} must be a positive integer`)
  }
  return value as number
}

function parseOptionalStringArray(
  value: unknown,
  field: string
): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string')
  ) {
    throw new McpConfigError(`${field} must be an array of strings`)
  }
  return [...value]
}

function parseOptionalStringRecord(
  value: unknown,
  field: string,
  requireNonEmptyKeys = false
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!isRecord(value)) {
    throw new McpConfigError(`${field} must be an object of string values`)
  }
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (
      (requireNonEmptyKeys && key.trim() === '') ||
      typeof item !== 'string'
    ) {
      throw new McpConfigError(
        `${field} must be an object with non-empty keys and string values`
      )
    }
    result[key] = item
  }
  return result
}

function parseOptionalNonEmptyString(
  value: unknown,
  field: string
): string | undefined {
  return value === undefined ? undefined : requireNonEmptyString(value, field)
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new McpConfigError(`${field} must be a non-empty string`)
  }
  return value
}

function assertSupportedFields(
  value: Record<string, unknown>,
  supported: ReadonlySet<string>,
  label: string
): void {
  const unsupported = Object.keys(value).filter(
    (field) => !supported.has(field)
  )
  if (unsupported.length > 0) {
    throw new McpConfigError(
      `Unsupported ${label} fields: ${unsupported.join(', ')}`
    )
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
