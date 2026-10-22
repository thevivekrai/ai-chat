import { jwtVerify, SignJWT } from 'jose'

/** The sign-in session: a signed token in an httpOnly cookie, so page scripts can't read it. */
export const SESSION_COOKIE = 'tidings_session'
export const SESSION_DAYS = 30

const ISSUER = 'tidings'

export function createSessionTokens(secret: string) {
  const key = new TextEncoder().encode(secret)
  return {
    async sign(userId: string): Promise<string> {
      return new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(userId)
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime(`${SESSION_DAYS}d`)
        .sign(key)
    },

    /** Who the token is for and when it was issued (Unix seconds); null if missing, expired or forged. */
    async verify(token: string | undefined): Promise<{ userId: string; issuedAt: number } | null> {
      if (!token) return null
      try {
        const { payload } = await jwtVerify(token, key, { issuer: ISSUER, algorithms: ['HS256'] })
        return typeof payload.sub === 'string' && typeof payload.iat === 'number' ? { userId: payload.sub, issuedAt: payload.iat } : null
      } catch {
        return null
      }
    },
  }
}

export type SessionTokens = ReturnType<typeof createSessionTokens>
