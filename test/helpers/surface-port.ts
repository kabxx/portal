import type { SurfacePort } from '../../src/surfaces/surface-port.ts'
import type {
  ThreadHandle,
  ThreadManager,
} from '../../src/threads/thread-manager.ts'

export function createTestSurfacePort(manager: ThreadManager): SurfacePort {
  const toSurfaceThread = (thread: ThreadHandle) => ({
    id: thread.id,
    provider: thread.provider,
    title: thread.title,
    conversationUrl: thread.runtime.conversationUrl,
    busy: false,
    turnCount: thread.turnCount,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  })

  return {
    listThreads: () => manager.listThreads().map(toSurfaceThread),
    getThread: (threadId) => {
      const thread = manager.getThread(threadId)
      return thread === null ? null : toSurfaceThread(thread)
    },
    getActiveThread: () => {
      const thread = manager.getActiveThread()
      return thread === null ? null : toSurfaceThread(thread)
    },
    switchThread: (threadId) => {
      const thread = manager.switchThread(threadId)
      return thread === null ? null : toSurfaceThread(thread)
    },
  }
}
