import Fastify, { type FastifyInstance } from 'fastify'
import type { ServerResponse } from 'node:http'
import { isBearerAuthenticationEnabled } from '../shared/http-auth.ts'
import {
  ApiHttpError,
  mapApiError,
  parseBearerToken,
  requireRecordBody,
} from './api-errors.ts'

export { ApiHttpError } from './api-errors.ts'

export interface ApiThreadSummary {
  id: string
  provider: string
  title: string | null
  conversationUrl: string
  busy: boolean
  createdAt: number
  updatedAt: number
}

export interface ApiHandlers {
  status(): unknown
  providers(): unknown
  listThreads(): unknown
  getThread(threadId: string): unknown
  createThread(input: Record<string, unknown>): Promise<unknown>
  resumeThread(input: Record<string, unknown>): Promise<unknown>
  closeThread(threadId: string): Promise<unknown>
  submitMessage(threadId: string, input: string): Promise<unknown>
  cancelMessage(threadId: string): Promise<unknown>
  reloadThread?: (threadId: string) => Promise<unknown>
  activateSkill(threadId: string, name: string): Promise<unknown>
  listCapabilities(threadId: string): Promise<unknown>
  setCapability(threadId: string, name: string, state: string): Promise<unknown>
  clearCapability(threadId: string, name: string): Promise<unknown>
  listSkills(): Promise<unknown>
  addSkill(input: Record<string, unknown>): Promise<unknown>
  setSkillEnabled(name: string, enabled: boolean): Promise<unknown>
  removeSkill(name: string): Promise<unknown>
  listMcpServers(): Promise<unknown>
  addMcpServer(name: string, config: unknown): Promise<unknown>
  setMcpServer(name: string, config: unknown): Promise<unknown>
  removeMcpServer(name: string): Promise<unknown>
  setMcpServerEnabled(name: string, enabled: boolean): Promise<unknown>
  listMcpResources(threadId: string, server?: string): Promise<unknown>
  listMcpPrompts(threadId: string, server?: string): Promise<unknown>
}

export interface ApiServerOptions {
  host: string
  port: number
  token: string | null
  handlers: ApiHandlers
  bodyLimitBytes?: number
  requestTimeoutMs?: number
  sseHeartbeatMs?: number
}

export interface ApiEvent {
  type:
    | 'message.started'
    | 'assistant.delta'
    | 'assistant.message'
    | 'status'
    | 'tool.started'
    | 'tool.output'
    | 'tool.completed'
    | 'message.completed'
    | 'message.failed'
    | 'message.cancelled'
    | 'thread.action'
    | 'hook.execution'
  data: unknown
}

interface Subscriber {
  response: ServerResponse
  heartbeat: ReturnType<typeof setInterval>
  onClose: () => void
  removed: boolean
}

export class ApiEventHub {
  private readonly subscribers = new Map<string, Set<Subscriber>>()
  private readonly sequences = new Map<string, number>()

  public constructor(private readonly heartbeatMs = 15_000) {}

  public publish(threadId: string, event: ApiEvent): void {
    const subscribers = this.subscribers.get(threadId)
    if (subscribers === undefined) {
      return
    }
    const id = (this.sequences.get(threadId) ?? 0) + 1
    this.sequences.set(threadId, id)
    const payload = JSON.stringify({
      threadId,
      ...(isRecord(event.data) ? event.data : { value: event.data }),
    })
    for (const subscriber of [...subscribers]) {
      try {
        subscriber.response.write(
          `id: ${id}\nevent: ${event.type}\ndata: ${payload}\n\n`
        )
      } catch {
        this.remove(threadId, subscriber)
      }
    }
  }

  public subscribe(threadId: string, response: ServerResponse): () => void {
    const subscriber = {
      response,
      onClose: () => this.remove(threadId, subscriber),
      removed: false,
      heartbeat: setInterval(() => {
        try {
          response.write(': heartbeat\n\n')
        } catch {
          this.remove(threadId, subscriber)
        }
      }, this.heartbeatMs),
    } satisfies Subscriber
    let subscribers = this.subscribers.get(threadId)
    if (subscribers === undefined) {
      subscribers = new Set()
      this.subscribers.set(threadId, subscribers)
    }
    subscribers.add(subscriber)
    response.once('close', subscriber.onClose)
    try {
      response.write(': connected\n\n')
    } catch {
      this.remove(threadId, subscriber)
    }
    return subscriber.onClose
  }

  public close(): void {
    for (const [threadId, subscribers] of this.subscribers) {
      for (const subscriber of [...subscribers]) {
        this.remove(threadId, subscriber)
      }
    }
    this.sequences.clear()
  }

  private remove(threadId: string, subscriber: Subscriber): void {
    if (subscriber.removed) {
      return
    }
    subscriber.removed = true
    clearInterval(subscriber.heartbeat)
    subscriber.response.off('close', subscriber.onClose)
    const subscribers = this.subscribers.get(threadId)
    subscribers?.delete(subscriber)
    if (subscribers?.size === 0) {
      this.subscribers.delete(threadId)
      this.sequences.delete(threadId)
    }
    if (!subscriber.response.writableEnded && !subscriber.response.destroyed) {
      try {
        subscriber.response.end()
      } catch {
        // The response may already be disconnected.
      }
    }
  }
}

