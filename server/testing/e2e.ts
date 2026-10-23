/**
 * The app wired to fake WhatsApp and Telegram, for clicking through linking in a browser:
 *
 *   npm run build && TEST_MONGODB_URI=mongodb://127.0.0.1:27017 npx tsx server/testing/e2e.ts
 *
 * The app is on http://127.0.0.1:5180. A control port (5181) plays the phone's part:
 *   POST /whatsapp/linked             the code was entered: the link opens and history arrives
 *   POST /whatsapp/message {"text"}   a new WhatsApp message
 *   POST /whatsapp/typing             Ravi starts typing
 *   POST /whatsapp/older              the phone sends older messages (after "Load earlier")
 *   POST /whatsapp/burst {"count"}    that many WhatsApp messages at once
 *   POST /whatsapp/photo {"caption"}  Ravi sends a photo
 *   POST /whatsapp/file               Ravi sends a PDF
 *   POST /telegram/message {"text"}   a new Telegram message
 *   POST /telegram/scan               the Telegram QR code is scanned
 *   POST /trim                        the server trims chats to what it keeps, now
 * Telegram's login code is 12345 and the two-step password hunter2.
 */
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { mediaMessage, startTestServer, TEST_MONGODB_URI } from './helpers.ts'

if (!TEST_MONGODB_URI) throw new Error('Set TEST_MONGODB_URI')

const server = await startTestServer({ port: 5180, staticDir: resolve('dist') })
const now = () => Math.floor(Date.now() / 1000)
const RAVI = '919812345678@s.whatsapp.net'

async function whatsappLinked() {
  const socket = server.sockets.at(-1)!
  socket.authState.creds.registered = true
  socket.emit('creds.update', {})
  socket.emit('connection.update', { connection: 'close', lastDisconnect: { error: Object.assign(new Error('restart'), { output: { statusCode: 515 } }), date: new Date() } })
  await new Promise((r) => setTimeout(r, 50))
  const linked = server.sockets.at(-1)!
  linked.user = { id: '919876543210:4@s.whatsapp.net' }
  linked.emit('connection.update', { connection: 'open' })
  const ts = now()
  linked.emit('messaging-history.set', {
    chats: [{ id: RAVI, unreadCount: 1 }, { id: '120363000000@g.us', name: 'Mehta family', unreadCount: 2 }],
    contacts: [{ id: RAVI, name: 'Ravi Kumar' }],
    messages: [
      { key: { remoteJid: RAVI, fromMe: true, id: 'M0' }, message: { conversation: 'Sent the parcel on Monday 📦' }, messageTimestamp: ts - 7200, status: 4 },
      {
        key: { remoteJid: RAVI, fromMe: false, id: 'M1' },
        message: {
          extendedTextMessage: {
            text: 'Did it arrive? Tracking says delivered but nobody has it here',
            contextInfo: { stanzaId: 'M0', participant: '919876543210@s.whatsapp.net', quotedMessage: { conversation: 'Sent the parcel on Monday 📦' } },
          },
        },
        messageTimestamp: ts - 600,
      },
      { key: { remoteJid: RAVI, fromMe: false, id: 'R1' }, message: { reactionMessage: { key: { remoteJid: RAVI, fromMe: true, id: 'M0' }, text: '🙏' } }, messageTimestamp: ts - 590 },
      {
        key: { remoteJid: '120363000000@g.us', fromMe: false, id: 'G1', participant: '919800000001@s.whatsapp.net' },
        message: { extendedTextMessage: { text: 'Dinner at 8 tonight, everyone okay?' } },
        messageTimestamp: ts - 1800,
        pushName: 'Papa',
      },
      {
        key: { remoteJid: '120363000000@g.us', fromMe: false, id: 'G2', participant: '919800000002@s.whatsapp.net' },
        message: { conversation: 'Yes! I will get dessert 🍰' },
        messageTimestamp: ts - 1500,
        pushName: 'Neha',
      },
    ],
    isLatest: true,
    syncType: 0,
  } as never)
}

