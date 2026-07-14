import path from 'path'
import type { AbortOptions } from '../runtime/runtime-cancellation.ts'
import { throwIfAborted } from '../runtime/runtime-cancellation.ts'
import { joinPromptSections } from '../shared/prompt-sections.ts'
import type { McpLibrary } from './mcp-library.ts'
import {
  connectMcpServer,
  McpConnectionError,
  McpToolOutcomeUnknownError,
  McpToolResponseError,
  type McpConnection,
  type McpConnector,
  type McpPromptDefinition,
  type McpResourceDefinition,
} from './mcp-connection.ts'
import {
  renderMcpPromptAttachment,
  renderMcpResourceAttachment,
  renderMcpToolDefinition,
  renderMcpToolResult,
} from './mcp-content.ts'

export interface McpSessionWarning {
  server: string | null
  markdown: string
}

export interface CreateThreadMcpSessionOptions extends AbortOptions {
  connector?: McpConnector
  environment?: NodeJS.ProcessEnv
  onWarning?: (warning: McpSessionWarning) => void | Promise<void>
}

export interface McpListedResource extends McpResourceDefinition {
  server: string
}

export interface McpListedPrompt extends McpPromptDefinition {
  server: string
}

export interface McpListResponse<T> {
  items: readonly T[]
  issues: readonly McpSessionWarning[]
}

export interface McpToolOperationResult {
  outcome: 'success' | 'error' | 'unknown'
  result: Record<string, unknown>
  displayText: string
}

export class ThreadMcpSession {
  private closed = false

  public constructor(
    private readonly connections: ReadonlyMap<string, McpConnection>
  ) {}

  public get hasAvailableConnections(): boolean {
    return [...this.connections.values()].some(
      (connection) => connection.available
    )
  }

  public get prompt(): string | null {
    const connections = this.availableConnections()
    if (connections.length === 0) {
      return null
    }
    return joinPromptSections([
      `# MCP Servers`,
      ...connections.map((connection) =>
        [
          `## ${connection.name}`,
          ...connection
            .listCachedTools()
            .map((tool) => `- ${JSON.stringify(tool.name)}`),
        ].join('\n')
      ),
    ])
  }

  public searchTool(server: string, tool: string): McpToolOperationResult {
    const connection = this.getAvailableConnection(server)
    const definition = connection?.getCachedTool(tool) ?? null
    if (connection === null || definition === null) {
      return this.unavailableToolResult(server, tool)
    }
    return {
      outcome: 'success',
      result: renderMcpToolDefinition(server, definition),
      displayText: [
        'MCP tool definition loaded.',
        `server: ${server}`,
        `tool: ${tool}`,
      ].join('\n'),
    }
  }

