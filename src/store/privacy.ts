import { useSession } from './session'
import { useSettings } from './settings'

/**
 * Incognito mode: reading a chat sends no read receipt, and typing shows no "typing…". Signed in,
 * it's the account's setting (every device, and the server, go by it); otherwise this device's.
 */
export function incognitoOn(): boolean {
  const user = useSession.getState().user
  return user ? !!user.incognito : useSettings.getState().incognito
}

export function useIncognito(): boolean {
  const account = useSession((s) => (s.user ? !!s.user.incognito : null))
  const device = useSettings((s) => s.incognito)
  return account ?? device
}
