# portal

**Turn web AI products into local, tool-using terminal agents.**

[简体中文](README.zh-CN.md)

Portal launches a real Chromium-based browser and drives supported AI products
through their normal websites. The web model can request local tools, receive
their results, and continue in the same provider conversation. Portal does not
call provider model APIs or bypass provider accounts, subscriptions, usage
limits, or terms.

Portal supports ChatGPT, Gemini, DeepSeek, Doubao, Grok, GLM, Qwen, and Kimi.
Available models and page capabilities depend on the current account, region,
subscription, and provider UI.

## Capabilities

- One terminal workflow for eight web providers
- Persistent browser login and conversation history
- Local commands, file patches, images, and focused child tasks
- Optional Skills, Hooks, and working-directory project instructions
- Headless one-task execution with `portal exec`
- An optional inbound Portal MCP Server

## Requirements

- Node.js 24 or newer; Windows currently uses Node.js 24.15.0 for compatibility
  with [nodejs/node#63638](https://github.com/nodejs/node/issues/63638)
- npm; Git is also required when installing from source
- Google Chrome or another supported Chromium-based browser
- A valid account for each provider you use

Windows, macOS, and Linux are supported launch environments.

## Quick start

Install Portal globally and start it in the workspace it should use:

```bash
npm install --global @kabxx/portal@latest
portal
```

Create an agent thread, then enter a normal task:

```text
/thread agent chatgpt
Summarize this repository and identify its highest-risk module.
```

Run one task without starting the TUI:

```bash
portal exec --provider chatgpt "Summarize this repository."
```

Run `portal config` to print the optional configuration file path. Use `/help`
inside the TUI for the live command index.

> [!WARNING]
> Portal is not a sandbox. Local tools, Skills, Hooks, and spawned workers use
> the permissions of the Portal user, and valid model-generated tool calls do
> not have a human approval gate. Read [Security](SECURITY.md) before using
> Portal with sensitive data.

## Documentation

- **User guides:** [CLI](docs/user/cli.md),
  [Configuration](docs/user/configuration.md),
  [Providers](docs/user/providers.md),
  [Skills](docs/user/skills.md), [Hooks](docs/user/hooks.md),
  [Project Instructions](docs/user/project-instructions.md),
  [Portal MCP Server](docs/user/mcp-server.md)
- **Development:** [Architecture](docs/development/architecture.md),
  [Provider Development](docs/development/provider-development.md),
  [Testing](docs/development/testing.md)
- **Project:** [Contributing](CONTRIBUTING.md), [Security](SECURITY.md)

## License

Portal is available under the [MIT License](LICENSE).

## Disclaimer

Portal is an independent project and is not affiliated with, endorsed by, or
sponsored by OpenAI, Anthropic, Google, DeepSeek, ByteDance, xAI, Zhipu AI,
Moonshot AI, or the supported web products. Users are responsible for complying
with provider terms and applicable law.