  public async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    options: AbortOptions = {}
  ): Promise<McpToolOperationResult> {
    const connection = this.getAvailableConnection(server)
    if (connection === null || connection.getCachedTool(tool) === null) {
      return this.unavailableToolResult(server, tool)
    }
    try {
      const result = await connection.callTool(tool, args, options)
      const rendered = renderMcpToolResult(result, connection.maxOutputChars)
      return {
        outcome: rendered.isError ? 'error' : 'success',
        result: {
          server,
          tool,
          ...rendered.result,
        },
        displayText: [
          rendered.isError
            ? 'MCP tool returned an error.'
            : 'MCP tool returned a result.',
          `server: ${server}`,
          `tool: ${tool}`,
        ].join('\n'),
      }
    } catch (error) {
      if (error instanceof McpToolOutcomeUnknownError) {
        return {
          outcome: 'unknown',
          result: {
            server,
            tool,
            reason: error.reason,
            retry: false,
          },
          displayText: [
            'MCP tool outcome is unknown.',
            `server: ${server}`,
            `tool: ${tool}`,
            'Do not retry automatically.',
          ].join('\n'),
        }
      }
      if (error instanceof McpToolResponseError) {
        return {
          outcome: 'error',
          result: {
            server,
            tool,
            message: error.message,
          },
          displayText: [
            'MCP tool returned an error.',
            `server: ${server}`,
            `tool: ${tool}`,
            error.message,
          ].join('\n'),
        }
      }
      throw error
    }
  }

  public async listResources(
    server?: string,
    options: AbortOptions = {}
  ): Promise<McpListResponse<McpListedResource>> {
    const targets = this.selectConnections(server)
    const results = await Promise.all(
      targets.map(async (connection) => {
        try {
          const resources = await connection.listResources(options)
          return {
            items: resources.map((resource) => ({
              server: connection.name,
              ...resource,
            })),
            issue: null,
          }
        } catch (error) {
          return {
            items: [],
            issue: createOperationWarning(connection.name, error),
          }
        }
      })
    )
    return {
      items: results.flatMap((result) => result.items),
      issues: results.flatMap((result) =>
        result.issue === null ? [] : [result.issue]
      ),
    }
  }

  public async createResourceAttachment(
    server: string,
    uri: string,
    options: AbortOptions = {}
  ): Promise<string> {
    const connection = this.getAvailableConnection(server)
    if (connection === null) {
      throw new Error(this.renderUnavailable(server, null))
    }
    const result = await connection.readResource(uri, options)
    return renderMcpResourceAttachment(
      server,
      uri,
      result,
      connection.maxOutputChars
    )
  }

  public async listPrompts(
    server?: string,
    options: AbortOptions = {}
  ): Promise<McpListResponse<McpListedPrompt>> {
    const targets = this.selectConnections(server)
    const results = await Promise.all(
      targets.map(async (connection) => {
        try {
          const prompts = await connection.listPrompts(options)
          return {
            items: prompts.map((prompt) => ({
              server: connection.name,
              ...prompt,
            })),
            issue: null,
          }
        } catch (error) {
          return {
            items: [],
            issue: createOperationWarning(connection.name, error),
          }
        }
      })
    )
    return {
      items: results.flatMap((result) => result.items),
      issues: results.flatMap((result) =>
        result.issue === null ? [] : [result.issue]
      ),
    }
  }

  public async createPromptAttachment(
    server: string,
    prompt: string,
    args: Record<string, string>,
    options: AbortOptions = {}
  ): Promise<string> {
    const connection = this.getAvailableConnection(server)
    if (connection === null) {
      throw new Error(this.renderUnavailable(server, null))
    }
    const result = await connection.getPrompt(prompt, args, options)
    return renderMcpPromptAttachment(
      server,
      prompt,
      args,
      result,
      connection.maxOutputChars
    )
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    await Promise.allSettled(
      [...this.connections.values()].map(
        async (connection) => await connection.close()
      )
    )
  }

  private getAvailableConnection(name: string): McpConnection | null {
    const connection = this.connections.get(name)
    return connection?.available === true ? connection : null
  }

  private availableConnections(): McpConnection[] {
    return [...this.connections.values()]
      .filter((connection) => connection.available)
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  private selectConnections(server?: string): McpConnection[] {
    if (server === undefined) {
      return this.availableConnections()
    }
    const connection = this.getAvailableConnection(server)
    if (connection === null) {
      throw new Error(this.renderUnavailable(server, null))
    }
    return [connection]
  }

  private renderUnavailable(server: string, tool: string | null): string {
    return [
      `# MCP ${tool === null ? 'Server' : 'Tool'} Unavailable`,
      ``,
      `The requested MCP target is not available in this thread's current session.`,
      ``,
      `## Requested`,
      ``,
      `- Server: ${JSON.stringify(server)}`,
      ...(tool === null ? [] : [`- Tool: ${JSON.stringify(tool)}`]),
      ``,
      `## Current MCP Servers`,
      ``,
      ...this.renderCatalogLines(),
    ].join('\n')
  }

  private unavailableToolResult(
    server: string,
    tool: string
  ): McpToolOperationResult {
    return {
      outcome: 'error',
      result: {
        server,
        tool,
        message:
          "The requested MCP target is not available in this thread's current session.",
        availableServers: this.availableConnections().map((connection) => ({
          server: connection.name,
          tools: connection.listCachedTools().map((item) => item.name),
        })),
      },
      displayText: [
        'MCP tool is unavailable.',
        `server: ${server}`,
        `tool: ${tool}`,
      ].join('\n'),
    }
  }

  private renderCatalogLines(): string[] {
    const connections = this.availableConnections()
    if (connections.length === 0) {
      return ['- None']
    }
    return connections.map((connection) => {
      const tools = connection
        .listCachedTools()
        .map((tool) => JSON.stringify(tool.name))
      return `- ${connection.name}${tools.length > 0 ? `: ${tools.join(', ')}` : ''}`
    })
  }
}

export async function createThreadMcpSession(
  library: McpLibrary,
  options: CreateThreadMcpSessionOptions = {}
): Promise<ThreadMcpSession> {
  const snapshot = await library.createRuntimeSnapshot()
  const connector = options.connector ?? connectMcpServer
  const warnings: McpSessionWarning[] = snapshot.issues.map(
    ({ server, message }) => ({
      server,
      markdown: renderConnectionWarning(server, message),
    })
  )
  const configDirectory = path.dirname(library.configPath)
  const results = await Promise.all(
    [...snapshot.servers.entries()].map(async ([name, config]) => {
      try {
        const connection = await connector(name, config, {
          configDirectory,
          ...(options.environment !== undefined
            ? { environment: options.environment }
            : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        })
        return { connection, warning: null }
      } catch (error) {
        return {
          connection: null,
          warning: {
            server: name,
            markdown: renderConnectionWarning(
              name,
              error instanceof McpConnectionError
                ? error.message
                : 'Connection failed.'
            ),
          },
        }
      }
    })
  )
  const connections = new Map<string, McpConnection>()
  for (const result of results) {
    if (result.connection !== null) {
      connections.set(result.connection.name, result.connection)
    }
    if (result.warning !== null) {
      warnings.push(result.warning)
    }
  }

  if (options.signal?.aborted) {
    await Promise.allSettled(
      [...connections.values()].map(async (connection) => connection.close())
    )
    throwIfAborted(options.signal)
  }
  const session = new ThreadMcpSession(connections)
  try {
    for (const warning of warnings) {
      await options.onWarning?.(warning)
    }
  } catch (error) {
    await session.close()
    throw error
  }
  return session
}

function renderConnectionWarning(
  server: string | null,
  reason: string
): string {
  return [
    `# MCP Server Unavailable`,
    ``,
    server === null
      ? `Portal could not load the MCP configuration.`
      : `Portal could not connect MCP server ${JSON.stringify(server)}. It was omitted from this thread.`,
    ``,
    `- Reason: ${reason}`,
  ].join('\n')
}

function createOperationWarning(
  server: string,
  error: unknown
): McpSessionWarning {
  return {
    server,
    markdown: [
      `# MCP Request Failed`,
      ``,
      `- Server: ${JSON.stringify(server)}`,
      `- Reason: ${error instanceof Error ? error.message : String(error)}`,
    ].join('\n'),
  }
}
