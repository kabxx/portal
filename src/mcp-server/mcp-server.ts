import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import {
  isBearerAuthenticationEnabled,
  parseBearerToken,
} from '../shared/http-auth.ts'
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
}

interface ActiveRequest {
  controller: AbortController
  server: McpServer
  transport: StreamableHTTPServerTransport
}

export class PortalMcpServer {
  private fastify: FastifyInstance | null = null
  private readonly activeRequests = new Set<ActiveRequest>()
  private started = false
  private stopping = false
  private stopPromise: Promise<void> | null = null

  public constructor(private readonly options: PortalMcpServerOptions) {}

  public token(): string | null {
    return this.options.token
  }

  public status(): { running: boolean; address: string | null; auth: boolean } {
    return {
      running: this.started,
      address: this.address(),
      auth: isBearerAuthenticationEnabled(this.options.token),
    }
  }

  public async start(): Promise<void> {
    if (this.started) {
      return
    }
    if (this.stopPromise !== null) {
      await this.stopPromise
    }
    const fastify = this.createFastify()
    await fastify.listen({ host: this.options.host, port: this.options.port })
    this.fastify = fastify
    this.stopping = false
    this.started = true
  }

  public async stop(): Promise<void> {
    if (this.stopPromise !== null) {
      return await this.stopPromise
    }
    if (!this.started || this.fastify === null) {
      return
    }

    this.stopping = true
    this.started = false
    const fastify = this.fastify
    this.fastify = null
    this.stopPromise = (async () => {
      const closeTimeoutMs = this.options.closeTimeoutMs ?? 3_000
      for (const request of this.activeRequests) {
        request.controller.abort()
      }
      await settleWithin(
        Promise.allSettled([
          Promise.resolve().then(async () => await this.options.onStop?.()),
          ...[...this.activeRequests].flatMap((request) => [
            request.transport.close(),
            request.server.close(),
          ]),
        ]).then(() => {}),
        closeTimeoutMs
      )
      await closeFastify(fastify, closeTimeoutMs)
      this.activeRequests.clear()
    })().finally(() => {
      this.stopping = false
      this.stopPromise = null
    })
    return await this.stopPromise
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

  private createFastify(): FastifyInstance {
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
        isBearerAuthenticationEnabled(this.options.token) &&
        parseBearerToken(request.headers.authorization) !== this.options.token
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
      const active = { controller, server, transport } satisfies ActiveRequest
      const abort = () => controller.abort()
      this.activeRequests.add(active)
      request.raw.once('aborted', abort)
      reply.raw.once('close', abort)
      reply.hijack()
      try {
        await server.connect(transport as Transport)
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
      fastify.server.closeAllConnections()
      void closed.catch(() => {})
    }
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}

async function settleWithin(
  promise: Promise<void>,
  timeoutMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
    void promise.catch(() => {})
  }
}
