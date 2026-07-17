import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import type { AbortOptions } from '../runtime/runtime-cancellation.ts'
import {
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  DEFAULT_MCP_MAX_OUTPUT_CHARS,
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  type McpServerConfig,
} from './mcp-config.ts'
import {
  redactMcpError,
  resolveMcpServerEnvironment,
} from './mcp-environment.ts'

export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}

export interface McpResourceDefinition {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface McpPromptDefinition {
  name: string
  description?: string
  arguments?: readonly {
    name: string
    description?: string
    required?: boolean
  }[]
}

export interface McpResourceReadResult {
  contents: readonly unknown[]
}

export interface McpPromptReadResult {
  description?: string
  messages: readonly unknown[]
}

export interface McpConnection {
  readonly name: string
  readonly available: boolean
  readonly maxOutputChars: number
  listCachedTools(): readonly McpToolDefinition[]
  getCachedTool(name: string): McpToolDefinition | null
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: AbortOptions
  ): Promise<unknown>
  listResources(
    options?: AbortOptions
  ): Promise<readonly McpResourceDefinition[]>
  readResource(
    uri: string,
    options?: AbortOptions
  ): Promise<McpResourceReadResult>
  listPrompts(options?: AbortOptions): Promise<readonly McpPromptDefinition[]>
  getPrompt(
    name: string,
    args: Record<string, string>,
    options?: AbortOptions
  ): Promise<McpPromptReadResult>
  close(): Promise<void>
}

export type McpConnector = (
  name: string,
  config: McpServerConfig,
  options: ConnectMcpServerOptions
) => Promise<McpConnection>

export interface ConnectMcpServerOptions extends AbortOptions {
  configDirectory: string
  environment?: NodeJS.ProcessEnv
}

export class McpConnectionError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'McpConnectionError'
  }
}

export class McpToolOutcomeUnknownError extends Error {
  public constructor(public readonly reason: string) {
    super(reason)
    this.name = 'McpToolOutcomeUnknownError'
  }
}

export class McpToolResponseError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'McpToolResponseError'
  }
}

export async function connectMcpServer(
  name: string,
  sourceConfig: McpServerConfig,
  options: ConnectMcpServerOptions
): Promise<McpConnection> {
  let redactions: readonly string[] = []
  let client: Client | null = null
  try {
    const resolved = resolveMcpServerEnvironment(
      sourceConfig,
      options.configDirectory,
      options.environment
    )
    redactions = resolved.redactions
    const config = resolved.config
    let refreshTools: (() => Promise<void>) | null = null
    client = new Client(
      { name: 'portal', version: '1.0.0' },
      {
        capabilities: {},
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 50,
            onChanged: () => {
              void refreshTools?.().catch(() => {})
            },
          },
        },
      }
    )
    const transport = createTransport(config)
    if (!isTransport(transport)) {
      throw new Error('MCP SDK returned an invalid client transport.')
    }
    const connection = new SdkMcpConnection(name, client, config, redactions)
    refreshTools = async () => await connection.refreshTools()
    await client.connect(transport, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      timeout: config.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS,
    })
    await connection.initializeTools(options)
    return connection
  } catch (error) {
    await client?.close().catch(() => {})
    throw new McpConnectionError(redactMcpError(error, redactions))
  }
}

function isTransport(value: unknown): value is Transport {
  return (
    typeof value === 'object' &&
    value !== null &&
    'start' in value &&
    typeof value.start === 'function' &&
    'send' in value &&
    typeof value.send === 'function' &&
    'close' in value &&
    typeof value.close === 'function'
  )
}

class SdkMcpConnection implements McpConnection {
  private tools = new Map<string, McpToolDefinition>()
  private connected = true
  private closed = false

  public readonly maxOutputChars: number
  private readonly initializationTimeoutMs: number
  private readonly requestTimeoutMs: number

  public constructor(
    public readonly name: string,
    private readonly client: Client,
    config: McpServerConfig,
    private readonly redactions: readonly string[]
  ) {
    this.initializationTimeoutMs =
      config.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS
    this.requestTimeoutMs = config.toolTimeoutMs ?? DEFAULT_MCP_TOOL_TIMEOUT_MS
    this.maxOutputChars = config.maxOutputChars ?? DEFAULT_MCP_MAX_OUTPUT_CHARS
    this.client.onclose = () => {
      this.connected = false
    }
    this.client.onerror = () => {}
  }

  public get available(): boolean {
    return this.connected && !this.closed
  }

  public async initializeTools(options: AbortOptions = {}): Promise<void> {
    if (this.client.getServerCapabilities()?.tools === undefined) {
      this.tools = new Map()
      return
    }
    await this.refreshTools(options, this.initializationTimeoutMs)
  }

  public async refreshTools(
    options: AbortOptions = {},
    timeoutMs = this.requestTimeoutMs
  ): Promise<void> {
    if (!this.available) {
      return
    }
    const nextTools = new Map<string, McpToolDefinition>()
    let cursor: string | undefined
    do {
      const result = await this.client.listTools(
        cursor === undefined ? undefined : { cursor },
        this.requestOptions(options, timeoutMs)
      )
      for (const tool of result.tools) {
        nextTools.set(tool.name, {
          name: tool.name,
          ...(tool.description !== undefined
            ? { description: tool.description }
            : {}),
          inputSchema: tool.inputSchema,
          ...(tool.outputSchema !== undefined
            ? { outputSchema: tool.outputSchema }
            : {}),
        })
      }
      cursor = result.nextCursor
    } while (cursor !== undefined)
    this.tools = nextTools
  }

