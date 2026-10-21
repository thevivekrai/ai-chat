import type { Attachment, Contact, InboxSnapshot, Message, ScheduledMessage, Thread } from '../types'
import { ME_ID } from '../types'
import { DAY, HOUR, MINUTE, addDays, atTime, weekdayName } from '@/lib/time'

/**
 * Demo conversations. Everything is generated relative to `now` so the inbox always looks
 * "live": the unanswered café lead is always 3 days old, and deadlines like "confirm by Thursday"
 * always name a day that is still ahead.
 *
 * Persona: Aarav runs Mitti Studio, a small ceramics brand in Mumbai. Customers and suppliers
 * reach him on WhatsApp and Instagram, friends on Telegram, his team on Slack, and the odd
 * courier, landlord or clinic over SMS.
 */

/** Bump when the seed changes so data stored by an older version is replaced. */
export const SEED_VERSION = 3

const ME_NAME = 'Aarav'

const CONTACTS: Contact[] = [
  // WhatsApp
  { id: 'c-priya', name: 'Priya Nair', network: 'whatsapp', handle: '+91 98765 01241', label: 'Customer' },
  {
    id: 'c-rakesh',
    name: 'Rakesh Sharma',
    network: 'whatsapp',
    handle: '+91 98765 02093',
    label: 'Supplier',
    org: 'Sharma Packaging',
  },
  { id: 'c-maa', name: 'Maa', network: 'whatsapp', handle: '+91 98765 03110', label: 'Family' },
  // Instagram
  { id: 'c-rohan', name: 'Rohan Mehta', network: 'instagram', handle: '@rohan.mehta', label: 'Customer' },
  {
    id: 'c-kavya',
    name: 'Kavya Menon',
    network: 'instagram',
    handle: '@brewbay.cafe',
    label: 'Customer',
    org: 'Brew Bay Café',
  },
  { id: 'c-zoya', name: 'Zoya Khan', network: 'instagram', handle: '@zoya.khan', label: 'Friend' },
  // Telegram
  { id: 'c-arjun', name: 'Arjun Rao', network: 'telegram', handle: '@arjunrao', label: 'Friend' },
  { id: 'c-sneha', name: 'Sneha Iyer', network: 'telegram', handle: '@sneha_iyer', label: 'Friend' },
  { id: 'c-kabir', name: 'Kabir Shah', network: 'telegram', handle: '@kabirshah', label: 'Friend' },
  { id: 'c-meera', name: 'Meera Joshi', network: 'telegram', handle: '@meeraj', label: 'Friend' },
  { id: 'c-dev', name: 'Dev Malhotra', network: 'telegram', handle: '@devmalhotra', label: 'Friend' },
  { id: 'c-farah', name: 'Farah Ali', network: 'telegram', handle: '@farah.clay' },
  { id: 'c-vikram', name: 'Vikram Patil', network: 'telegram', handle: '@vikram_p' },
  { id: 'c-anita', name: "Anita D'Souza", network: 'telegram', handle: '@anitadsouza' },
  { id: 'c-joseph', name: 'Joseph Fernandes', network: 'telegram', handle: '@josephf' },
  // Slack
  { id: 'c-neha', name: 'Neha Kapoor', network: 'slack', handle: '@neha · Mitti Studio', label: 'Team' },
  { id: 'c-ishaan', name: 'Ishaan Verma', network: 'slack', handle: '@ishaan · guest', label: 'Designer' },
  { id: 'c-ravi', name: 'Ravi Kumar', network: 'slack', handle: '@ravi · Mitti Studio', label: 'Team' },
  { id: 'c-simran', name: 'Simran Gill', network: 'slack', handle: '@simran · Mitti Studio', label: 'Team' },
  // SMS
  { id: 'c-ramesh', name: 'Ramesh (Courier)', network: 'sms', handle: '+91 98765 05821', label: 'Courier' },
  { id: 'c-desai', name: 'Mr. Desai', network: 'sms', handle: '+91 98765 07032', label: 'Landlord' },
  { id: 'c-smilecare', name: 'SmileCare Dental', network: 'sms', handle: 'VM-SMLCAR', label: 'Automated' },
]

interface SeedMessage {
  from: string
  /** How long before `now` the message was sent, in ms. */
  ago: number
  body: string
  attachments?: Attachment[]
}

interface SeedThread extends Omit<Thread, 'doneAt' | 'snoozedUntil' | 'unreadCount'> {
  unread?: number
  messages: SeedMessage[]
}

