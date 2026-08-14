# portal

**把网页 AI 产品变成具备本地工具能力的终端 Agent。**

[English](README.md)

Portal 会启动真实的 Chromium 系浏览器，通过正常网页界面驱动支持的 AI
产品。网页模型可以请求本地工具、接收执行结果，然后在同一个 Provider 会话中继续
工作。Portal 不会调用 Provider 的模型 API，也不会绕过账号、订阅、额度或服务条款。

Portal 支持 ChatGPT、Gemini、DeepSeek、豆包、Grok、GLM、Qwen 和 Kimi。
可用模型和页面能力取决于当前账号、地区、订阅和 Provider 页面。

## 核心能力

- 用同一套终端流程管理八个网页 Provider
- 保留浏览器登录状态和会话历史
- 执行本地命令、修改文件、附加图片和委派独立任务
- 可选的 Skills、Hooks 和工作目录项目指令
- 使用 `portal exec` 进行无 TUI 的单次执行
- 可选的入站 Portal MCP Server

## 环境要求

- Node.js 24 或更高版本；Windows 当前使用 Node.js 24.15.0，以兼容
  [nodejs/node#63638](https://github.com/nodejs/node/issues/63638)
- npm；从源码安装时还需要 Git
- Google Chrome 或其它受支持的 Chromium 系浏览器
- 需要使用的各 Provider 账号

Windows、macOS 和 Linux 都是支持的启动环境。

## 快速开始

全局安装 Portal，然后在需要它操作的工作区中启动：

```bash
npm install --global @kabxx/portal@latest
portal
```

创建 Agent thread，然后直接输入普通任务：

```text
/thread agent chatgpt
总结当前仓库，并找出风险最高的模块。
```

不启动 TUI，直接执行一次任务：

```bash
portal exec --provider chatgpt "总结当前仓库。"
```

运行 `portal config` 可以输出可选配置文件的路径。进入 TUI 后使用 `/help`
查看当前版本的命令索引。

> [!WARNING]
> Portal 不是沙箱。本地工具、Skills、Hooks 和 spawn worker 会使用 Portal
> 用户的权限运行，合法的模型工具调用在执行前没有人工确认步骤。处理敏感数据前请
> 阅读[安全说明](SECURITY.md)。

## 文档

- **用户指南：** [CLI](docs/user/cli.md)、
  [配置](docs/user/configuration.md)、
  [Providers](docs/user/providers.md)、
  [Skills](docs/user/skills.md)、[Hooks](docs/user/hooks.md)、
  [项目指令](docs/user/project-instructions.md)、
  [Portal MCP Server](docs/user/mcp-server.md)
- **开发文档：** [架构](docs/development/architecture.md)、
  [Provider 开发](docs/development/provider-development.md)、
  [测试](docs/development/testing.md)
- **项目文档：** [参与贡献](CONTRIBUTING.md)、[安全说明](SECURITY.md)

## 许可证

Portal 使用 [MIT License](LICENSE) 开源。

## 免责声明

Portal 是独立项目，与 OpenAI、Anthropic、Google、DeepSeek、字节跳动、xAI、
智谱 AI、月之暗面或其网页产品不存在隶属、赞助或官方认可关系。使用者需要自行遵守
Provider 条款和适用法律。