  public listCachedTools(): readonly McpToolDefinition[] {
    return [...this.tools.values()].sort((left, right) =>
      left.name.localeCompare(right.name)
    )
  }

  public getCachedTool(name: string): McpToolDefinition | null {
    return this.tools.get(name) ?? null
  }

  public async callTool(
    name: string,
    args: Record<string, unknown>,
    options: AbortOptions = {}
  ): Promise<unknown> {
    try {
      return await this.client.callTool(
        { name, arguments: args },
        undefined,
        this.requestOptions(options)
      )
    } catch (error) {
      const errorCode = error instanceof McpError ? Number(error.code) : null
      if (
        error instanceof McpError &&
        errorCode !== Number(ErrorCode.ConnectionClosed) &&
        errorCode !== Number(ErrorCode.RequestTimeout)
      ) {
        throw new McpToolResponseError(
          redactMcpError(error.message, this.redactions)
        )
      }
      throw new McpToolOutcomeUnknownError(describeUnknownOutcome(error))
    }
  }

  public async listResources(
    options: AbortOptions = {}
  ): Promise<readonly McpResourceDefinition[]> {
    if (this.client.getServerCapabilities()?.resources === undefined) {
      return []
    }
    return await this.safeRequest(async () => {
      const resources: McpResourceDefinition[] = []
      let cursor: string | undefined
      do {
        const result = await this.client.listResources(
          cursor === undefined ? undefined : { cursor },
          this.requestOptions(options)
        )
        resources.push(
          ...result.resources.map((resource) => ({
            uri: resource.uri,
            name: resource.name,
            ...(resource.description !== undefined
              ? { description: resource.description }
              : {}),
            ...(resource.mimeType !== undefined
              ? { mimeType: resource.mimeType }
              : {}),
          }))
        )
        cursor = result.nextCursor
      } while (cursor !== undefined)
      return resources
    })
  }

  public async readResource(
    uri: string,
    options: AbortOptions = {}
  ): Promise<McpResourceReadResult> {
    return await this.safeRequest(async () => {
      const result = await this.client.readResource(
        { uri },
        this.requestOptions(options)
      )
      return { contents: result.contents }
    })
  }

  public async listPrompts(
    options: AbortOptions = {}
  ): Promise<readonly McpPromptDefinition[]> {
    if (this.client.getServerCapabilities()?.prompts === undefined) {
      return []
    }
    return await this.safeRequest(async () => {
      const prompts: McpPromptDefinition[] = []
      let cursor: string | undefined
      do {
        const result = await this.client.listPrompts(
          cursor === undefined ? undefined : { cursor },
          this.requestOptions(options)
        )
        prompts.push(
          ...result.prompts.map((prompt) => ({
            name: prompt.name,
            ...(prompt.description !== undefined
              ? { description: prompt.description }
              : {}),
            ...(prompt.arguments !== undefined
              ? {
                  arguments: prompt.arguments.map((argument) => ({
                    name: argument.name,
                    ...(argument.description !== undefined
                      ? { description: argument.description }
                      : {}),
                    ...(argument.required !== undefined
                      ? { required: argument.required }
                      : {}),
                  })),
                }
              : {}),
          }))
        )
        cursor = result.nextCursor
      } while (cursor !== undefined)
      return prompts
    })
  }

  public async getPrompt(
    name: string,
    args: Record<string, string>,
    options: AbortOptions = {}
  ): Promise<McpPromptReadResult> {
    return await this.safeRequest(async () => {
      const result = await this.client.getPrompt(
        { name, arguments: args },
        this.requestOptions(options)
      )
      return {
        ...(result.description !== undefined
          ? { description: result.description }
          : {}),
        messages: result.messages,
      }
    })
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    this.connected = false
    await this.client.close()
  }

  private requestOptions(
    options: AbortOptions,
    timeout = this.requestTimeoutMs
  ) {
    return {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      timeout,
    }
  }

  private async safeRequest<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request()
    } catch (error) {
      throw new McpConnectionError(redactMcpError(error, this.redactions))
    }
  }
}

function createTransport(config: McpServerConfig) {
  if (config.transport === 'streamable-http') {
    let url: URL
    try {
      url = new URL(config.url)
    } catch {
      throw new Error('HTTP server URL is invalid after environment expansion')
    }
    return new StreamableHTTPClientTransport(url, {
      ...(config.headers !== undefined
        ? { requestInit: { headers: config.headers } }
        : {}),
    })
  }

  const transport = new StdioClientTransport({
    command: config.command,
    ...(config.args !== undefined ? { args: config.args } : {}),
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    ...(config.env !== undefined
      ? { env: { ...getDefaultEnvironment(), ...config.env } }
      : {}),
    stderr: 'pipe',
  })
  transport.stderr?.on('data', () => {})
  return transport
}

function describeUnknownOutcome(error: unknown): string {
  if (error instanceof McpError) {
    const errorCode = Number(error.code)
    if (errorCode === Number(ErrorCode.RequestTimeout)) {
      return 'The MCP request timed out.'
    }
    if (errorCode === Number(ErrorCode.ConnectionClosed)) {
      return 'The MCP connection closed before a result was received.'
    }
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return 'The MCP request was cancelled before a result was received.'
  }
  return 'The MCP request failed after dispatch without a definitive result.'
}
