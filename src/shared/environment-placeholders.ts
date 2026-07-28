const ENVIRONMENT_PLACEHOLDER =
  /\$\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g

export function resolveEnvironmentPlaceholders(
  value: string,
  environment: NodeJS.ProcessEnv = process.env,
  onResolve?: (value: string) => void
): string {
  return value.replace(
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
        onResolve?.(resolved)
      }
      return resolved
    }
  )
}