const ago = (days: number, hours = 0, minutes = 0) => days * DAY + hours * HOUR + minutes * MINUTE
const msg = (from: string, at: number, body: string, attachments?: Attachment[]): SeedMessage => ({
  from,
  ago: at,
  body,
  attachments,
})

function buildThreads(now: number): SeedThread[] {
  /** Weekday name `n` days from now, e.g. "Thursday". */
  const wd = (n: number) => weekdayName(now + n * DAY)
  const me = ME_ID

  return [
    // ─── WhatsApp ──────────────────────────────────────────────────────────────
    {
      id: 'priya',
      network: 'whatsapp',
      kind: 'direct',
      title: 'Priya Nair',
      participantIds: ['c-priya'],
      unread: 2,
      messages: [
        msg('c-priya', ago(8, 2), 'Hi! Is the indigo planter set still available? The one from your last post 🌿'),
        msg(me, ago(8, 1, 52), 'Hi Priya! Yes it is — ₹2,850 for the set of 3, free shipping within Mumbai'),
        msg('c-priya', ago(8, 1, 45), 'Perfect, just placed the order! #MS-2041'),
        msg(me, ago(8, 1, 40), 'Got it, thank you! It ships in 3–4 days 😊'),
        msg(
          'c-priya',
          ago(0, 2, 10),
          "Hi! Any update on #MS-2041? It's been a week and tracking still says 'label created'",
        ),
        msg('c-priya', ago(0, 2, 8), `It's a gift for my sister's housewarming on ${wd(3)} 🙏 really need it before that`),
      ],
    },
    {
      id: 'sharma',
      network: 'whatsapp',
      kind: 'direct',
      title: 'Sharma Packaging',
      participantIds: ['c-rakesh'],
      messages: [
        msg(
          me,
          ago(5, 6),
          'Hi Rakesh ji, need a quote for 2,000 printed boxes for mugs and planters. Same size as the samples. Can you share this week?',
        ),
        msg('c-rakesh', ago(5, 5, 20), 'Namaste ji 🙏 Sure, will share by tomorrow after checking paper rates'),
        msg(
          'c-rakesh',
          ago(4, 1),
          "Paper rates thoda badh gaye hain this month, I'll try to keep it close to last time",
        ),
        msg('c-rakesh', ago(0, 22), 'Namaste ji, sharing the quotation as discussed 👇', [
          { kind: 'file', name: 'Quotation_MittiStudio.pdf', size: '184 KB' },
        ]),
        msg(
          'c-rakesh',
          ago(0, 21, 58),
          '3-ply corrugated boxes, 10×8×6 in, 1-colour logo print\nQty 2,000 pcs @ ₹18.50/pc = ₹37,000\nGST 18% extra → total ₹43,660\nDelivery: 7 working days after advance\nPayment: 50% advance, balance on delivery',
        ),
        msg('c-rakesh', ago(0, 21, 55), `Rate valid till ${wd(2)} 🙏`),
        msg('c-rakesh', ago(0, 21, 54), `Please confirm by ${wd(1)} so we can book the printing slot`),
      ],
    },
    {
      id: 'maa',
      network: 'whatsapp',
      kind: 'direct',
      title: 'Maa',
      participantIds: ['c-maa'],
      messages: [
        msg('c-maa', ago(6, 3), 'Beta khana time pe kha lena. Bahut kaam kar rahe ho aajkal'),
        msg(me, ago(6, 1), 'Haan Maa, kha liya 😊 Weekend pe call karta hoon'),
        msg('c-maa', ago(1, 5), 'Beta, is Sunday lunch pe aa rahe ho na? Papa puch rahe the'),
        msg('c-maa', ago(1, 4, 58), 'Rajma chawal bana rahi hoon 😄 Didi bhi aa rahi hai'),
      ],
    },

    // ─── Instagram ─────────────────────────────────────────────────────────────
    {
      id: 'rohan',
      network: 'instagram',
      kind: 'direct',
      title: 'Rohan Mehta',
      participantIds: ['c-rohan'],
      unread: 2,
      messages: [
        msg('c-rohan', ago(0, 0, 47), 'Hey! Saw your reel with the speckled mugs 😍'),
        msg('c-rohan', ago(0, 0, 46), "What's the price for a set of 6? And do you ship to Pune?"),
      ],
    },
    {
      // The one that slipped through the cracks: seen three days ago, never answered.
      id: 'brewbay',
      network: 'instagram',
      kind: 'direct',
      title: 'Brew Bay Café',
      participantIds: ['c-kavya'],
      messages: [
        msg('c-kavya', ago(3, 2), 'Hi! We run Brew Bay Café in Bandra ☕ Big fans of your work'),
        msg(
          'c-kavya',
          ago(3, 1, 59),
          "We'd like to order 40 custom mugs with our logo for our 2nd anniversary. Could you share pricing and how long it would take?",
        ),
        msg('c-kavya', ago(3, 1, 57), "We'd need them in about 3 weeks 🙂"),
      ],
    },
    {
      id: 'zoya',
      network: 'instagram',
      kind: 'direct',
      title: 'Zoya Khan',
      participantIds: ['c-zoya'],
      unread: 2,
      messages: [
        msg(me, ago(9), 'Happy birthday Zo!! 🎂 Party soon?'),
        msg('c-zoya', ago(8, 23), 'Thank youuu 🥹 yes yes, soon!'),
        msg('c-zoya', ago(0, 5, 20), 'omg is this the new studio?? it looks sooo good 😍'),
        msg('c-zoya', ago(0, 5, 18), 'Chal coffee pe milte hain this week, kab free ho?'),
      ],
    },

    // ─── Telegram ──────────────────────────────────────────────────────────────
    {
      id: 'trek',
      network: 'telegram',
      kind: 'group',
      title: 'Rajmachi Trek 🏔️',
      participantIds: ['c-arjun', 'c-sneha', 'c-kabir', 'c-meera', 'c-dev'],
      unread: 6,
      messages: [
        msg('c-arjun', ago(2, 3), `Guys trek confirm karte hain? Rajmachi this ${wd(3)} 🏔️`),
        msg('c-sneha', ago(2, 2, 58), "I'm in!! 🙌"),
        msg('c-kabir', ago(2, 2, 57), 'Count me in. Finally 😤'),
        msg('c-meera', ago(2, 2, 55), "In, but only if we're not leaving at 3 am again 😂"),
        msg('c-arjun', ago(2, 2, 54), 'Haha no. Subah 5 baje Dadar se nikalte hain'),
        msg('c-dev', ago(2, 2, 50), '5 is fine. Who all are driving?'),
        msg('c-arjun', ago(2, 2, 49), "I'll take my car, fits 4. Need one more car or we book a cab"),
        msg('c-sneha', ago(2, 2, 46), 'Aarav ke paas car hai na? 👀'),
        msg('c-kabir', ago(2, 2, 45), '@Aarav bhai?'),
        msg('c-meera', ago(2, 2, 40), 'Weather check: light rain predicted, should still be fine for trekking'),
        msg('c-dev', ago(2, 2, 38), 'Rain = waterfalls 🤩'),
        msg('c-sneha', ago(2, 2, 30), 'Camp overnight or same-day return?'),
        msg('c-arjun', ago(2, 2, 28), 'Same day is easier, next day sab ka kuch na kuch hai'),
        msg('c-meera', ago(2, 2, 27), 'Same day 👍'),
        msg('c-kabir', ago(2, 2, 25), 'Same day works'),
        msg(
          'c-arjun',
          ago(1, 6),
          `Ok final plan: ${wd(3)} 5 AM from Dadar, breakfast at Lonavala, trek starts around 8`,
        ),
        msg('c-sneha', ago(1, 5, 58), "Who's getting snacks? I can do theplas 😋"),
        msg('c-dev', ago(1, 5, 57), "I'll get energy bars + electrolytes"),
        msg('c-meera', ago(1, 5, 55), 'First aid kit mere paas hai'),
        msg('c-kabir', ago(1, 5, 50), "I'll bring the speaker 🔊"),
        msg('c-meera', ago(1, 5, 49), 'Kabir NO 😂'),
        msg('c-kabir', ago(1, 5, 48), 'Kabir YES'),
        msg(
          'c-arjun',
          ago(1, 5, 40),
          `Cost: ₹1,450 per head (fuel, toll, breakfast, entry). UPI me by ${wd(2)} please 🙏`,
        ),
        msg('c-sneha', ago(1, 5, 30), 'Sent ✅'),
        msg('c-dev', ago(1, 5, 10), 'Sent'),
        msg('c-meera', ago(1, 4), 'Done 💸'),
        msg('c-arjun', ago(1, 3), 'Thanks guys. Kabir and Aarav pending 👀'),
        msg('c-kabir', ago(1, 2), 'Kal karta hoon, promise'),
        msg('c-sneha', ago(0, 3, 10), 'Trail shoes zaroor lana, it gets slippery after rain'),
        msg('c-dev', ago(0, 3, 5), 'Anyone has an extra raincoat? Mine tore last time'),
        msg('c-meera', ago(0, 2, 50), 'I have a spare poncho, will bring'),
        msg('c-arjun', ago(0, 0, 32), '@Aarav car le aa raha hai ya cab book karein? Need to know by tonight'),
        msg('c-sneha', ago(0, 0, 30), 'Also Aarav your ₹1,450 is pending 😛'),
        msg('c-kabir', ago(0, 0, 27), 'Same here 🙈 sending today'),
      ],
    },
    {
      id: 'arjun',
      network: 'telegram',
      kind: 'direct',
      title: 'Arjun Rao',
      participantIds: ['c-arjun'],
      messages: [
        msg('c-arjun', ago(3, 4), 'Bro Goa pics ka drive link bhej dena when you get time'),
        msg(me, ago(3, 3), 'Haan bhejta hoon'),
        msg(
          me,
          ago(1, 1),
          'Uploaded all the Goa pics to the shared album 📸 Also, did my ₹2,300 for the villa come through?',
        ),
      ],
    },
    {
      id: 'potters',
      network: 'telegram',
      kind: 'group',
      title: 'Mumbai Potters Circle',
      participantIds: ['c-farah', 'c-vikram', 'c-anita', 'c-joseph'],
      unread: 3,
      messages: [
        msg('c-vikram', ago(2, 6), 'Anyone selling a used kick wheel? Asking for a student'),
        msg('c-anita', ago(2, 5), 'Try the guy near Chor Bazaar, he had two last month'),
        msg('c-joseph', ago(1, 8), `Reminder: glaze workshop at Anita's studio, ${wd(5)} 4 PM. ₹800, materials included`),
        msg(
          'c-farah',
          ago(0, 6, 15),
          `📣 Kiln firing slots for next month are open. Fill the form by ${wd(4)} — slots go fast!`,
        ),
        msg('c-vikram', ago(0, 6, 10), 'Booked mine ✅'),
        msg('c-anita', ago(0, 5, 40), 'Same 🙌'),
      ],
    },

    // ─── Slack ─────────────────────────────────────────────────────────────────
    {
      id: 'neha',
      network: 'slack',
      kind: 'direct',
      title: 'Neha Kapoor',
      participantIds: ['c-neha'],
      unread: 3,
      messages: [
        msg('c-neha', ago(7, 2), 'Morning! We got a stall at the Kala Ghoda pop-up this weekend 🎉'),
        msg(me, ago(7, 1, 55), "Amazing!! Let's take 60 mugs + 20 planters?"),
        msg('c-neha', ago(7, 1, 40), "Works. I'll draw up the stall layout"),
        msg('c-neha', ago(5, 4), 'Heads-up: packaging is running low, ~300 boxes left'),
        msg(me, ago(5, 3, 52), "On it, I've asked Sharma ji for a quote"),
        msg('c-neha', ago(3, 5), 'Instagram orders this week: 23 🔥 best week so far'),
        msg(me, ago(3, 4, 58), "Let's goooo 🚀"),
        msg('c-neha', ago(2, 3), "Can we push the website update to next week? Product photos aren't ready"),
        msg(me, ago(2, 2, 50), 'Yes, no stress'),
        msg('c-neha', ago(1, 7), 'Kala Ghoda pop-up final count: 41 pieces sold, ₹62,300 💰'),
        msg(me, ago(1, 6, 45), 'Wow! Best pop-up yet 🙌'),
        msg('c-neha', ago(0, 1, 15), "Hey! The accountant is closing this month's books"),
        msg(
          'c-neha',
          ago(0, 1, 14),
          `Can you send the invoice for the Kala Ghoda pop-up order by ${wd(2)}? She needs it for the GST filing`,
        ),
        msg(
          'c-neha',
          ago(0, 1, 12),
          'Also, should I reorder clay from the usual supplier or try the new one? Their sample was nicer',
        ),
      ],
    },
    {
      id: 'ishaan',
      network: 'slack',
      kind: 'direct',
      title: 'Ishaan Verma',
      participantIds: ['c-ishaan'],
      unread: 2,
      messages: [
        msg('c-ishaan', ago(1, 22), 'Working on the festive lookbook, will share v2 tomorrow'),
        msg('c-ishaan', ago(0, 3, 30), "Here's v2 of the festive lookbook 👇", [
          { kind: 'file', name: 'Mitti_Festive_Lookbook_v2.pdf', size: '12.4 MB' },
        ]),
        msg(
          'c-ishaan',
          ago(0, 3, 28),
          'New cover + the planter shots are in. Need your feedback by tomorrow EOD so I can send it to print on time',
        ),
      ],
    },
    {
      id: 'studio-ops',
      network: 'slack',
      kind: 'group',
      title: '#studio-ops',
      participantIds: ['c-neha', 'c-ravi', 'c-simran'],
      messages: [
        msg('c-ravi', ago(1, 9), 'Packed 18 orders today. 4 on hold because we ran out of the medium boxes'),
        msg('c-simran', ago(1, 8, 30), 'Blue glaze restock arrives Monday'),
        msg('c-neha', ago(1, 8), 'Thanks both 🙏'),
        msg(me, ago(0, 4, 5), "Who's handling the courier pickup tomorrow? I'm at the bank till 12"),
      ],
    },

    // ─── SMS ───────────────────────────────────────────────────────────────────
    {
      id: 'courier',
      network: 'sms',
      kind: 'direct',
      title: 'Ramesh (Courier)',
      participantIds: ['c-ramesh'],
      unread: 2,
      messages: [
        msg('c-ramesh', ago(4, 3), 'Sir Andheri wala parcel deliver ho gaya. Thank you'),
        msg(me, ago(4, 2, 50), 'Thanks Ramesh 👍'),
        msg('c-ramesh', ago(0, 0, 38), 'Sir kal pickup ke liye 11 baje aaunga. 6 boxes ready rakhna please'),
        msg('c-ramesh', ago(0, 0, 37), 'Address same hai na? Mitti Studio, Versova'),
      ],
    },
    {
      id: 'landlord',
      network: 'sms',
      kind: 'direct',
      title: 'Mr. Desai',
      participantIds: ['c-desai'],
      messages: [
        msg(me, ago(1, 3), 'Hi Desai uncle, the studio sink is leaking again. Could someone take a look this week?'),
        msg('c-desai', ago(0, 20), `Ok. I will send the plumber ${wd(2)} 10 am. Please keep someone at the studio`),
        msg(me, ago(0, 19, 50), "Perfect, I'll be there. Thank you!"),
        msg('c-desai', ago(0, 19, 40), '👍'),
      ],
    },
    {
      id: 'clinic',
      network: 'sms',
      kind: 'direct',
      title: 'SmileCare Dental',
      participantIds: ['c-smilecare'],
      unread: 1,
      messages: [
        msg(
          'c-smilecare',
          ago(0, 6, 2),
          `SmileCare Dental: your check-up with Dr. Kulkarni is confirmed for ${wd(1)} at 5:30 PM. To reschedule, call 022-4000-1234.`,
        ),
      ],
    },
  ]
}

