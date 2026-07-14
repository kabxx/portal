import type { ProviderId } from './provider-id.ts'

export interface ResolvedConversationUrl {
  provider: ProviderId
  conversationUrl: string
}

export function resolveConversationUrl(
  value: string
): ResolvedConversationUrl | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (url.protocol !== 'https:') {
    return null
  }

  const resolved = resolveProviderFromUrl(url)
  if (resolved === null) {
    return null
  }

  return {
    provider: resolved.provider,
    conversationUrl: resolved.conversationUrl,
  }
}

function resolveProviderFromUrl(url: URL): ResolvedConversationUrl | null {
  if (
    (url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com') &&
    /^\/c\/[^/?#]+/.test(url.pathname)
  ) {
    const conversationId = readPathSegment(url, 1)
    return conversationId === null
      ? null
      : {
          provider: 'chatgpt',
          conversationUrl: `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`,
        }
  }

  if (
    url.hostname === 'gemini.google.com' &&
    /^\/app\/[^/?#]+/.test(url.pathname)
  ) {
    const conversationId = readPathSegment(url, 1)?.replace(/^c_/, '') ?? null
    return conversationId === null
      ? null
      : {
          provider: 'gemini',
          conversationUrl: `https://gemini.google.com/app/${encodeURIComponent(conversationId)}`,
        }
  }

  if (
    url.hostname === 'chat.deepseek.com' &&
    /^\/a\/chat\/s\/[^/?#]+/.test(url.pathname)
  ) {
    const conversationId = readPathSegment(url, 3)
    return conversationId === null
      ? null
      : {
          provider: 'deepseek',
          conversationUrl: `https://chat.deepseek.com/a/chat/s/${encodeURIComponent(conversationId)}`,
        }
  }

  if (
    (url.hostname === 'www.doubao.com' || url.hostname === 'doubao.com') &&
    /^\/chat\/[^/?#]+/.test(url.pathname)
  ) {
    const conversationId = readPathSegment(url, 1)
    return conversationId === null
      ? null
      : {
          provider: 'doubao',
          conversationUrl: `https://www.doubao.com/chat/${encodeURIComponent(conversationId)}`,
        }
  }

  if (
    url.hostname === 'grok.com' &&
    /^\/(?:chat|c)\/[^/?#]+/.test(url.pathname)
  ) {
    const conversationId = readPathSegment(url, 1)
    return conversationId === null
      ? null
      : {
          provider: 'grok',
          conversationUrl: `https://grok.com/chat/${encodeURIComponent(conversationId)}`,
        }
  }

  if (url.hostname === 'chat.z.ai' && /^\/c\/[^/?#]+/.test(url.pathname)) {
    const conversationId = readPathSegment(url, 1)
    return conversationId === null
      ? null
      : {
          provider: 'glm',
          conversationUrl: `https://chat.z.ai/c/${encodeURIComponent(conversationId)}`,
        }
  }

  return null
}

function readPathSegment(url: URL, index: number): string | null {
  const segment = url.pathname.split('/').filter(Boolean).at(index)
  return segment ? decodeURIComponent(segment) : null
}
