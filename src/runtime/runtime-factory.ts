import type {
  ProviderAdapter,
  ProviderAdapterOptions,
} from '../providers/adapters/adapter-base.ts'
import { isProviderAdapterError } from '../providers/adapters/adapter-base.ts'
import type { ToolServices } from '../tools/core/tool-definition.ts'
import { ToolRegistry } from '../tools/core/tool-registry.ts'
import { AttachImageTool } from '../tools/builtins/attach-image-tool.ts'
import { ApplyPatchTool } from '../tools/builtins/apply-patch-tool.ts'
import { RunCommandTool } from '../tools/builtins/run-command-tool.ts'
import { SpawnTool } from '../tools/builtins/spawn-tool.ts'
import { LoadSkillTool } from '../tools/builtins/load-skill-tool.ts'
import { McpSearchTool } from '../tools/builtins/mcp-search-tool.ts'
import { McpCallTool } from '../tools/builtins/mcp-call-tool.ts'
import type { SkillLibrary } from '../skills/skill-library.ts'
import type { McpLibrary } from '../mcp/mcp-library.ts'
import type { McpConnector } from '../mcp/mcp-connection.ts'
import {
  createThreadMcpSession,
  type McpSessionWarning,
  type ThreadMcpSession,
} from '../mcp/thread-mcp-session.ts'
import { RuntimeCore } from './runtime-core.ts'
import { throwIfAborted } from './runtime-cancellation.ts'
import type { ProjectInstructions } from '../instructions/project-instructions.ts'
import type { HookDispatcher } from '../hooks/hook-dispatcher.ts'

export interface RuntimeFactoryOptions extends ProviderAdapterOptions {
  providerPrompt?: string | null
  toolServices?: ToolServices
  skillLibrary?: SkillLibrary
  mcpLibrary?: McpLibrary
  mcpConnector?: McpConnector
  onMcpWarning?: (warning: McpSessionWarning) => void | Promise<void>
  projectInstructions?: ProjectInstructions | null
  hookDispatcher?: HookDispatcher | null
  allowedTools?: readonly string[] | null
}

const DEFAULT_TOOLS = [
  AttachImageTool,
  RunCommandTool,
  ApplyPatchTool,
  SpawnTool,
]

export async function createRuntimeFromAdapter(
  adapter: ProviderAdapter,
  options: RuntimeFactoryOptions = { model: null }
): Promise<RuntimeCore> {
  const { signal } = options
  let mcpSession: ThreadMcpSession | null = null

  try {
    if (options.mcpLibrary !== undefined) {
      mcpSession = await createThreadMcpSession(options.mcpLibrary, {
        ...(options.mcpConnector !== undefined
          ? { connector: options.mcpConnector }
          : {}),
        ...(options.onMcpWarning !== undefined
          ? { onWarning: options.onMcpWarning }
          : {}),
        ...(signal !== undefined ? { signal } : {}),
      })
    }
    const skillCatalog = await options.skillLibrary?.createCatalogSnapshot()
    const hasSkills = skillCatalog !== undefined && skillCatalog.size > 0
    const manualSkillLoader =
      hasSkills && skillCatalog !== undefined
        ? async (name: string) => await skillCatalog.load(name)
        : null
    const hasMcp = mcpSession?.hasAvailableConnections === true
    const availableTools = [
      ...DEFAULT_TOOLS,
      ...(hasSkills ? [LoadSkillTool] : []),
      ...(hasMcp ? [McpSearchTool, McpCallTool] : []),
    ]
    const allowedTools = options.allowedTools ?? null
    const tools =
      allowedTools === null
        ? availableTools
        : availableTools.filter((ToolClass) => {
            const tool = new ToolClass(adapter, {})
            return allowedTools.includes(tool.name)
          })
    if (allowedTools !== null) {
      const selected = new Set(
        tools.map((ToolClass) => new ToolClass(adapter, {}).name)
      )
      const unavailable = allowedTools.filter((name) => !selected.has(name))
      if (unavailable.length > 0)
        throw new Error(
          `Hook requested unavailable tools: ${unavailable.join(', ')}`
        )
    }
    const services: ToolServices = {
      ...(options.toolServices ?? {}),
      ...(hasSkills
        ? {
            loadSkill: async (name: string) => {
              try {
                const loaded = await skillCatalog.load(name)
                if (loaded === null) {
                  return `[ERROR] Skill is not available in this runtime: ${name}`
                }
                return {
                  result: {
                    name: loaded.name,
                    directory: loaded.directory,
                    resources: [...loaded.resources],
                    instructions: loaded.instructions,
                  },
                  displayText: `Loaded skill: ${loaded.name}`,
                }
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : String(error)
                return `[ERROR] ${message}`
              }
            },
          }
        : {}),
      ...(hasMcp
        ? {
            mcpSearchTool: async (server: string, tool: string) =>
              mcpSession!.searchTool(server, tool),
            mcpCallTool: async (
              input: {
                server: string
                tool: string
                arguments: Record<string, unknown>
              },
              callOptions = {}
            ) =>
              await mcpSession!.callTool(
                input.server,
                input.tool,
                input.arguments,
                callOptions
              ),
          }
        : {}),
    }
    const toolRegistry = new ToolRegistry(adapter, tools, services)
    const runtime = new RuntimeCore(
      adapter,
      toolRegistry,
      options.providerPrompt ?? null,
      skillCatalog?.prompt ?? null,
      mcpSession?.prompt ?? null,
      mcpSession,
      manualSkillLoader,
      options.projectInstructions ?? null,
      skillCatalog?.names ?? [],
      options.hookDispatcher ?? null
    )
    throwIfAborted(signal)
    if (options.model !== null) {
      await adapter.changeModel(options.model)
    }
    throwIfAborted(signal)
    if (options.skipSetup !== true) {
      await runtime.init({ signal })
    }
    throwIfAborted(signal)
    return runtime
  } catch (error) {
    if (isProviderAdapterError(error) && error.kind === 'auth') {
      await mcpSession?.close().catch(() => {})
      error.adapter = adapter
      throw error
    }
    await mcpSession?.close().catch(() => {})
    await adapter.close().catch(() => {})
    throw error
  }
}
