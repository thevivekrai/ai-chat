import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { storage } from '@/data/storage'
import { ME_ID } from '@/data/types'
import { eventually, installFakeTelegram } from '@/test/fakeTelegram'
import type { ConnectorEvent } from '../types'
import { DEFAULT_TELEGRAM_API, isBadToken } from './botApi'
import { TelegramConnector } from './telegramConnector'

let telegram: ReturnType<typeof installFakeTelegram>
let connector: TelegramConnector | null = null

function connect() {
  connector = new TelegramConnector({ token: telegram.token, apiBase: DEFAULT_TELEGRAM_API })
  const events: ConnectorEvent[] = []
  connector.subscribe((e) => events.push(e))
  connector.start()
  return { connector, events }
}

beforeEach(() => {
  storage.remove('tidings.telegram')
  telegram = installFakeTelegram()
})

afterEach(() => {
  connector?.stop()
  connector = null
  vi.unstubAllGlobals()
})

describe('Telegram connector', () => {
  it('checks a token before it is saved', async () => {
    await expect(TelegramConnector.verify({ token: telegram.token, apiBase: DEFAULT_TELEGRAM_API })).resolves.toMatchObject({
      username: 'mitti_bot',
    })
    const error = await TelegramConnector.verify({ token: 'nope', apiBase: DEFAULT_TELEGRAM_API }).catch((e: unknown) => e)
    expect(isBadToken(error)).toBe(true)
  })

  it('turns incoming messages into chats, contacts and messages', async () => {
    const { connector, events } = connect()
    const priya = telegram.person(42, 'Priya', { last_name: 'Nair', username: 'priya_n' })
    telegram.message(telegram.privateChat(priya), priya, { text: 'Is the indigo planter still available?' })

    await eventually(() => expect(events.some((e) => e.type === 'message.created')).toBe(true))
    expect(events.map((e) => e.type)).toEqual(['contact.updated', 'thread.updated', 'message.created'])
    expect(connector.status()).toMatchObject({ state: 'online', account: '@mitti_bot' })

    const snapshot = connector.snapshot()
    expect(snapshot.threads).toEqual([
      expect.objectContaining({ id: 'tg:42', kind: 'direct', title: 'Priya Nair', network: 'telegram', unreadCount: 1, participantIds: ['tg:u:42'] }),
    ])
    expect(snapshot.contacts).toEqual([expect.objectContaining({ id: 'tg:u:42', name: 'Priya Nair', handle: '@priya_n' })])
    expect(snapshot.messages[0]).toMatchObject({ threadId: 'tg:42', senderId: 'tg:u:42', body: 'Is the indigo planter still available?' })
    expect(snapshot.selfName).toBe('Mitti Studio')
  })

  it('handles groups, media and edits', async () => {
    const { connector, events } = connect()
    const group = { id: -100, type: 'supergroup' as const, title: 'Potters Circle' }
    const zoya = telegram.person(7, 'Zoya')
    const kabir = telegram.person(8, 'Kabir')
    telegram.message(group, zoya, { photo: [{}], caption: 'New glaze test' })
    const typo = telegram.message(group, kabir, { text: 'kiln at 5' })
    telegram.push({ edited_message: { ...typo, text: 'kiln at 6' } })

    await eventually(() => expect(events.some((e) => e.type === 'message.updated')).toBe(true))
    const snapshot = connector.snapshot()
    expect(snapshot.threads[0]).toMatchObject({ kind: 'group', title: 'Potters Circle', participantIds: ['tg:u:7', 'tg:u:8'] })
    expect(snapshot.messages.map((m) => m.body)).toEqual(['New glaze test', 'kiln at 6'])
    expect(snapshot.messages[0].attachments).toEqual([{ kind: 'image', name: 'Photo' }])
  })

  it('replies as the bot and keeps unread counts on this device', async () => {
    const { connector, events } = connect()
    const priya = telegram.person(42, 'Priya')
    telegram.message(telegram.privateChat(priya), priya, { text: 'Hello?' })
    await eventually(() => expect(events.length).toBeGreaterThan(0))

    const sent = await connector.sendMessage('tg:42', 'Yes, still available!')
    expect(telegram.sent).toEqual([{ chat_id: '42', text: 'Yes, still available!' }])
    expect(sent).toMatchObject({ threadId: 'tg:42', senderId: ME_ID, body: 'Yes, still available!', status: 'sent' })

    expect(await connector.markRead('tg:42')).toMatchObject({ unreadCount: 0 })
    expect(connector.snapshot().messages.map((m) => m.body)).toEqual(['Hello?', 'Yes, still available!'])
  })

  it('keeps chats across restarts without fetching old updates again', async () => {
    const first = connect()
    const priya = telegram.person(42, 'Priya')
    telegram.message(telegram.privateChat(priya), priya, { text: 'First' })
    await eventually(() => expect(first.events.length).toBeGreaterThan(0))
    first.connector.stop()

    const second = connect()
    expect(second.connector.snapshot().messages.map((m) => m.body)).toEqual(['First'])
    telegram.message(telegram.privateChat(priya), priya, { text: 'Second' })
    await eventually(() => expect(second.events.filter((e) => e.type === 'message.created')).toHaveLength(1))
    expect(second.connector.snapshot().messages.map((m) => m.body)).toEqual(['First', 'Second'])
  })

  it('offers to take over a bot that uses a webhook', async () => {
    telegram.state.webhook = true
    const { connector, events } = connect()
    await eventually(() => expect(connector.status().fix?.id).toBe('remove-webhook'))
    expect(connector.status().state).toBe('error')

    await connector.applyFix('remove-webhook')
    const priya = telegram.person(42, 'Priya')
    telegram.message(telegram.privateChat(priya), priya, { text: 'Hi' })
    await eventually(() => expect(events.some((e) => e.type === 'message.created')).toBe(true))
    expect(telegram.calls).toContain('deleteWebhook')
  })

  it('stops when the token is revoked', async () => {
    telegram.state.validToken = 'rotated'
    const { connector } = connect()
    await eventually(() => expect(connector.status().state).toBe('error'))
    expect(connector.status().detail).toMatch(/no longer accepts this bot token/)
  })
})
