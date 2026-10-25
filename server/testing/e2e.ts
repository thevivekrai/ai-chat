/**
 * The app wired to fake WhatsApp and Telegram, for clicking through linking in a browser:
 *
 *   npm run build && TEST_MONGODB_URI=mongodb://127.0.0.1:27017 npx tsx server/testing/e2e.ts
 *
 * The app is on http://127.0.0.1:5180. A control port (5181) plays the phone's part:
 *   POST /whatsapp/linked             the code was entered: the link opens and history arrives
 *   POST /whatsapp/message {"text"}   a new WhatsApp message (optionally with its "id")
 *   POST /whatsapp/edit {"id","text"} Ravi edits one of his messages
 *   POST /whatsapp/unsend {"id"}      Ravi deletes one of his messages for everyone
 *   POST /whatsapp/pin {"id"}         Ravi pins a message in the chat
 *   POST /whatsapp/typing             Ravi starts typing
 *   POST /whatsapp/older              the phone sends older messages (after "Load earlier")
 *   POST /whatsapp/burst {"count"}    that many WhatsApp messages at once ("react": with a reaction
 *                                     to the last one, sent first in the batch)
 *   POST /whatsapp/failed {"id"}      WhatsApp says one of my messages failed to send
 *   POST /whatsapp/legacy-sticker {"id"} a sticker from Ravi kept as an earlier version did (only
 *                                     named, no link), which the phone still has
 *   POST /whatsapp/reconnect          the connection drops and comes back (the same session)
 *   POST /restart                     the server restarts, and WhatsApp connects again
 *   POST /whatsapp/photo {"caption"}  Ravi sends a photo
 *   POST /whatsapp/file               Ravi sends a PDF
 *   POST /whatsapp/sticker {"webp"}   Ravi sends a sticker (base64 WebP, or another "mimetype")
 *   POST /whatsapp/animated-sticker   Ravi sends an animated (Lottie) sticker: a bouncing ball
 *   POST /whatsapp/voice              Ravi sends a 3-second voice message (a tone)
 *   POST /whatsapp/archived {"archived"} Ravi's chat is archived (or not) on the phone
 *   POST /whatsapp/sent-to-phone      what reached WhatsApp: read receipts (message ids), typing,
 *                                     messages sent, changes (edits, deletions…), and messages
 *                                     asked of the phone again
 *   POST /telegram/message {"text"}   a new Telegram message
 *   POST /telegram/scan               the Telegram QR code is scanned
 *   POST /trim                        the server trims chats to what it keeps, now
 * Telegram's login code is 12345 and the two-step password hunter2.
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { proto } from '@whiskeysockets/baileys'
import { strToU8, zipSync } from 'fflate'
import { mediaMessage, PIXEL, startTestServer, TEST_MONGODB_URI } from './helpers.ts'

if (!TEST_MONGODB_URI) throw new Error('Set TEST_MONGODB_URI')

/** Canned answers for the shared AI's stand-in (below), and the calls it got. */
const aiCalls: { model: string; task: string }[] = []
let aiDown = false
const CANNED: Record<string, unknown> = {
  priority: { priority: 'urgent', expectsReply: true, reason: 'Ravi is waiting on the planter order.', labels: ['follow-up', 'order', 'work'] },
  summary: { oneLine: 'Ravi wants two more planters shipped next week.', bullets: ['Two more planters', 'Ship next week', 'Courier being booked'] },
  tasks: { tasks: [] },
  drafts: { short: 'Shipping Monday.', friendly: 'Hi Ravi! Both planters ship Monday 🙂', professional: 'Hello Ravi, both planters will ship on Monday.' },
  answer: { answer: 'Ravi asked for **2 more planters**.', citedMessageIds: [] },
}
/** A stand-in for OpenRouter's chat API (what the shared AI uses with an sk-or- key). */
const fakeOpenRouter = (async (url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}'))
  const task: string = body.response_format?.json_schema?.name ?? 'summary'
  aiCalls.push({ model: body.model, task })
  if (aiDown) return Response.json({ error: { code: 429, message: 'Rate limit exceeded: free-models-per-min' } }, { status: 429 })
  void url
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(CANNED[task]) } }] })
}) as typeof fetch

const server = await startTestServer({
  port: 5180,
  staticDir: resolve('dist'),
  sharedPhone: true,
  ai: { provider: 'openrouter', apiKey: 'e2e-key', model: 'openrouter/free', triageModel: 'free-light', fetch: fakeOpenRouter },
})
const now = () => Math.floor(Date.now() / 1000)
const RAVI = '919812345678@s.whatsapp.net'
const KIRAN = '919800011122@s.whatsapp.net'

