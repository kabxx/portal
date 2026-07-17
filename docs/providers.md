# Providers

[Back to README](../README.md)

Adding or maintaining an integration? Follow the end-to-end [Provider Development](provider-development.md) guide.

portal supports seven web AI products through provider-specific adapters. Every adapter drives the normal website in a real Chromium page; portal does not call provider model APIs.

## Support matrix

| Provider id | Website             | Resume history | Upload | Model syntax        | Capabilities                              |
| ----------- | ------------------- | -------------- | ------ | ------------------- | ----------------------------------------- |
| `chatgpt`   | `chatgpt.com`       | Yes            | Yes    | `N` or `N+M`        | Page actions when the action group exists |
| `gemini`    | `gemini.google.com` | Yes            | Yes    | `N` or `N+extended` | Dynamic page actions                      |
| `deepseek`  | `chat.deepseek.com` | Yes            | Yes    | `N`                 | `thinking`, `search`                      |
| `doubao`    | `www.doubao.com`    | Yes            | Yes    | `N`                 | Dynamic page actions                      |
| `grok`      | `grok.com`          | Yes            | Yes    | `N`                 | None exposed by `/thread capability`      |
| `glm`       | `chat.z.ai`         | Yes            | Yes    | `N`                 | `thinking`, `search`, `advanced_search`   |
| `kimi`      | `www.kimi.com`      | Yes            | Yes    | `N`                 | None exposed by `/thread capability`      |

`N` and `M` are one-based positions in the menus visible to the current account. They are not stable model identifiers. Provider experiments, subscription state, and regional differences can change both menu order and capability availability.

`gpt` is accepted as a command alias for `chatgpt`; the other provider ids are used as shown.

## Opening a conversation

```text
/thread open <provider> [model]
```

Examples:

```text
/thread open glm
/thread open deepseek 2
/thread open chatgpt 1+2
/thread open gemini 1+extended
/thread open kimi 1
```

When the model argument is omitted, portal leaves the provider's current/default selection unchanged. Opening a new thread creates a page, verifies login and composer readiness, connects the current MCP configuration, snapshots enabled Skills, sends the portal setup prompt, and requires a case-insensitive whole-word `READY` token in the response.

If login is required, portal keeps the same adapter page open and waits for the user to complete authentication in the browser.

## Conversation URLs

`/thread resume` accepts HTTPS URLs with these forms and normalizes supported aliases:

| Provider | Accepted form                                     |
| -------- | ------------------------------------------------- |
| ChatGPT  | `https://chatgpt.com/c/<conversation-id>`         |
| Gemini   | `https://gemini.google.com/app/<conversation-id>` |
| DeepSeek | `https://chat.deepseek.com/a/chat/s/<id>`         |
| Doubao   | `https://www.doubao.com/chat/<conversation-id>`   |
| Grok     | `https://grok.com/chat/<id>` or `/c/<id>`         |
| GLM      | `https://chat.z.ai/c/<conversation-id>`           |
| Kimi     | `https://www.kimi.com/chat/<conversation-id>`     |

ChatGPT `chat.openai.com` links normalize to `chatgpt.com`; Doubao links without `www` and Gemini ids prefixed with `c_` are also normalized.

portal rejects unsupported schemes, hosts, and page types before opening a runtime. It also prevents the same normalized conversation URL from being opened twice in one portal process.

## Capability controls

List capabilities on the active thread:

```text
/thread capability
```

DeepSeek and GLM expose toggle-style controls:

```text
/thread capability thinking status
/thread capability search on
/thread capability advanced_search off
```

`advanced_search` is GLM-only. A toggle is omitted when the current page does not expose it or exposes it as disabled.

ChatGPT, Gemini, and Doubao expose action-style controls discovered from the current page:

```text
/thread capability <action-name>
/thread capability none
```

Action names are account- and page-dependent. `none` clears the selected action when the adapter supports clearing. Grok currently returns no capability controls.

## Response capture

Adapters use different provider completion signals:

