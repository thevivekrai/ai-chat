import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

/**
 * "Sign in with Google": the browser gets an ID token from Google's button and sends it here. It
 * is only trusted after its signature (Google's published keys), issuer, audience (our client id)
 * and expiry check out.
 */
export interface GoogleProfile {
  sub: string
  email: string
  emailVerified: boolean
  name?: string
  picture?: string
}

const GOOGLE_KEYS = 'https://www.googleapis.com/oauth2/v3/certs'
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

export function createGoogleVerifier(clientId: string, keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(GOOGLE_KEYS))) {
  return async function verifyGoogleIdToken(idToken: string): Promise<GoogleProfile> {
    const { payload } = await jwtVerify(idToken, keys, { issuer: ISSUERS, audience: clientId })
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
      throw new Error('The Google token has no account id or email')
    }
    return {
      sub: payload.sub,
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified === true || payload.email_verified === 'true',
      name: typeof payload.name === 'string' ? payload.name : undefined,
      picture: typeof payload.picture === 'string' ? payload.picture : undefined,
    }
  }
}

export type GoogleVerifier = ReturnType<typeof createGoogleVerifier>