/** The newest WhatsApp connection opens, as the linked phone's does. */
function openLatest() {
  const socket = server.sockets.at(-1)!
  socket.user = { id: '919876543210:4@s.whatsapp.net' }
  socket.emit('connection.update', { connection: 'open' })
}

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
    chats: [{ id: RAVI, unreadCount: 1 }, { id: '120363000000@g.us', name: 'Mehta family', unreadCount: 2 }, { id: KIRAN }],
    contacts: [{ id: RAVI, name: 'Ravi Kumar' }, { id: KIRAN, name: 'Kiran Rao' }],
    messages: [
      // A question nobody answered, ten days ago: by now it's history, not a to-do.
      { key: { remoteJid: KIRAN, fromMe: false, id: 'K1' }, message: { conversation: 'Can you send the catalogue?' }, messageTimestamp: ts - 10 * 86400 },
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

/** A Lottie animation: an amber ball bouncing, two seconds a loop. */
const BOUNCING_BALL = {
  v: '5.7.4',
  fr: 30,
  ip: 0,
  op: 60,
  w: 256,
  h: 256,
  nm: 'bounce',
  ddd: 0,
  assets: [],
  layers: [
    {
      ddd: 0,
      ind: 1,
      ty: 4,
      nm: 'ball',
      sr: 1,
      ks: {
        o: { a: 0, k: 100 },
        r: { a: 0, k: 0 },
        p: {
          a: 1,
          k: [
            { t: 0, s: [128, 70, 0], i: { x: [0.5], y: [1] }, o: { x: [0.5], y: [0] } },
            { t: 30, s: [128, 186, 0], i: { x: [0.5], y: [1] }, o: { x: [0.5], y: [0] } },
            { t: 60, s: [128, 70, 0] },
          ],
        },
        a: { a: 0, k: [0, 0, 0] },
        s: { a: 0, k: [100, 100, 100] },
      },
      ao: 0,
      shapes: [
        {
          ty: 'gr',
          nm: 'ball',
          it: [
            { ty: 'el', nm: 'circle', d: 1, s: { a: 0, k: [110, 110] }, p: { a: 0, k: [0, 0] } },
            { ty: 'fl', nm: 'fill', c: { a: 0, k: [0.98, 0.72, 0.14, 1] }, o: { a: 0, k: 100 }, r: 1 },
            { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
          ],
        },
      ],
      ip: 0,
      op: 60,
      st: 0,
      bm: 0,
    },
  ],
}

/** A tone, `seconds` long, as a voice message: Ogg Opus like WhatsApp's (with ffmpeg), else WAV. */
function voiceNote(seconds: number): { data: Buffer; mimetype: string } {
  const args = ['-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`, '-c:a', 'libopus', '-f', 'ogg', 'pipe:1']
  const made = spawnSync('ffmpeg', args, { maxBuffer: 4 * 1024 * 1024 })
  if (made.status === 0 && made.stdout?.length) return { data: made.stdout, mimetype: 'audio/ogg; codecs=opus' }
  const rate = 8000
  const samples = Buffer.alloc(rate * seconds * 2)
  for (let i = 0; i < rate * seconds; i++) samples.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 330 * i) / rate) * 8000), i * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + samples.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(samples.length, 40)
  return { data: Buffer.concat([header, samples]), mimetype: 'audio/wav' }
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
        messages: [{ key: { remoteJid: RAVI, fromMe: false, id: input.id ?? `L${Date.now()}` }, message: { conversation: input.text }, messageTimestamp: now() }],
      } as never)
    } else if (req.url === '/whatsapp/edit' || req.url === '/whatsapp/unsend' || req.url === '/whatsapp/pin') {
      // As the phone reports them: a message pointing at the one changed.
      const key = { remoteJid: RAVI, fromMe: false, id: String(input.id) }
      const message =
        req.url === '/whatsapp/pin'
          ? { pinInChatMessage: { key, type: proto.PinInChat.Type.PIN_FOR_ALL } }
          : req.url === '/whatsapp/edit'
            ? { protocolMessage: { key, type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, editedMessage: { conversation: input.text } } }
            : { protocolMessage: { key, type: proto.Message.ProtocolMessage.Type.REVOKE } }
      server.sockets.at(-1)!.emit('messages.upsert', {
        type: 'notify',
        messages: [{ key: { remoteJid: RAVI, fromMe: false, id: `C${Date.now()}` }, message, messageTimestamp: now() }],
      } as never)
    } else if (req.url === '/whatsapp/burst') {
      const base = now() - Number(input.count)
      const batch = Date.now()
      const messages = Array.from({ length: Number(input.count) }, (_, i) => ({
        key: { remoteJid: RAVI, fromMe: false, id: `B${batch}-${i}` },
        message: { conversation: `Update ${i + 1}` },
        messageTimestamp: base + i,
      }))
      const last = messages.at(-1)!.key
      const reaction = { key: { remoteJid: RAVI, fromMe: false, id: `R${batch}` }, message: { reactionMessage: { key: last, text: '🔥' } }, messageTimestamp: now() }
      server.sockets.at(-1)!.emit('messages.upsert', { type: 'notify', messages: input.react ? [reaction, ...messages] : messages } as never)
    } else if (req.url === '/whatsapp/legacy-sticker') {
      const user = await server.database.col.users.find().sort({ _id: -1 }).limit(1).next()
      const id = String(input.id)
      await server.current().store.addMessage(user!._id, {
        id: `wa:${RAVI}:${id}`,
        threadId: `wa:${RAVI}`,
        senderId: `wa:${RAVI}`,
        body: 'Sticker',
        sentAt: new Date((now() - 3600) * 1000).toISOString(),
        ref: { key: { remoteJid: RAVI, fromMe: false, id } },
      })
      server.sockets.at(-1)!.phone.set(id, {
        key: { remoteJid: RAVI, fromMe: false, id },
        message: mediaMessage('stickerMessage', PIXEL, { mimetype: 'image/webp' }),
        messageTimestamp: now() - 3600,
      } as never)
    } else if (req.url === '/whatsapp/reconnect') {
      const dropped = server.sockets.at(-1)!
      dropped.emit('connection.update', { connection: 'close', lastDisconnect: { error: Object.assign(new Error('restart'), { output: { statusCode: 515 } }), date: new Date() } })
      const deadline = Date.now() + 10_000
      while (server.sockets.at(-1) === dropped) {
        if (Date.now() > deadline) throw new Error('WhatsApp did not connect again')
        await new Promise((r) => setTimeout(r, 20))
      }
      openLatest()
    } else if (req.url === '/restart') {
      await server.restart()
      openLatest()
    } else if (req.url === '/whatsapp/failed') {
      server.sockets.at(-1)!.emit('messages.update', [{ key: { remoteJid: RAVI, fromMe: true, id: String(input.id) }, update: { status: 0 } }] as never)
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
    } else if (req.url === '/whatsapp/sticker') {
      server.sockets.at(-1)!.emit('messages.upsert', {
        type: 'notify',
        messages: [
          {
            key: { remoteJid: RAVI, fromMe: false, id: `S${Date.now()}` },
            message: mediaMessage('stickerMessage', Buffer.from(String(input.webp), 'base64'), { mimetype: typeof input.mimetype === 'string' ? input.mimetype : 'image/webp' }),
            messageTimestamp: now(),
          },
        ],
      } as never)
    } else if (req.url === '/whatsapp/animated-sticker') {
      // As WhatsApp sends one: a zip with the Lottie animation inside.
      const was = Buffer.from(zipSync({ 'animation/animation.json': strToU8(JSON.stringify(BOUNCING_BALL)) }))
      server.sockets.at(-1)!.emit('messages.upsert', {
        type: 'notify',
        messages: [
          {
            key: { remoteJid: RAVI, fromMe: false, id: `A${Date.now()}` },
            message: mediaMessage('stickerMessage', was, { mimetype: 'application/was', isLottie: true }),
            messageTimestamp: now(),
          },
        ],
      } as never)
    } else if (req.url === '/whatsapp/voice') {
      const { data, mimetype } = voiceNote(3)
      const waveform = Buffer.from(Array.from({ length: 64 }, (_, i) => Math.round(30 + 70 * Math.abs(Math.sin(i / 5)))))
      server.sockets.at(-1)!.emit('messages.upsert', {
        type: 'notify',
        messages: [
          {
            key: { remoteJid: RAVI, fromMe: false, id: `V${Date.now()}` },
            message: mediaMessage('audioMessage', data, { mimetype, ptt: true, seconds: 3, waveform }),
            messageTimestamp: now(),
          },
        ],
      } as never)
    } else if (req.url === '/whatsapp/archived') {
      server.sockets.at(-1)!.emit('chats.update', [{ id: RAVI, archived: input.archived !== false }] as never)
    } else if (req.url === '/whatsapp/sent-to-phone') {
      const socket = server.sockets.at(-1)!
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          read: socket.read.map((k) => k.id),
          typing: socket.presence.filter((p) => p.type !== 'subscribe').map((p) => p.type),
          sent: socket.sent,
          changes: socket.changes,
          resends: server.sockets.flatMap((s) => s.resendRequests.map((k) => k.id)),
        }),
      )
      return
    } else if (req.url === '/ai/calls') {
      res.writeHead(200).end(JSON.stringify(aiCalls))
      return
    } else if (req.url === '/ai/down') {
      aiDown = !!input.down
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