export class PortalApiServer {
  private fastify: FastifyInstance | null = null
  private readonly events: ApiEventHub
  private started = false

  public constructor(private readonly options: ApiServerOptions) {
    this.events = new ApiEventHub(options.sseHeartbeatMs)
    this.fastify = this.createFastify()
  }

  public get eventHub(): ApiEventHub {
    return this.events
  }

  public get isStarted(): boolean {
    return this.started
  }

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
    const fastify = this.fastify ?? this.createFastify()
    this.fastify = fastify
    await fastify.listen({
      host: this.options.host,
      port: this.options.port,
    })
    this.started = true
  }

  public async stop(): Promise<void> {
    if (!this.started || this.fastify === null) {
      return
    }
    this.events.close()
    const fastify = this.fastify
    try {
      await fastify.close()
    } finally {
      this.fastify = null
      this.started = false
    }
  }

  public address(): string | null {
    const fastify = this.fastify
    if (fastify === null) {
      return null
    }
    const address = fastify.server.address()
    if (address === null || typeof address === 'string') {
      return null
    }
    const host = address.address.includes(':')
      ? `[${address.address}]`
      : address.address
    return `http://${host}:${address.port}`
  }

  private createFastify(): FastifyInstance {
    const fastify = Fastify({
      logger: false,
      bodyLimit: this.options.bodyLimitBytes ?? 256 * 1024,
      requestTimeout: this.options.requestTimeoutMs ?? 0,
    })
    this.registerRoutes(fastify)
    return fastify
  }

  private registerRoutes(fastify: FastifyInstance): void {
    fastify.addHook('onRequest', async (request, _reply) => {
      if (
        request.routeOptions.url === '/health' ||
        !isBearerAuthenticationEnabled(this.options.token)
      ) {
        return
      }
      const provided = parseBearerToken(request.headers.authorization)
      if (provided !== this.options.token) {
        throw new ApiHttpError(401, 'AUTH_INVALID', 'Invalid API token.')
      }
    })

    fastify.setErrorHandler((error, _request, reply) => {
      const mapped = mapApiError(error)
      void reply
        .code(mapped.statusCode)
        .send({ error: { code: mapped.code, message: mapped.message } })
    })

    fastify.get('/health', async () => ({
      ok: true,
      service: 'portal',
      apiVersion: 'v1',
    }))
    fastify.get('/v1/status', async () => await this.options.handlers.status())
    fastify.get(
      '/v1/providers',
      async () => await this.options.handlers.providers()
    )
    fastify.get(
      '/v1/threads',
      async () => await this.options.handlers.listThreads()
    )
    fastify.get<{ Params: { threadId: string } }>(
      '/v1/threads/:threadId',
      async (request) =>
        await this.options.handlers.getThread(request.params.threadId)
    )
    fastify.post<{ Body: unknown }>('/v1/threads', async (request, reply) => {
      const body = requireRecordBody(request.body)
      return await reply
        .code(201)
        .send(await this.options.handlers.createThread(body))
    })
    fastify.post<{ Body: unknown }>(
      '/v1/threads/resume',
      async (request, reply) => {
        const body = requireRecordBody(request.body)
        return await reply
          .code(201)
          .send(await this.options.handlers.resumeThread(body))
      }
    )
    fastify.delete<{ Params: { threadId: string } }>(
      '/v1/threads/:threadId',
      async (request) =>
        await this.options.handlers.closeThread(request.params.threadId)
    )
    fastify.post<{
      Params: { threadId: string }
      Body: { input?: unknown }
    }>('/v1/threads/:threadId/messages', async (request, reply) => {
      const body = requireRecordBody(request.body)
      if (typeof body.input !== 'string' || body.input.trim() === '') {
        throw new ApiHttpError(
          400,
          'INVALID_REQUEST',
          'input must be a non-empty string.'
        )
      }
      const result = await this.options.handlers.submitMessage(
        request.params.threadId,
        body.input
      )
      return await reply.code(202).send(result)
    })
    fastify.post<{ Params: { threadId: string } }>(
      '/v1/threads/:threadId/cancel',
      async (request) =>
        await this.options.handlers.cancelMessage(request.params.threadId)
    )
    fastify.post<{ Params: { threadId: string } }>(
      '/v1/threads/:threadId/reload',
      async (request, reply) => {
        if (this.options.handlers.reloadThread === undefined) {
          throw new ApiHttpError(
            501,
            'NOT_SUPPORTED',
            'Thread reload is not available.'
          )
        }
        return await reply
          .code(202)
          .send(
            await this.options.handlers.reloadThread(request.params.threadId)
          )
      }
    )
    fastify.get<{ Params: { threadId: string } }>(
      '/v1/threads/:threadId/events',
      async (request, reply) => {
        await this.options.handlers.getThread(request.params.threadId)
        reply.hijack()
        const response = reply.raw
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        })
        const remove = this.events.subscribe(request.params.threadId, response)
        request.raw.on('close', remove)
      }
    )
    fastify.post<{
      Params: { threadId: string }
      Body: { name?: unknown }
    }>('/v1/threads/:threadId/skill', async (request, reply) => {
      const body = requireRecordBody(request.body)
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        throw new ApiHttpError(
          400,
          'INVALID_REQUEST',
          'name must be a non-empty string.'
        )
      }
      const result = await this.options.handlers.activateSkill(
        request.params.threadId,
        body.name
      )
      return await reply.code(202).send(result)
    })
    fastify.get<{ Params: { threadId: string } }>(
      '/v1/threads/:threadId/capabilities',
      async (request) =>
        await this.options.handlers.listCapabilities(request.params.threadId)
    )
    fastify.put<{
      Params: { threadId: string; name: string }
      Body: { state?: unknown }
    }>('/v1/threads/:threadId/capabilities/:name', async (request) => {
      const body = requireRecordBody(request.body)
      if (typeof body.state !== 'string') {
        throw new ApiHttpError(400, 'INVALID_REQUEST', 'state is required.')
      }
      return await this.options.handlers.setCapability(
        request.params.threadId,
        request.params.name,
        body.state
      )
    })
    fastify.delete<{ Params: { threadId: string; name: string } }>(
      '/v1/threads/:threadId/capabilities/:name',
      async (request) =>
        await this.options.handlers.clearCapability(
          request.params.threadId,
          request.params.name
        )
    )
    fastify.get(
      '/v1/skills',
      async () => await this.options.handlers.listSkills()
    )
    fastify.post<{ Body: unknown }>('/v1/skills', async (request, reply) => {
      const body = requireRecordBody(request.body)
      if (typeof body.source !== 'string' || body.source.trim() === '') {
        throw new ApiHttpError(400, 'INVALID_REQUEST', 'source is required.')
      }
      if (
        body.registryUrl !== undefined &&
        typeof body.registryUrl !== 'string'
      ) {
        throw new ApiHttpError(
          400,
          'INVALID_REQUEST',
          'registryUrl must be a string.'
        )
      }
      return await reply
        .code(201)
        .send(await this.options.handlers.addSkill(body))
    })
    fastify.put<{ Params: { name: string }; Body: { enabled?: unknown } }>(
      '/v1/skills/:name',
      async (request) => {
        const body = requireRecordBody(request.body)
        if (typeof body.enabled !== 'boolean') {
          throw new ApiHttpError(400, 'INVALID_REQUEST', 'enabled is required.')
        }
        return await this.options.handlers.setSkillEnabled(
          request.params.name,
          body.enabled
        )
      }
    )
    fastify.delete<{ Params: { name: string } }>(
      '/v1/skills/:name',
      async (request) =>
        await this.options.handlers.removeSkill(request.params.name)
    )
    fastify.get(
      '/v1/mcp/servers',
      async () => await this.options.handlers.listMcpServers()
    )
    fastify.post<{ Body: unknown }>(
      '/v1/mcp/servers',
      async (request, reply) => {
        const body = requireRecordBody(request.body)
        const name = body.name
        if (typeof name !== 'string' || name.trim() === '') {
          throw new ApiHttpError(400, 'INVALID_REQUEST', 'name is required.')
        }
        const { name: _ignored, ...config } = body
        return await reply
          .code(201)
          .send(await this.options.handlers.addMcpServer(name, config))
      }
    )
    fastify.put<{
      Params: { name: string }
      Body: { enabled?: unknown; config?: unknown }
    }>('/v1/mcp/servers/:name', async (request) => {
      const body = requireRecordBody(request.body)
      if (typeof body.enabled === 'boolean') {
        return await this.options.handlers.setMcpServerEnabled(
          request.params.name,
          body.enabled
        )
      }
      if (body.config === undefined) {
        throw new ApiHttpError(
          400,
          'INVALID_REQUEST',
          'enabled or config is required.'
        )
      }
      return await this.options.handlers.setMcpServer(
        request.params.name,
        body.config
      )
    })
    fastify.delete<{ Params: { name: string } }>(
      '/v1/mcp/servers/:name',
      async (request) =>
        await this.options.handlers.removeMcpServer(request.params.name)
    )
    fastify.get<{
      Params: { threadId: string }
      Querystring: { server?: string }
    }>(
      '/v1/threads/:threadId/mcp/resources',
      async (request) =>
        await this.options.handlers.listMcpResources(
          request.params.threadId,
          request.query.server
        )
    )
    fastify.get<{
      Params: { threadId: string }
      Querystring: { server?: string }
    }>(
      '/v1/threads/:threadId/mcp/prompts',
      async (request) =>
        await this.options.handlers.listMcpPrompts(
          request.params.threadId,
          request.query.server
        )
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
