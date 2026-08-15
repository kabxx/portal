import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { resolveEnvironmentPlaceholders } from '../shared/environment-placeholders.ts'
import {
  isBearerAuthenticationEnabled,
  parseBearerToken,
} from '../shared/http-auth.ts'
import { normalizeListenerStartError } from '../shared/listener-errors.ts'
import { assertListenerTokenPolicy } from '../shared/listener-security.ts'
import type { PortalMcpHandlers } from './mcp-server-types.ts'
import { createPortalMcpProtocolServer } from './mcp-tools.ts'

export interface PortalMcpServerOptions {
  host: string
  port: number
  token: string | null
  handlers: PortalMcpHandlers
  bodyLimitBytes?: number
  closeTimeoutMs?: number
  onStop?: () => Promise<void>
  environment?: NodeJS.ProcessEnv
}

export function resolvePortalMcpToken(
  environment: NodeJS.ProcessEnv = process.env
): string | null {
  const token = environment.PORTAL_MCP_TOKEN
  return token === undefined || token === '' ? null : token
}

interface ActiveRequest {
  controller: AbortController
  server: McpServer
  transport: StreamableHTTPServerTransport
}

export class PortalMcpStopTimeoutError extends Error {
  public constructor(public readonly timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms while stopping Portal MCP resources.`)
    this.name = 'PortalMcpStopTimeoutError'
  }
}

export class PortalMcpListenerCloseTimeoutError extends Error {
  public constructor(public readonly timeoutMs: number) {
    super(
      `Timed out after ${timeoutMs}ms while closing the Portal MCP listener.`
    )
    this.name = 'PortalMcpListenerCloseTimeoutError'
  }
}

export class PortalMcpServer {
  private fastify: FastifyInstance | null = null
  private readonly activeRequests = new Set<ActiveRequest>()
  private lifecycleTail: Promise<void> = Promise.resolve()
  private started = false
  private stopping = false
  private activeToken: string | null = null

  public constructor(private readonly options: PortalMcpServerOptions) {}

  public status(): { running: boolean; address: string | null; auth: boolean } {
    return {
      running: this.started,
      address: this.address(),
      auth: isBearerAuthenticationEnabled(
        this.started ? this.activeToken : this.options.token
      ),
    }
  }

  public start(): Promise<void> {
    return this.enqueueLifecycle(async () => {
      if (this.started) {
        return
      }
      const token = resolveListenerToken(
        this.options.token,
        this.options.environment
      )
      assertListenerTokenPolicy('Portal MCP Server', this.options.host, token)
      const candidate = this.createFastify(token)
      try {
        await candidate.listen({
          host: this.options.host,
          port: this.options.port,
        })
      } catch (error) {
        await candidate.close().catch(() => {})
        throw normalizeListenerStartError(
          error,
          'MCP Server',
          this.options.host,
          this.options.port
        )
      }
      this.fastify = candidate
      this.activeToken = token
      this.started = true
    })
  }

  public stop(): Promise<void> {
    return this.enqueueLifecycle(async () => {
      if (!this.started || this.fastify === null) {
        return
      }

      this.stopping = true
      const fastify = this.fastify
      const closeTimeoutMs = this.options.closeTimeoutMs ?? 3_000
      const closeDeadline = Date.now() + closeTimeoutMs
      try {
        for (const request of this.activeRequests) {
          request.controller.abort()
        }
        const errors: unknown[] = []
        await collectStopErrors(
          errors,
          [
            async () => await this.options.onStop?.(),
            ...[...this.activeRequests].flatMap((request) => [
              async () => await request.transport.close(),
              async () => await request.server.close(),
            ]),
          ],
          remainingTime(closeDeadline)
        )
        try {
          await closeFastify(fastify, remainingTime(closeDeadline))
        } catch (error) {
          errors.push(error)
        }
        if (errors.length > 0) {
          throw new AggregateError(
            errors,
            'Portal MCP Server failed to stop cleanly.'
          )
        }
      } finally {
        this.activeRequests.clear()
        this.fastify = null
        this.activeToken = null
        this.started = false
        this.stopping = false
      }
    })
  }

  public address(): string | null {
    const address = this.fastify?.server.address()
    if (
      address === undefined ||
      address === null ||
      typeof address === 'string'
    ) {
      return null
    }
    const host = address.address.includes(':')
      ? `[${address.address}]`
      : address.address
    return `http://${host}:${address.port}/mcp`
  }

