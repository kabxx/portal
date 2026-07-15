import { randomUUID } from 'node:crypto'
import { abortable } from '../runtime/runtime-cancellation.ts'
import type { ThreadOperationHandle } from '../threads/thread-operation-coordinator.ts'
import type { PortalMcpMessageOperation } from './mcp-server-types.ts'

interface OperationRecord extends PortalMcpMessageOperation {
  createdAt: number
  finishedAt: number | null
  handle: ThreadOperationHandle | null
  resolveDone: () => void
  done: Promise<void>
  waiterActive: boolean
}

export interface McpMessageOperationStoreOptions {
  maxEntries?: number
  terminalTtlMs?: number
}

export class McpMessageOperationStore {
  private readonly operations = new Map<string, OperationRecord>()
  private readonly maxEntries: number
  private readonly terminalTtlMs: number

  public constructor(options: McpMessageOperationStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 100
    this.terminalTtlMs = options.terminalTtlMs ?? 10 * 60_000
  }

  public begin(threadId: string): PortalMcpMessageOperation {
    this.sweep()
    this.makeRoom()
    const operationId = randomUUID()
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    this.operations.set(operationId, {
      operationId,
      threadId,
      status: 'running',
      createdAt: Date.now(),
      finishedAt: null,
      handle: null,
      resolveDone,
      done,
      waiterActive: false,
    })
    return this.getSnapshot(operationId)
  }

  public attachHandle(
    operationId: string,
    handle: ThreadOperationHandle
  ): void {
    const operation = this.require(operationId)
    if (operation.status !== 'running') {
      throw new Error(`MCP message operation is not running: ${operationId}`)
    }
    operation.handle = handle
  }

  public remove(operationId: string): void {
    this.operations.delete(operationId)
  }

  public complete(operationId: string, assistant: string): void {
    this.finish(operationId, { status: 'completed', assistant })
  }

  public fail(operationId: string, error: string): void {
    this.finish(operationId, { status: 'failed', error })
  }

  public cancelled(operationId: string): void {
    this.finish(operationId, { status: 'cancelled' })
  }

  public get(operationId: string): PortalMcpMessageOperation {
    this.sweep()
    return this.getSnapshot(operationId)
  }

  public async wait(
    operationId: string,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<PortalMcpMessageOperation> {
    this.sweep()
    const operation = this.require(operationId)
    if (operation.status !== 'running' || timeoutMs === 0) {
      return this.toSnapshot(operation)
    }
    if (operation.waiterActive) {
      throw new Error(
        `MCP message operation already has an active waiter: ${operationId}`
      )
    }
    operation.waiterActive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      await abortable(
        Promise.race([
          operation.done,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs)
          }),
        ]),
        signal
      )
      return this.toSnapshot(operation)
    } finally {
      operation.waiterActive = false
      if (timer !== null) {
        clearTimeout(timer)
      }
    }
  }

  public async cancel(operationId: string): Promise<PortalMcpMessageOperation> {
    this.sweep()
    const operation = this.require(operationId)
    if (operation.status !== 'running') {
      return this.toSnapshot(operation)
    }
    if (operation.handle === null) {
      throw new Error(`MCP message operation is not ready: ${operationId}`)
    }
    await operation.handle.cancel()
    return this.toSnapshot(operation)
  }

  public async stopAll(): Promise<void> {
    await Promise.allSettled(
      [...this.operations.values()]
        .filter(
          (
            operation
          ): operation is OperationRecord & {
            handle: ThreadOperationHandle
          } => operation.status === 'running' && operation.handle !== null
        )
        .map(async (operation) => await operation.handle.cancel())
    )
    this.operations.clear()
  }

  private finish(
    operationId: string,
    result:
      | { status: 'completed'; assistant: string }
      | { status: 'failed'; error: string }
      | { status: 'cancelled' }
  ): void {
    const operation = this.require(operationId)
    if (operation.status !== 'running') {
      return
    }
    operation.status = result.status
    operation.finishedAt = Date.now()
    if (result.status === 'completed') {
      operation.assistant = result.assistant
    } else if (result.status === 'failed') {
      operation.error = result.error
    }
    operation.resolveDone()
  }

  private makeRoom(): void {
    while (this.operations.size >= this.maxEntries) {
      const oldestTerminal = [...this.operations.values()]
        .filter((operation) => operation.status !== 'running')
        .sort((left, right) => left.finishedAt! - right.finishedAt!)[0]
      if (oldestTerminal === undefined) {
        throw new Error('Too many running MCP message operations.')
      }
      this.operations.delete(oldestTerminal.operationId)
    }
  }

  private sweep(now = Date.now()): void {
    for (const operation of this.operations.values()) {
      if (
        operation.finishedAt !== null &&
        now - operation.finishedAt >= this.terminalTtlMs
      ) {
        this.operations.delete(operation.operationId)
      }
    }
  }

  private getSnapshot(operationId: string): PortalMcpMessageOperation {
    return this.toSnapshot(this.require(operationId))
  }

  private require(operationId: string): OperationRecord {
    const operation = this.operations.get(operationId)
    if (operation === undefined) {
      throw new Error(`Unknown MCP message operation: ${operationId}`)
    }
    return operation
  }

  private toSnapshot(operation: OperationRecord): PortalMcpMessageOperation {
    return {
      operationId: operation.operationId,
      threadId: operation.threadId,
      status: operation.status,
      ...(operation.assistant === undefined
        ? {}
        : { assistant: operation.assistant }),
      ...(operation.error === undefined ? {} : { error: operation.error }),
    }
  }
}
