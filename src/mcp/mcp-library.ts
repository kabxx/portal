import { lstat } from 'fs/promises'
import {
  McpDuplicateNameError,
  parseMcpServerConfig,
  readMcpConfig,
  updateMcpConfig,
  validateMcpServerName,
  writeMcpConfig,
  type McpConfigIssue,
  type McpServerConfig,
} from './mcp-config.ts'

export interface McpServerSummary {
  name: string
  enabled: boolean
  config: McpServerConfig
}

export interface McpListResult {
  servers: readonly McpServerSummary[]
  issues: readonly McpConfigIssue[]
}

export interface McpRuntimeSnapshot {
  servers: ReadonlyMap<string, McpServerConfig>
  issues: readonly McpConfigIssue[]
}

export class McpLibrary {
  public constructor(public readonly configPath: string) {}

  public async initialize(): Promise<void> {
    if (await pathExists(this.configPath)) {
      return
    }
    await this.loadConfig()
  }

  public async list(): Promise<McpListResult> {
    try {
      const config = await this.loadConfig()
      return {
        servers: [...config.servers.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, server]) => ({
            name,
            enabled: server.enabled !== false,
            config: server,
          })),
        issues: config.issues,
      }
    } catch (error) {
      return {
        servers: [],
        issues: [{ server: null, message: getErrorMessage(error) }],
      }
    }
  }

  public async createRuntimeSnapshot(): Promise<McpRuntimeSnapshot> {
    try {
      const config = await this.loadConfig()
      return {
        servers: new Map(
          [...config.servers.entries()].filter(
            ([, server]) => server.enabled !== false
          )
        ),
        issues: config.issues,
      }
    } catch (error) {
      return {
        servers: new Map(),
        issues: [{ server: null, message: getErrorMessage(error) }],
      }
    }
  }

  public async add(name: string, config: McpServerConfig): Promise<void> {
    validateMcpServerName(name)
    const normalized = parseMcpServerConfig(config)
    await updateMcpConfig(this.configPath, (servers) => {
      if (servers.has(name)) {
        throw new McpDuplicateNameError(name)
      }
      servers.set(name, normalized)
    })
  }

  public async set(name: string, config: McpServerConfig): Promise<void> {
    validateMcpServerName(name)
    const normalized = parseMcpServerConfig(config)
    await updateMcpConfig(this.configPath, (servers) => {
      servers.set(name, normalized)
    })
  }

  public async enable(name: string): Promise<boolean> {
    return await this.setEnabled(name, true)
  }

  public async disable(name: string): Promise<boolean> {
    return await this.setEnabled(name, false)
  }

  public async remove(name: string): Promise<boolean> {
    validateMcpServerName(name)
    return await updateMcpConfig(this.configPath, (servers) =>
      servers.delete(name)
    )
  }

  private async setEnabled(name: string, enabled: boolean): Promise<boolean> {
    validateMcpServerName(name)
    return await updateMcpConfig(this.configPath, (servers) => {
      const server = servers.get(name)
      if (server === undefined) {
        return false
      }
      const next = { ...server }
      if (enabled) {
        delete next.enabled
      } else {
        next.enabled = false
      }
      servers.set(name, next)
      return true
    })
  }

  private async loadConfig() {
    const existing = await readMcpConfig(this.configPath)
    if (existing !== null) {
      return existing
    }
    const servers = new Map<string, McpServerConfig>()
    await writeMcpConfig(this.configPath, servers)
    return {
      servers,
      issues: [] as const,
    }
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
