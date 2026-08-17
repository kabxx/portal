import type { BrowserContext } from 'playwright'

import { createServiceRef } from '../extensions/extension-contracts.ts'

export interface PortalBrowserSession {
  readonly context: BrowserContext
  readonly profileDirectory: string
}

export interface PortalBrowserSessionService {
  current(): PortalBrowserSession
}

export const portalBrowserSessionService =
  createServiceRef<PortalBrowserSessionService>({
    id: 'portal.kernel.browser-session',
    version: 1,
    scope: 'portal',
  })

export class PortalBrowserSessionHost implements PortalBrowserSessionService {
  #session: PortalBrowserSession | null = null

  public bind(session: PortalBrowserSession): () => void {
    if (this.#session !== null) {
      throw new Error('Portal browser session is already bound.')
    }
    this.#session = Object.freeze({ ...session })
    return () => {
      if (this.#session?.context === session.context) this.#session = null
    }
  }

  public current(): PortalBrowserSession {
    if (this.#session === null) {
      throw new Error('Portal browser session is not active.')
    }
    return this.#session
  }
}
