import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'
import type { PortalMcpHandlers } from './mcp-server-types.ts'

const threadSchema = z.object({
  id: z.string(),
  provider: z.string(),
  title: z.string().nullable(),
  conversationUrl: z.string(),
  busy: z.boolean(),
  turnCount: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

const operationSchema = z.object({
  operationId: z.string(),
  threadId: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  assistant: z.string().optional(),
  error: z.string().optional(),
})

const jobSchema = z.object({
  id: z.string(),
  pid: z.number().int().nullable(),
  command: z.string(),
  cwd: z.string(),
  shell: z.enum(['powershell', 'cmd', 'bash', 'zsh', 'fish', 'sh']),
  startedAt: z.number(),
  state: z.enum(['running', 'stopping']),
})

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

export function createPortalMcpProtocolServer(
  handlers: PortalMcpHandlers,
  requestSignal: AbortSignal
): McpServer {
  const server = new McpServer({ name: 'portal', version: '1.0.0' })

  server.registerTool(
    'portal_list_providers',
    {
      title: 'List Portal Providers',
      description: 'List provider ids supported by the running Portal process.',
      outputSchema: z.object({ providers: z.array(z.string()) }),
      annotations: readOnlyAnnotations,
    },
    async () => await runTool(async () => await handlers.listProviders())
  )

  server.registerTool(
    'portal_list_threads',
    {
      title: 'List Portal Threads',
      description: 'List active threads in the running Portal process.',
      outputSchema: z.object({ threads: z.array(threadSchema) }),
      annotations: readOnlyAnnotations,
    },
    async () => await runTool(async () => await handlers.listThreads())
  )

  if (handlers.listJobs !== undefined && handlers.stopJob !== undefined) {
    server.registerTool(
      'portal_list_jobs',
      {
        title: 'List Portal Command Jobs',
        description:
          'List active run_command jobs in the running Portal process. Command and working-directory values may be sensitive.',
        outputSchema: z.object({ jobs: z.array(jobSchema) }),
        annotations: readOnlyAnnotations,
      },
      async () => await runTool(async () => await handlers.listJobs!())
    )

    server.registerTool(
      'portal_stop_job',
      {
        title: 'Stop Portal Command Job',
        description:
          'Stop one active run_command job and wait for its process tree to settle.',
        inputSchema: z.object({ jobId: z.string().regex(/\S/) }),
        outputSchema: z.object({
          stopped: z.literal(true),
          jobId: z.string(),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ jobId }, extra) =>
        await runTool(
          async () =>
            await handlers.stopJob!(
              jobId,
              AbortSignal.any([requestSignal, extra.signal])
            )
        )
    )
  }

  server.registerTool(
    'portal_get_thread',
    {
      title: 'Get Portal Thread',
      description: 'Get one active Portal thread by id.',
      inputSchema: z.object({ threadId: z.string().min(1) }),
      outputSchema: threadSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ threadId }) =>
      await runTool(async () => await handlers.getThread(threadId))
  )

  const agentModes = handlers.listAgentModes()
  const defaultAgentMode = agentModes.includes('agent')
    ? 'agent'
    : agentModes[0]
  if (defaultAgentMode !== undefined) {
    const modeSchema =
      agentModes.length === 2
        ? z.enum(['agent', 'chat'])
        : defaultAgentMode === 'agent'
          ? z.literal('agent')
          : z.literal('chat')
    server.registerTool(
      'portal_create_thread',
      {
        title: 'Create Portal Thread',
        description:
          'Create and initialize a new browser-backed Portal thread. This may wait for browser login.',
        inputSchema: z.object({
          provider: z.string().min(1),
          model: z
            .string()
            .nullable()
            .optional()
            .describe('Named model key; omit to keep the provider default.'),
          option: z
            .string()
            .nullable()
            .optional()
            .describe('Named option key for the selected model.'),
          mode: modeSchema.optional(),
        }),
        outputSchema: threadSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ provider, model, option, mode }, extra) =>
        await runTool(
          async () =>
            await handlers.createThread(
              {
                provider,
                model: model ?? null,
                option: option ?? null,
                mode: mode ?? defaultAgentMode,
              },
              AbortSignal.any([requestSignal, extra.signal])
            )
        )
    )
  }

  server.registerTool(
    'portal_resume_thread',
    {
      title: 'Resume Portal Thread',
      description:
        'Resume an existing provider conversation in a browser-backed Portal thread.',
      inputSchema: z.object({ conversationUrl: z.string().min(1) }),
      outputSchema: threadSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ conversationUrl }, extra) =>
      await runTool(
        async () =>
          await handlers.resumeThread(
            conversationUrl,
            AbortSignal.any([requestSignal, extra.signal])
          )
      )
  )

  server.registerTool(
    'portal_close_thread',
    {
      title: 'Close Portal Thread',
      description:
        'Cancel any active operation and close an active Portal thread.',
      inputSchema: z.object({ threadId: z.string().min(1) }),
      outputSchema: z.object({ closed: z.literal(true), threadId: z.string() }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ threadId }) =>
      await runTool(async () => await handlers.closeThread(threadId))
  )

  server.registerTool(
    'portal_send_message',
    {
      title: 'Send Portal Message',
      description:
        'Start one message in an active Portal thread and return an operation id immediately.',
      inputSchema: z.object({
        threadId: z.string().min(1),
        input: z.string().min(1),
      }),
      outputSchema: operationSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ threadId, input }) =>
      await runTool(async () => await handlers.sendMessage(threadId, input))
  )

  server.registerTool(
    'portal_wait_message',
    {
      title: 'Wait For Portal Message',
      description:
        'Wait up to timeoutSeconds for a Portal message operation. Call again while status is running.',
      inputSchema: z.object({
        operationId: z.string().min(1),
        timeoutSeconds: z.number().int().min(0).max(30).default(30),
      }),
      outputSchema: operationSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ operationId, timeoutSeconds }, extra) =>
      await runTool(
        async () =>
          await handlers.waitMessage(
            operationId,
            timeoutSeconds * 1000,
            AbortSignal.any([requestSignal, extra.signal])
          )
      )
  )

  server.registerTool(
    'portal_cancel_message',
    {
      title: 'Cancel Portal Message',
      description:
        'Cancel the exact Portal message operation identified by operationId. Cancellation cannot undo prior side effects.',
      inputSchema: z.object({ operationId: z.string().min(1) }),
      outputSchema: operationSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ operationId }) =>
      await runTool(async () => await handlers.cancelMessage(operationId))
  )

  return server
}

async function runTool<T extends Record<string, unknown>>(
  operation: () => Promise<T> | T
): Promise<CallToolResult> {
  try {
    const result = await operation()
    return {
      structuredContent: result,
      content: [{ type: 'text', text: JSON.stringify(result) }],
    }
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: error instanceof Error ? error.message : String(error),
        },
      ],
    }
  }
}
