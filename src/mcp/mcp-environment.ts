import path from 'path'
import type { McpServerConfig } from './mcp-config.ts'

export interface ResolvedMcpServerConfig {
  config: McpServerConfig
  redactions: readonly string[]
}

const ENVIRONMENT_PLACEHOLDER =
  /\$\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g

export function resolveMcpServerEnvironment(
  config: McpServerConfig,
  configDirectory: string,
  environment: NodeJS.ProcessEnv = process.env
): ResolvedMcpServerConfig {
  const redactions = new Set<string>()
  const resolve = (value: string): string =>
    value.replace(
      ENVIRONMENT_PLACEHOLDER,
      (_match, escapedName: string | undefined, environmentName: string) => {
        if (escapedName !== undefined) {
          return `\${env:${escapedName}}`
        }
        const resolved = environment[environmentName]
        if (resolved === undefined) {
          throw new Error(`Environment variable is not set: ${environmentName}`)
        }
        if (resolved !== '') {
          redactions.add(resolved)
        }
        return resolved
      }
    )

  if (config.transport === 'streamable-http') {
    const headers = mapStringRecord(config.headers, (value) => {
      const resolved = resolve(value)
      if (resolved !== '') {
        redactions.add(resolved)
      }
      return resolved
    })
    return {
      config: {
        ...config,
        url: resolve(config.url),
        ...(headers !== undefined ? { headers } : {}),
      },
      redactions: [...redactions],
    }
  }

  const cwdValue = config.cwd === undefined ? undefined : resolve(config.cwd)
  const cwd =
    cwdValue === undefined || path.isAbsolute(cwdValue)
      ? cwdValue
      : path.resolve(configDirectory, cwdValue)
  const env = mapStringRecord(config.env, (value) => {
    const resolved = resolve(value)
    if (resolved !== '') {
      redactions.add(resolved)
    }
    return resolved
  })
  return {
    config: {
      ...config,
      command: resolve(config.command),
      ...(config.args !== undefined
        ? { args: config.args.map((argument) => resolve(argument)) }
        : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(env !== undefined ? { env } : {}),
    },
    redactions: [...redactions],
  }
}

export function redactMcpError(
  error: unknown,
  redactions: readonly string[] = []
): string {
  let message = error instanceof Error ? error.message : String(error)
  for (const secret of [...redactions].sort(
    (left, right) => right.length - left.length
  )) {
    if (secret.length > 0) {
      message = message.split(secret).join('[REDACTED]')
    }
  }
  message = message.replace(/https?:\/\/\S+/gi, '[REDACTED_URL]')
  return message.length <= 500 ? message : `${message.slice(0, 497)}...`
}

function mapStringRecord(
  value: Record<string, string> | undefined,
  mapValue: (value: string) => string
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, mapValue(item)])
  )
}
