import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

/**
 * AES-256-GCM for data at rest: linked-account sessions, message contents and names. A copy of the
 * database alone (say, a leaked connection string) then reveals no chats.
 */
export interface Sealer {
  seal(plaintext: string): string
  open(sealed: string): string
  sealJson(value: unknown): string
  openJson<T>(sealed: string): T
  /** A keyed fingerprint of the text: always the same for it, and unguessable without the key. */
  tag(text: string): Buffer
}

const VERSION = 'v1'

export function createSealer(key: Buffer): Sealer {
  if (key.length !== 32) throw new Error('The data key must be 32 bytes')

  const seal = (plaintext: string) => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`
  }

  const open = (sealed: string) => {
    const [version, payload] = sealed.split(':', 2)
    if (version !== VERSION || !payload) throw new Error('Unknown sealed data format')
    const raw = Buffer.from(payload, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
  }

  return {
    seal,
    open,
    sealJson: (value) => seal(JSON.stringify(value)),
    openJson: <T>(sealed: string) => JSON.parse(open(sealed)) as T,
    tag: (text) => createHmac('sha256', key).update(`tag:${text}`).digest(),
  }
}