| Provider | Main final-response path                                       |
| -------- | -------------------------------------------------------------- |
| ChatGPT  | Captured HTTP/SSE plus WebSocket frames and text stabilization |
| Gemini   | Captured `StreamGenerate` responses                            |
| DeepSeek | Completion SSE and explicit finished state                     |
| Doubao   | Completion SSE plus provider error events                      |
| Grok     | WebSocket chunks ending in `response.done`                     |
| GLM      | Completion stream events with answer/reasoning separation      |
| Kimi     | Connect JSON patches ending in `MESSAGE_STATUS_COMPLETED`      |

Every adapter separately verifies composer readiness after completion. Submit polling can emit status warnings when a provider request has not started, and adapter errors are classified for bounded retry, page restore, login wait, or terminal failure.

Grok treats the unique visible Voice Mode control in its Composer as the Ready signal. An editable Grok input alone is not sufficient because it can appear before the rest of the query controls have finished loading.

## Resume history

Resume skips the setup handshake and lets the provider page restore its own conversation context. portal then listens to the page's history responses and maps the current visible branch into a common message form:

```ts
interface ConversationHistoryMessage {
  id: string
  parentId: string | null
  role: 'user' | 'assistant'
  text: string
  format: 'plain' | 'markdown'
  createdAt: number | null
}
```

The provider-specific history paths currently include:

| Provider | History source                                                                            |
| -------- | ----------------------------------------------------------------------------------------- |
| ChatGPT  | Conversation mapping graph, followed from `current_node`                                  |
| Gemini   | `hNvQHb` batchexecute payloads, loaded until the continuation cursor is empty             |
| DeepSeek | `history_messages`; `MERGE` cache deltas trigger an authenticated `REPLACE` snapshot read |
| Doubao   | Paginated `chain/single` responses, loaded until `has_more=false`                         |
| Grok     | `response-node` graph joined with `load-responses` bodies and root/leaf checks            |
| GLM      | Chat metadata/current node joined with accumulated `messages/batch` pages                 |
| Kimi     | Newest-first `ListMessages` rows; a full 100-message page remains explicitly incomplete   |

The adapter base installs page and one-time CDP history capture before resume navigation. It waits briefly for delayed history requests, reads only matching response bodies, restores browser cache behavior, and releases the CDP session after loading. Gemini, Doubao, and GLM drive the provider page toward older history while new pages make progress, with bounded total and per-page timeouts. Graph-based parsers mark history complete only after a verified root/active branch; ambiguous branches and missing response bodies remain incomplete.

Remote history is used only for terminal display. It is not submitted to the model again, written to SQLite, or inserted into `ThreadRegistry` turns. Hidden setup messages, tool nodes, reasoning blocks, control records, partial responses, and unsupported content are filtered. A parser or completeness problem appears as a Markdown warning while the resumed thread remains usable.

These history endpoints are private web implementation details, not public APIs. A provider redesign may require fixture updates and a real-profile browser check.

## Upload behavior

`attach_image` delegates to the active adapter's upload controls. All seven adapters implement file/image attachment, but the website can hide or disable upload for a particular model, account, conversation, or subscription. Some providers can fail silently after a file chooser interaction; the tool result therefore reports an attempted attachment rather than claiming the model received the file.

## Provider-specific setup

Most providers use the shared setup prompt. Grok receives an additional strict tool-boundary prompt because its native product features and local-tool behavior require stronger separation. That provider rule remains active after the `READY` handshake.

## Maintenance notes

- Prefer stable, language-independent selectors such as test ids, roles, data attributes, and protocol events.
- Keep login detection, composer readiness, request start, streaming, completion, and history parsing separate.
- Do not replace browser automation with provider model APIs.
- Add focused parser/fake-page tests for each reproduced provider failure.
- Verify real browser behavior when selectors or private response formats change.
- Never commit browser profiles, authentication headers, private conversation URLs, or raw personal conversation captures.

See [Provider Development](provider-development.md) for the integration workflow, [Contributing](contributing.md) for the repository change checklist, and [Security](security.md) for the browser/account trust boundary.
