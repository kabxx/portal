import { isBearerAuthenticationEnabled } from './http-auth.ts'

export function assertListenerTokenPolicy(
  listener: string,
  host: string,
  token: string | null
): void {
  if (host === '127.0.0.1' || isBearerAuthenticationEnabled(token)) {
    return
  }
  throw new Error(
    `${listener} requires a token when listening on a host other than 127.0.0.1.`
  )
}
