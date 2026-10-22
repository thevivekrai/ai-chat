import { describe, expect, it } from 'vitest'
import { keyFromHint } from './whatsapp.ts'

describe('keys of messages the server no longer keeps', () => {
  it('are rebuilt from what the device knows', () => {
    const direct = 'wa:919812345678@s.whatsapp.net'
    expect(keyFromHint(direct, { id: `${direct}:ABC`, senderId: direct })).toEqual({
      remoteJid: '919812345678@s.whatsapp.net',
      fromMe: false,
      id: 'ABC',
    })
    expect(keyFromHint(direct, { id: `${direct}:MINE`, senderId: 'me' })).toMatchObject({ fromMe: true, id: 'MINE' })

    // In groups, the key names who wrote it.
    const group = 'wa:120363000000@g.us'
    expect(keyFromHint(group, { id: `${group}:G1`, senderId: 'wa:919800000001@s.whatsapp.net' })).toEqual({
      remoteJid: '120363000000@g.us',
      fromMe: false,
      id: 'G1',
      participant: '919800000001@s.whatsapp.net',
    })
  })

  it('are refused for messages of another chat', () => {
    expect(keyFromHint('wa:1@s.whatsapp.net', { id: 'wa:2@s.whatsapp.net:X', senderId: 'me' })).toBeNull()
  })
})