export function buildSeed(now: number = Date.now()): InboxSnapshot {
  const threads: Thread[] = []
  const messages: Message[] = []

  for (const { messages: seedMessages, unread = 0, ...thread } of buildThreads(now)) {
    threads.push({ ...thread, unreadCount: unread, doneAt: null, snoozedUntil: null })
    seedMessages.forEach((m, i) => {
      messages.push({
        id: `${thread.id}-${i + 1}`,
        threadId: thread.id,
        senderId: m.from,
        body: m.body,
        sentAt: new Date(now - m.ago).toISOString(),
        ...(m.from === ME_ID ? { status: 'read' as const } : {}),
        ...(m.attachments ? { attachments: m.attachments } : {}),
      })
    })
  }

  const scheduled: ScheduledMessage[] = [
    {
      id: 'sched-arjun',
      threadId: 'arjun',
      body: 'Bhai, villa payment check kar lena when you get a sec 🙏',
      sendAt: new Date(atTime(addDays(now, 1), 10)).toISOString(),
      createdAt: new Date(now - ago(1, 0, 58)).toISOString(),
    },
  ]

  return {
    me: { id: ME_ID, name: ME_NAME },
    contacts: CONTACTS.map((c) => ({ ...c })),
    threads,
    messages,
    scheduled,
    tasks: [],
  }
}
