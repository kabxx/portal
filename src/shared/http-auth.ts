export function isBearerAuthenticationEnabled(
  token: string | null
): token is string {
  return token !== null && token !== ''
}

export function parseBearerToken(header: string | undefined): string | null {
  const match = /^Bearer (.+)$/i.exec(header ?? '')
  return match?.[1] ?? null
}
