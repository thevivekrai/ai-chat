/**
 * A stand-in for Google's OAuth token endpoint and the Calendar events API, enough for the
 * calendar sync: tokens from a consent code and from the refresh token, events made, changed and
 * deleted, and access revoked.
 */

export const GOOD_CODE = 'consent-code'

export function fakeCalendar() {
  let issued = 0
  const state = {
    /** The refresh token still works (Google hasn't been told to stop). */
    refreshValid: true,
    /** Google Calendar is turning requests away (quota, rate limit). */
    busy: false,
    /** Events on the primary calendar, by id. */
    events: new Map<string, Record<string, any>>(),
    /** Tokens revoked. */
    revoked: [] as string[],
    /** The redirect URI the code was asked with, as Google checks it. */
    redirectUris: [] as string[],
  }

  const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`

  const call = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const form = new URLSearchParams(String(init?.body ?? ''))

    if (url.href.startsWith('https://oauth2.googleapis.com/token')) {
      if (form.get('grant_type') === 'authorization_code') {
        state.redirectUris.push(form.get('redirect_uri') ?? '')
        if (form.get('code') !== GOOD_CODE || !form.get('client_secret')) return json({ error: 'invalid_grant' }, 400)
        return json({ access_token: `at-${++issued}`, refresh_token: 'rt-1', expires_in: 3600, id_token: idToken('aarav@gmail.com') })
      }
      if (form.get('grant_type') === 'refresh_token') {
        if (!state.refreshValid || form.get('refresh_token') !== 'rt-1') return json({ error: 'invalid_grant' }, 400)
        return json({ access_token: `at-${++issued}`, expires_in: 3600 })
      }
      return json({ error: 'unsupported_grant_type' }, 400)
    }
    if (url.href.startsWith('https://oauth2.googleapis.com/revoke')) {
      state.revoked.push(url.searchParams.get('token') ?? '')
      return json({})
    }

    if (url.href.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events')) {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? ''
      if (!/^Bearer at-\d+$/.test(auth) || !state.refreshValid) return json({ error: { code: 401 } }, 401)
      if (state.busy) return json({ error: { code: 429, message: 'Rate Limit Exceeded' } }, 429)
      const id = decodeURIComponent(url.pathname.split('/events/')[1] ?? '')
      if (method === 'POST') {
        const eventId = `ev${state.events.size + 1}-${Date.now().toString(36)}`
        state.events.set(eventId, JSON.parse(String(init?.body)))
        return json({ id: eventId })
      }
      if (!state.events.has(id)) return json({ error: { code: 404 } }, 404)
      if (method === 'PUT') {
        state.events.set(id, JSON.parse(String(init?.body)))
        return json({ id })
      }
      if (method === 'DELETE') {
        state.events.delete(id)
        return json(null, 204)
      }
    }
    return json({ error: 'Not found' }, 404)
  }) as typeof fetch

  return { fetch: call, state }
}