  private createFastify(token: string | null): FastifyInstance {
    const fastify = Fastify({
      logger: false,
      bodyLimit: this.options.bodyLimitBytes ?? 256 * 1024,
      requestTimeout: 0,
    })

    fastify.addHook('onRequest', async (request, reply) => {
      if (this.stopping) {
        return sendJsonRpcError(reply, 503, -32000, 'MCP Server is stopping.')
      }
      if (request.headers.origin !== undefined) {
        return sendJsonRpcError(
          reply,
          403,
          -32000,
          'Browser Origin requests are not allowed.'
        )
      }
      if (
        isBearerAuthenticationEnabled(token) &&
        parseBearerToken(request.headers.authorization) !== token
      ) {
        return sendJsonRpcError(reply, 401, -32000, 'Invalid MCP token.')
      }
    })

    fastify.post<{ Body: unknown }>('/mcp', async (request, reply) => {
      const controller = new AbortController()
      const server = createPortalMcpProtocolServer(
        this.options.handlers,
        controller.signal
      )
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
      })
      if (!isTransport(transport)) {
        throw new Error('MCP SDK returned an invalid server transport.')
      }
      const active = { controller, server, transport } satisfies ActiveRequest
      const abort = () => controller.abort()
      this.activeRequests.add(active)
      request.raw.once('aborted', abort)
      reply.raw.once('close', abort)
      reply.hijack()
      try {
        await server.connect(transport)
        await transport.handleRequest(request.raw, reply.raw, request.body)
      } finally {
        request.raw.off('aborted', abort)
        reply.raw.off('close', abort)
        this.activeRequests.delete(active)
        await transport.close().catch(() => {})
        await server.close().catch(() => {})
      }
    })

    const methodNotAllowed = async (_request: unknown, reply: FastifyReply) => {
      reply.header('Allow', 'POST')
      return sendJsonRpcError(reply, 405, -32000, 'Method not allowed.')
    }
    fastify.get('/mcp', methodNotAllowed)
    fastify.delete('/mcp', methodNotAllowed)

    fastify.setErrorHandler((error, _request, reply) => {
      if (reply.sent) {
        return
      }
      const mapped = mapFastifyError(error)
      sendJsonRpcError(reply, mapped.statusCode, mapped.code, mapped.message)
    })
    return fastify
  }

  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const result = this.lifecycleTail.then(operation)
    this.lifecycleTail = result.catch(() => {})
    return result
  }
}

function resolveListenerToken(
  token: string | null,
  environment: NodeJS.ProcessEnv | undefined
): string | null {
  return token === null
    ? null
    : resolveEnvironmentPlaceholders(token, environment ?? process.env)
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

function mapFastifyError(error: unknown): {
  statusCode: number
  code: number
  message: string
} {
  const fastifyCode =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : null
  switch (fastifyCode) {
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_CONTENT_LENGTH':
      return { statusCode: 400, code: -32700, message: 'Parse error.' }
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return {
        statusCode: 413,
        code: -32600,
        message: 'Request body is too large.',
      }
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return {
        statusCode: 415,
        code: -32600,
        message: 'Unsupported media type.',
      }
    case null:
    default:
      return {
        statusCode: 500,
        code: -32603,
        message: 'Internal server error.',
      }
  }
}

function sendJsonRpcError(
  reply: FastifyReply,
  statusCode: number,
  code: number,
  message: string
): FastifyReply {
  return reply.code(statusCode).send({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  })
}

async function closeFastify(
  fastify: FastifyInstance,
  timeoutMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const closed = fastify.close()
  try {
    const completed = await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
    if (!completed) {
      const timeoutError = new PortalMcpListenerCloseTimeoutError(timeoutMs)
      try {
        fastify.server.closeAllConnections()
      } catch (error) {
        throw new AggregateError(
          [timeoutError, error],
          'Portal MCP listener timed out and forced connection cleanup failed.',
          { cause: error }
        )
      } finally {
        void closed.catch(() => {})
      }
      throw timeoutError
    }
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<
  | { readonly completed: true; readonly value: T }
  | { readonly completed: false }
> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise.then((value) => ({ completed: true as const, value })),
      new Promise<{ readonly completed: false }>((resolve) => {
        timer = setTimeout(() => resolve({ completed: false }), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
    void promise.catch(() => {})
  }
}

async function collectStopErrors(
  errors: unknown[],
  operations: readonly (() => unknown)[],
  timeoutMs: number
): Promise<void> {
  const tracked = operations.map(async (operation) => {
    try {
      await Promise.resolve().then(operation)
    } catch (error) {
      errors.push(error)
    }
  })
  const result = await settleWithin(Promise.all(tracked), timeoutMs)
  if (!result.completed) {
    errors.push(new PortalMcpStopTimeoutError(timeoutMs))
  }
}

function remainingTime(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}