/** A small PNG of a sunset-ish gradient, so a photo looks like one. */
function gradientPng(width: number, height: number): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 3
      rows[i] = 250 - Math.round((y / height) * 120)
      rows[i + 1] = 120 + Math.round((x / width) * 80)
      rows[i + 2] = 90 + Math.round((y / height) * 140)
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const input = body ? JSON.parse(body) : {}
  try {
    if (req.url === '/whatsapp/linked') await whatsappLinked()
    else if (req.url === '/whatsapp/message') {
      server.sockets.at(-1)!.emit('messages.upsert', {
        type: 'notify',
        messages: [{ key: { remoteJid: RAVI, fromMe: false, id: `L${Date.now()}` }, message: { conversation: input.text }, messageTimestamp: now() }],
      } as never)
    } else if (req.url === '/whatsapp/burst') {
      const base = now() - Number(input.count)
      server.sockets.at(-1)!.emit('messages.upsert', {
        type: 'notify',
        messages: Array.from({ length: Number(input.count) }, (_, i) => ({
          key: { remoteJid: RAVI, fromMe: false, id: `B${Date.now()}-${i}` },
          message: { conversation: `Update ${i + 1}` },
          messageTimestamp: base + i,
        })),
      } as never)
    } else if (req.url === '/whatsapp/photo') {
      server.sockets.at(-1)!.emit('messages.upsert', {
        type: 'notify',
        messages: [
          {
            key: { remoteJid: RAVI, fromMe: false, id: `P${Date.now()}` },
            message: mediaMessage('imageMessage', gradientPng(480, 320), { mimetype: 'image/png', caption: input.caption ?? '' }),
            messageTimestamp: now(),
          },
        ],
      } as never)
    } else if (req.url === '/whatsapp/file') {
      const pdf = Buffer.from('%PDF-1.4\n% Invoice INV-2041 from Ravi Kumar\n%%EOF\n')
      server.sockets.at(-1)!.emit('messages.upsert', {
        type: 'notify',
        messages: [
          {
            key: { remoteJid: RAVI, fromMe: false, id: `F${Date.now()}` },
            message: mediaMessage('documentMessage', pdf, { mimetype: 'application/pdf', fileName: 'Invoice INV-2041.pdf', caption: 'Invoice for the planters' }),
            messageTimestamp: now(),
          },
        ],
      } as never)
    } else if (req.url === '/trim') {
      res.writeHead(200).end(String(await server.current().store.trim()))
      return
    } else if (req.url === '/whatsapp/typing') {
      server.sockets.at(-1)!.emit('presence.update', { id: RAVI, presences: { [RAVI]: { lastKnownPresence: 'composing' } } })
    } else if (req.url === '/whatsapp/older') {
      server.sockets.at(-1)!.emit('messaging-history.set', {
        chats: [],
        contacts: [],
        messages: [
          { key: { remoteJid: RAVI, fromMe: false, id: 'OLD1' }, message: { conversation: 'Can you ship 2 more planters next week?' }, messageTimestamp: now() - 3 * 86400 },
          { key: { remoteJid: RAVI, fromMe: true, id: 'OLD2' }, message: { conversation: 'Yes, booking the courier now' }, messageTimestamp: now() - 3 * 86400 + 600, status: 4 },
        ],
        syncType: 6,
      } as never)
    } else if (req.url === '/telegram/scan') {
      server.telegram.state.scanQr()
    } else if (req.url === '/telegram/message') {
      server.telegram.emit({ type: 'message', message: { id: Date.now() % 1e6, chat: server.telegram.asha, out: false, text: input.text, date: now() } })
    } else {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200).end('ok')
  } catch (error) {
    res.writeHead(500).end(String(error))
  }
}).listen(5181, '127.0.0.1')

console.log(`App on ${server.url}, controls on http://127.0.0.1:5181`)
process.on('SIGTERM', () => void server.close().then(() => process.exit(0)))
