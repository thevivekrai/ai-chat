/**
 * Hand-written "model output" for the demo conversations in src/data/mock/seed.ts, so the
 * built-in demo AI shows what good results look like without an API key. Each entry is only used
 * while the thread still ends with the message it was written for (`anchor`); after that the
 * heuristics take over, like a real model re-reading a changed thread would. With a Claude key
 * set, none of this is used.
 *
 * Day names are never hard-coded: `c.day('sharma-7')` reads the weekday out of that message, so
 * the text stays correct whatever day the demo data was generated on.
 */
import { shortName } from '@/lib/format'
import { addDays, dayDiff, formatDurationLong, toMs, weekdayName } from '@/lib/time'
import type {
  AiSearchSource,
  AiThread,
  ExtractedTask,
  Priority,
  PriorityResult,
  SearchAnswer,
  ThreadSummary,
  Tone,
} from '../types'
import { findDateMention } from './dates'
import { heuristicTasks, lastMessage, truncate, waitingSince } from './heuristics'

interface Ctx {
  /** Weekday named or implied by a message, e.g. "Thursday". */
  day(messageId: string): string
  /** The same date relative to now: "today", "tomorrow" or a weekday. */
  when(messageId: string): string
  /** Time since a message was sent, e.g. "3 days". */
  since(messageId: string): string
  /** How long the oldest unanswered message in the thread has been waiting. */
  waiting(): string
  /** Weekday `n` days from now. */
  dayFromNow(n: number): string
}

type Text = string | ((c: Ctx) => string)

class MissingSource extends Error {}

interface Lookup {
  (messageId: string): { body: string; sentAt: string } | undefined
}

function makeCtx(lookup: Lookup, now: number, waitingSince?: string): Ctx {
  const mentionOf = (id: string) => {
    const m = lookup(id)
    const mention = m && findDateMention(m.body, toMs(m.sentAt))
    if (!mention) throw new MissingSource(id)
    return mention
  }
  return {
    day: (id) => weekdayName(mentionOf(id).at),
    when: (id) => {
      const at = mentionOf(id).at
      const diff = dayDiff(now, at)
      return diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : weekdayName(at)
    },
    since: (id) => {
      const m = lookup(id)
      if (!m) throw new MissingSource(id)
      return formatDurationLong(now - toMs(m.sentAt))
    },
    waiting: () => formatDurationLong(waitingSince ? now - toMs(waitingSince) : 0),
    dayFromNow: (n) => weekdayName(addDays(now, n)),
  }
}

const render = (text: Text, c: Ctx) => (typeof text === 'function' ? text(c) : text)

interface CannedThread {
  /** Last message of the thread when this was written. */
  anchor: string
  priority: Priority
  expectsReply: boolean
  reason: Text
  summary: Text
  bullets?: Text[]
  tasks?: { messageId: string; title: string }[]
  drafts?: Record<Tone, Text[]>
}

const CANNED: Record<string, CannedThread> = {
  priya: {
    anchor: 'priya-6',
    priority: 'urgent',
    expectsReply: true,
    reason: (c) => `Customer order is late and she needs it before ${c.day('priya-6')}.`,
    summary: (c) =>
      `Priya's order #MS-2041 is stuck at “label created” and she needs it before ${c.day('priya-6')} for a housewarming gift.`,
    bullets: [
      'Ordered the indigo planter set (₹2,850) 8 days ago; you said it would ship in 3–4 days',
      "Tracking still shows 'label created'",
      (c) => `It's a gift for her sister's housewarming on ${c.day('priya-6')}`,
    ],
    tasks: [{ messageId: 'priya-6', title: 'Get order #MS-2041 to Priya (housewarming gift)' }],
    drafts: {
      short: [
        "So sorry for the delay, Priya! Checking with the courier right now — I'll update you within the hour 🙏",
        "Sorry Priya! On it now — you'll have an update on #MS-2041 within the hour.",
      ],
      friendly: [
        (c) =>
          `Hi Priya! I'm really sorry about this 🙏 I'm chasing the courier right now and will make sure the planters reach you before ${c.day('priya-6')}. I'll send you live tracking as soon as I have it!`,
        (c) =>
          `Hey Priya, so sorry for the wait! I'm sorting it out with the courier today so it reaches you well before the housewarming on ${c.day('priya-6')} 🌿 Will message you with tracking shortly.`,
      ],
      professional: [
        (c) =>
          `Hi Priya, apologies for the delay with order #MS-2041. I'm escalating it with our courier partner and will share an updated tracking link today. We'll make sure it is delivered before ${c.day('priya-6')}.`,
        (c) =>
          `Hello Priya, thank you for your patience. I'm looking into order #MS-2041 with the courier and will confirm a delivery date with you today, well ahead of ${c.day('priya-6')}.`,
      ],
    },
  },

  sharma: {
    anchor: 'sharma-7',
    priority: 'urgent',
    expectsReply: true,
    reason: (c) => `Supplier needs your go-ahead by ${c.when('sharma-7')} to hold the rate.`,
    summary: (c) =>
      `Sharma Packaging quoted ₹18.50/box for 2,000 boxes (₹43,660 incl. GST) — confirm by ${c.day('sharma-7')} to hold the rate.`,
    bullets: [
      '3-ply corrugated boxes, 10×8×6 in, 1-colour logo print',
      '2,000 pcs × ₹18.50 = ₹37,000 + 18% GST → ₹43,660',
      '50% advance; delivery 7 working days after payment',
      (c) => `Rate valid till ${c.day('sharma-6')}; they need your confirmation by ${c.day('sharma-7')}`,
    ],
    tasks: [
      { messageId: 'sharma-7', title: 'Confirm the box order with Sharma Packaging' },
      { messageId: 'sharma-5', title: 'Pay 50% advance to Sharma Packaging (₹21,830)' },
    ],
    drafts: {
      short: [
        (c) => `Thanks Rakesh ji, received 🙏 Will confirm by ${c.day('sharma-7')}.`,
        (c) => `Got the quote, thank you! Confirming by ${c.day('sharma-7')}.`,
      ],
      friendly: [
        (c) =>
          `Thank you Rakesh ji 🙏 The quote looks good. Since it's 2,000 pieces, could you do ₹17.50/pc? I'll confirm the order by ${c.day('sharma-7')}.`,
        (c) =>
          `Namaste Rakesh ji, thanks for the quotation! Let me check with my team and confirm by ${c.day('sharma-7')}. Would a 40% advance work this time?`,
      ],
      professional: [
        "Hi Rakesh ji, thank you for the quotation. We'd like to go ahead with 2,000 pcs at ₹18.50/pc (₹43,660 incl. GST). Please share your bank details for the 50% advance.",
        (c) =>
          `Hello Rakesh ji, thank you for sharing the quotation. Before we confirm, could you send a print proof of the logo? We will confirm the order by ${c.day('sharma-7')}.`,
      ],
    },
  },

  maa: {
    anchor: 'maa-4',
    priority: 'normal',
    expectsReply: true,
    reason: (c) => `Maa asked about Sunday lunch and has been waiting ${c.waiting()}.`,
    summary: "Maa wants to know if you're coming for Sunday lunch — she's making rajma chawal and Didi is coming too.",
    tasks: [{ messageId: 'maa-3', title: 'Sunday lunch at home' }],
    drafts: {
      short: ['Haan Maa, aa raha hoon! 😊', 'Pakka aa raha hoon Maa ❤️'],
      friendly: [
        'Haan Maa, bilkul aa raha hoon! Rajma chawal ke liye toh zaroor 😄 Didi se bhi milna ho jayega. Papa ko pranam ❤️',
        'Aa raha hoon Maa! Sorry late reply kiya, kaam mein phasa tha 🙈 Lunch time tak pahunch jaunga. Rajma chawal 🤤',
      ],
      professional: [
        "Yes Maa, I'll be there for Sunday lunch. Looking forward to seeing Didi too — please tell Papa I'm coming.",
        "Hi Maa, sorry for the late reply. I'll definitely come for lunch on Sunday and will be there in time.",
      ],
    },
  },

  rohan: {
    anchor: 'rohan-2',
    priority: 'normal',
    expectsReply: true,
    reason: 'New customer asking for a price and shipping to Pune.',
    summary: 'Rohan saw the speckled mugs reel and wants the price for a set of 6, shipped to Pune.',
    drafts: {
      short: [
        'Hey Rohan! A set of 6 is ₹[price], and yes, we ship to Pune 🙂',
        'Hi Rohan! Set of 6 is ₹[price] + shipping. Yes, we deliver to Pune — want me to keep one aside?',
      ],
      friendly: [
        'Hey Rohan, thank you! 😊 The speckled mugs are ₹[price] for a set of 6, and yes — we ship to Pune. Want me to keep a set aside for you?',
        "Hi Rohan! So glad you liked the reel 😍 A set of 6 speckled mugs is ₹[price], and Pune is no problem. I can share more photos if you'd like!",
      ],
      professional: [
        'Hi Rohan, thanks for your interest! The speckled mug set (6 pieces) is ₹[price], and we ship across India, including Pune. Let me know if you would like to place an order.',
        'Hello Rohan, thank you for reaching out. A set of 6 speckled mugs is ₹[price] plus ₹[shipping] shipping to Pune. I can reserve a set for you today.',
      ],
    },
  },

  brewbay: {
    anchor: 'brewbay-3',
    priority: 'urgent',
    expectsReply: true,
    reason: (c) => `Bulk order lead (40 mugs) — unanswered for ${c.waiting()}.`,
    summary: 'Brew Bay Café wants 40 custom logo mugs for their 2nd anniversary in about 3 weeks and asked for pricing.',
    bullets: [
      'Café in Bandra, big fans of the studio',
      '40 custom mugs with their logo, for their 2nd anniversary',
      'Needs pricing and lead time; delivery in about 3 weeks',
    ],
    tasks: [
      { messageId: 'brewbay-2', title: 'Send Brew Bay Café a quote for 40 logo mugs' },
      { messageId: 'brewbay-3', title: 'Deliver 40 custom mugs to Brew Bay Café' },
    ],
    drafts: {
      short: [
        "Hi Kavya! Sorry for the late reply 🙈 40 logo mugs in 3 weeks works. It'd be ₹[price]/mug — can you send your logo?",
        'Hi Kavya, thanks for reaching out! Yes, 3 weeks works for 40 custom mugs. Sharing pricing shortly.',
      ],
      friendly: [
        "Hi Kavya! Thank you so much, and sorry for the slow reply 🙈 We'd love to make mugs for Brew Bay's anniversary! 40 custom logo mugs in about 3 weeks works for us — it'd be ₹[price] per mug. Could you send your logo so we can share a mockup?",
        "Hey Kavya! Congrats on 2 years ☕🎉 and sorry I'm only replying now. Yes, we can do 40 logo mugs in 3 weeks — I'll send pricing and a couple of glaze options today!",
      ],
      professional: [
        'Hi Kavya, thank you for considering Mitti Studio, and apologies for the delayed response. We can produce 40 custom mugs with your logo within 3 weeks, at ₹[price] per mug including glazing and packaging. Please share your logo in high resolution and we will send a mockup for approval.',
        "Hello Kavya, thank you for your message, and sorry for the delay in getting back to you. We'd be glad to make 40 logo mugs, ready in about 3 weeks. I'll share a detailed quote with glaze options by [date].",
      ],
    },
  },

  zoya: {
    anchor: 'zoya-4',
    priority: 'low',
    expectsReply: true,
    reason: 'Friend making casual coffee plans — no deadline.',
    summary: 'Zoya loved the new studio and wants to meet for coffee this week.',
    drafts: {
      short: [(c) => `Haha yes! ${c.dayFromNow(2)} evening chalega? ☕`, (c) => `Yesss! Coffee on ${c.dayFromNow(2)}? 🙌`],
      friendly: [
        (c) =>
          `Haan yaar, it's the new studio! 😍 Still setting it up but come see it — coffee on ${c.dayFromNow(2)} evening? ☕`,
        (c) =>
          `Thank youuu 🥹 Yes it is! Chal milte hain — ${c.dayFromNow(2)} ya ${c.dayFromNow(3)}, jo tujhe suit kare ☕`,
      ],
      professional: [
        (c) => `Thank you, Zoya! Yes, it's the new studio. I'm free on ${c.dayFromNow(2)} after 6 — would that work for coffee?`,
        (c) =>
          `Thanks Zoya! It is the new studio. Let's meet for coffee this week — does ${c.dayFromNow(2)} or ${c.dayFromNow(3)} evening work for you?`,
      ],
    },
  },

  trek: {
    anchor: 'trek-34',
    priority: 'normal',
    expectsReply: true,
    reason: 'Arjun asked you directly: car or cab? They need to know tonight.',
    summary: (c) =>
      `Trek is on for ${c.day('trek-16')}: 5 AM from Dadar, ₹1,450 each to Arjun. They need to know tonight if you're driving or they should book a cab.`,
    bullets: [
      (c) =>
        `Plan: ${c.day('trek-16')}, leave Dadar 5 AM, breakfast at Lonavala, trek starts around 8, back the same day`,
      (c) => `Cost: ₹1,450 per person by UPI to Arjun by ${c.day('trek-23')} — yours is still pending`,
      'Open question for you: bring your car (Arjun’s only fits 4) or book a cab? Needed tonight',
      'Bring trail shoes and a raincoat — light rain is forecast',
      'Sorted: Sneha (theplas), Dev (energy bars), Meera (first aid + spare poncho), Kabir (speaker)',
    ],
    tasks: [
      { messageId: 'trek-32', title: 'Tell the trek group: car or cab' },
      { messageId: 'trek-23', title: 'Pay ₹1,450 trek share to Arjun' },
      { messageId: 'trek-16', title: 'Rajmachi trek — meet at Dadar' },
    ],
    drafts: {
      short: ['Car le aaunga 🚗 aur ₹1,450 abhi bhej raha hoon!', "Let's book a cab 🙏 Sending my ₹1,450 to Arjun now."],
      friendly: [
        "Sorry guys, late reply 🙈 Main car le aa raha hoon, 4 log aa jayenge. Sending my ₹1,450 to Arjun right now 💸 Can't wait!",
        "Hey sorry, was swamped! Let's book a cab — nobody should drive at 5 AM 😅 Paying my ₹1,450 tonight, promise!",
      ],
      professional: [
        (c) =>
          `Hi all — I'll bring my car, so we don't need a cab (it seats 4). I'll transfer my ₹1,450 share to Arjun today. See you at Dadar at 5 AM on ${c.day('trek-16')}.`,
        (c) =>
          `Hi everyone, I won't be able to drive, so let's book a cab. I'll transfer my ₹1,450 to Arjun today. See you at Dadar at 5 AM on ${c.day('trek-16')}.`,
      ],
    },
  },

  arjun: {
    anchor: 'arjun-3',
    priority: 'normal',
    expectsReply: false,
    reason: 'You replied last — waiting on Arjun about the villa payment.',
    summary: 'You shared the Goa photos and asked whether your ₹2,300 villa payment reached Arjun — no reply yet.',
    drafts: {
      short: ['Bhai, villa payment mila kya? 🙏', 'Hey, did the ₹2,300 come through?'],
      friendly: [
        'Arjun bhai! Bas check kar raha tha — ₹2,300 villa wala mila ki nahi? Aur pics kaisi lagi? 😄',
        'Hey Arjun! Just bumping this — did my ₹2,300 for the villa reach you? No rush 🙂',
      ],
      professional: [
        'Hi Arjun, just following up on my earlier message — could you confirm whether my ₹2,300 for the villa came through?',
        'Hi Arjun, checking in: did you receive the ₹2,300 villa payment? Let me know if I should resend it.',
      ],
    },
  },

  potters: {
    anchor: 'potters-6',
    priority: 'low',
    expectsReply: false,
    reason: (c) => `Community announcements — nobody asked you anything. Kiln form closes ${c.day('potters-4')}.`,
    summary: (c) =>
      `Kiln firing slots for next month are open (form closes ${c.day('potters-4')}); glaze workshop ${c.day('potters-3')} at 4 PM.`,
    bullets: [
      (c) => `Kiln slots for next month are open — form closes ${c.day('potters-4')}; Vikram and Anita already booked`,
      (c) => `Glaze workshop at Anita's studio, ${c.day('potters-3')} 4 PM, ₹800 with materials`,
      'Vikram is looking for a used kick wheel for a student',
    ],
    tasks: [
      { messageId: 'potters-4', title: 'Book a kiln firing slot for next month' },
      { messageId: 'potters-3', title: "Glaze workshop at Anita's studio" },
    ],
    drafts: {
      short: ['Booked mine too ✅'],
      friendly: [(c) => `Just booked my kiln slot too 🙌 See you all at the glaze workshop on ${c.day('potters-3')}!`],
      professional: ['Thanks for the reminder, Farah. I have booked a kiln slot for next month.'],
    },
  },

  neha: {
    anchor: 'neha-14',
    priority: 'normal',
    expectsReply: true,
    reason: (c) => `Two asks from Neha: the invoice by ${c.when('neha-13')} and a clay supplier decision.`,
    summary: (c) =>
      `Neha needs the Kala Ghoda pop-up invoice by ${c.day('neha-13')} for GST and wants to know which clay supplier to reorder from.`,
    bullets: [
      (c) => `The accountant is closing this month's books — needs the Kala Ghoda invoice by ${c.day('neha-13')}`,
      'Decision needed: reorder clay from the usual supplier or try the new one (nicer sample)',
      'Kala Ghoda pop-up sold 41 pieces for ₹62,300',
      'Packaging was running low (~300 boxes) — you asked Sharma Packaging for a quote',
      'Website update moved to next week; Instagram had its best week (23 orders)',
    ],
    tasks: [
      { messageId: 'neha-13', title: 'Send invoice for the Kala Ghoda pop-up order' },
      { messageId: 'neha-14', title: 'Decide: usual clay supplier or the new one' },
    ],
    drafts: {
      short: [
        (c) => `Will send the invoice by ${c.day('neha-13')}! Let's try the new supplier 👍`,
        (c) => `Invoice coming by ${c.day('neha-13')}. Stick with the usual supplier for now.`,
      ],
      friendly: [
        (c) =>
          `Hey Neha! Yes, I'll send the Kala Ghoda invoice by ${c.day('neha-13')} for the GST filing 🙌 And let's try the new supplier — if their sample was nicer, it's worth it. Maybe start with a smaller batch?`,
        (c) =>
          `Hi! On it — the invoice will be with the accountant by ${c.day('neha-13')}. For clay, can we order a small trial batch from the new supplier first? 🤞`,
      ],
      professional: [
        (c) =>
          `Hi Neha, I'll send the Kala Ghoda pop-up invoice to the accountant by ${c.day('neha-13')}. On clay, let's place a trial order with the new supplier and compare quality before switching fully.`,
        (c) =>
          `Hi Neha, noted on the invoice; it will be ready by ${c.day('neha-13')}. Please reorder from the usual supplier for now, and ask the new one for pricing so we can compare.`,
      ],
    },
  },

  ishaan: {
    anchor: 'ishaan-3',
    priority: 'normal',
    expectsReply: true,
    reason: 'Lookbook feedback needed by tomorrow EOD to make the print slot.',
    summary:
      'Ishaan shared lookbook v2 (new cover, planter shots) and needs your feedback by tomorrow EOD to make the print deadline.',
    tasks: [{ messageId: 'ishaan-3', title: 'Review festive lookbook v2 and send feedback' }],
    drafts: {
      short: ['Thanks Ishaan! Will send feedback by tomorrow EOD 👍', 'Looks great at first glance — feedback by tomorrow EOD!'],
      friendly: [
        "Thanks Ishaan, this looks lovely! Those planter shots 😍 I'll go through it properly and send feedback by tomorrow EOD so you can send it to print on time.",
        'Ooh, the new cover! 🙌 Thanks Ishaan. Going through it tonight — you’ll have my notes by tomorrow EOD.',
      ],
      professional: [
        "Hi Ishaan, thank you for sharing v2. I'll review the lookbook and send consolidated feedback by tomorrow EOD, so we stay on schedule for print.",
        'Hi Ishaan, thanks for the update. I will review v2 and share any changes by tomorrow end of day.',
      ],
    },
  },

  'studio-ops': {
    anchor: 'studio-ops-4',
    priority: 'normal',
    expectsReply: false,
    reason: "You asked who's handling tomorrow's courier pickup — no answer yet.",
    summary:
      "4 orders are on hold until medium boxes arrive, blue glaze lands Monday, and nobody has said who's taking tomorrow's courier pickup.",
    bullets: [
      'Ravi packed 18 orders; 4 are on hold for lack of medium boxes',
      'Blue glaze restock arrives Monday (Simran)',
      "Your question — who's handling tomorrow's courier pickup? — is unanswered",
    ],
    tasks: [{ messageId: 'studio-ops-4', title: 'Find someone to hand over the courier pickup' }],
    drafts: {
      short: ["Bumping this — who's taking tomorrow's pickup? 🙏", 'Anyone free for the courier pickup tomorrow?'],
      friendly: [
        "Hey team, bumping this 🙏 Can someone be at the studio for the courier pickup tomorrow? I'm at the bank till 12.",
        'Quick one 🙂 who can cover the courier pickup tomorrow morning? Happy to swap something in return!',
      ],
      professional: [
        "Hi team, following up: please confirm who will handle tomorrow's courier pickup, as I'll be at the bank until 12.",
        "Hi all, could one of you take tomorrow's courier pickup? Please reply here so I know it's covered.",
      ],
    },
  },

  courier: {
    anchor: 'courier-4',
    priority: 'normal',
    expectsReply: true,
    reason: 'Courier pickup tomorrow at 11 — he wants the address confirmed.',
    summary: 'Ramesh will pick up 6 boxes tomorrow at 11 AM and wants to confirm the address is still Mitti Studio, Versova.',
    tasks: [{ messageId: 'courier-3', title: 'Keep 6 boxes ready for the courier pickup' }],
    drafts: {
      short: ['Haan Ramesh ji, address same hai. 11 baje ready rahega 👍', 'Ji, same address. 6 boxes ready rahenge.'],
      friendly: [
        'Haan Ramesh ji, address same hai — Mitti Studio, Versova. 6 boxes 11 baje tak ready rahenge. Thank you! 🙏',
        'Ji Ramesh ji, same address. Boxes ready rahenge, 11 baje aa jaana 🙏',
      ],
      professional: [
        'Yes, the address is the same: Mitti Studio, Versova. All 6 boxes will be packed and ready by 11 AM tomorrow.',
        'Hello Ramesh, yes, same address (Mitti Studio, Versova). The 6 boxes will be ready for pickup at 11 AM.',
      ],
    },
  },

  landlord: {
    anchor: 'landlord-4',
    priority: 'low',
    expectsReply: false,
    reason: 'Just a 👍 — nothing to reply to.',
    summary: (c) =>
      `The plumber is coming ${c.day('landlord-2')} at 10 AM to fix the studio sink; you said you'll be there.`,
    tasks: [{ messageId: 'landlord-2', title: 'Be at the studio for the plumber' }],
    drafts: {
      short: ['Thank you! 🙏'],
      friendly: ['Thanks a lot, uncle! See you then 🙏'],
      professional: [(c) => `Thank you, Mr. Desai. I will be at the studio on ${c.day('landlord-2')} at 10 AM.`],
    },
  },

  clinic: {
    anchor: 'clinic-1',
    priority: 'low',
    expectsReply: false,
    reason: (c) => `Automated confirmation for ${c.when('clinic-1')}, 5:30 PM — no reply needed.`,
    summary: (c) => `Dental check-up with Dr. Kulkarni confirmed for ${c.day('clinic-1')} at 5:30 PM.`,
    tasks: [{ messageId: 'clinic-1', title: 'Dental check-up with Dr. Kulkarni' }],
    drafts: {
      short: ['Thanks, see you then!'],
      friendly: ['Thank you! See you then 🙂'],
      professional: [(c) => `Thank you. I confirm my appointment on ${c.day('clinic-1')} at 5:30 PM.`],
    },
  },
}

/* ── Per-thread results ─────────────────────────────────────────────────── */

function threadCtx(thread: AiThread, now: number): Ctx {
  const byId = new Map(thread.messages.map((m) => [m.id, m]))
  return makeCtx((id) => byId.get(id), now, waitingSince(thread))
}

function attempt<T>(fn: () => T): T | null {
  try {
    return fn()
  } catch (error) {
    if (error instanceof MissingSource) return null
    throw error
  }
}

export function cannedBasePriority(threadId: string): Priority | undefined {
  return CANNED[threadId]?.priority
}

export function cannedPriority(thread: AiThread, now: number): PriorityResult | null {
  const entry = CANNED[thread.id]
  if (!entry || lastMessage(thread)?.id !== entry.anchor) return null
  const c = threadCtx(thread, now)
  return attempt(() => ({ priority: entry.priority, expectsReply: entry.expectsReply, reason: render(entry.reason, c) }))
}

export function cannedSummary(thread: AiThread, now: number): ThreadSummary | null {
  const entry = CANNED[thread.id]
  const anchorIndex = entry ? thread.messages.findIndex((m) => m.id === entry.anchor) : -1
  if (!entry || anchorIndex === -1) return null
  const c = threadCtx(thread, now)
  return attempt(() => {
    let oneLine = render(entry.summary, c)
    const bullets = (entry.bullets ?? []).map((b) => render(b, c))
    // Messages newer than the hand-written summary get a "latest" note, as a re-summary would.
    const newer = thread.messages.slice(anchorIndex + 1)
    const latest = newer[newer.length - 1]
    if (latest) {
      const who = latest.fromMe ? 'You' : shortName(latest.senderName)
      const note = `Latest — ${who}: “${truncate(latest.body, 60)}”`
      oneLine = `${oneLine} ${note}`
      bullets.push(note)
    }
    return { oneLine, bullets }
  })
}

export function cannedTasks(thread: AiThread, now: number): ExtractedTask[] | null {
  const entry = CANNED[thread.id]
  const anchorIndex = entry ? thread.messages.findIndex((m) => m.id === entry.anchor) : -1
  if (!entry || anchorIndex === -1) return null
  const byId = new Map(thread.messages.map((m) => [m.id, m]))
  const tasks: ExtractedTask[] = []
  for (const [i, t] of (entry.tasks ?? []).entries()) {
    const message = byId.get(t.messageId)
    if (!message) continue
    const mention = findDateMention(message.body, toMs(message.sentAt))
    tasks.push({
      id: `${t.messageId}#${i}`,
      title: t.title,
      dueAt: mention ? new Date(mention.at).toISOString() : null,
      dueText: mention?.phrases[0] ?? null,
      sourceMessageId: message.id,
    })
  }
  // Anything newer than the hand-written entry is read by the heuristic extractor.
  return [...tasks, ...heuristicTasks(thread, now, thread.messages.slice(anchorIndex + 1))]
}

export function cannedDraft(thread: AiThread, tone: Tone, variant: number, now: number): string | null {
  const entry = CANNED[thread.id]
  if (!entry?.drafts || lastMessage(thread)?.id !== entry.anchor) return null
  const options = entry.drafts[tone]
  const c = threadCtx(thread, now)
  return attempt(() => render(options[variant % options.length], c))
}

/* ── Cross-chat answers ─────────────────────────────────────────────────── */

interface CannedAnswer {
  match: RegExp
  /** Each part is used only if its source messages were retrieved. */
  parts: { cite: string[]; text: Text }[]
}

const ANSWERS: CannedAnswer[] = [
  {
    match: /suppl|vendor|quot|packag|\bbox/i,
    parts: [
      {
        cite: ['sharma-4', 'sharma-5', 'sharma-7'],
        text: (c) =>
          `Sharma Packaging quoted **₹18.50 per box** for 2,000 printed 3-ply boxes — ₹37,000 + 18% GST, so **₹43,660 in total**. They want a 50% advance, deliver 7 working days after payment, and need your confirmation by **${c.day('sharma-7')}**.`,
      },
    ],
  },
  {
    match: /invoice|gst|accountant/i,
    parts: [
      {
        cite: ['neha-13'],
        text: (c) =>
          `Neha needs the **Kala Ghoda pop-up invoice by ${c.day('neha-13')}** — the accountant is closing this month's books for the GST filing.`,
      },
    ],
  },
  {
    match: /trek|rajmachi|hike|\btrip\b|owe/i,
    parts: [
      {
        cite: ['trek-16', 'trek-23', 'trek-32'],
        text: (c) =>
          `The Rajmachi trek is on **${c.day('trek-16')}, leaving Dadar at 5 AM**. You owe **₹1,450 to Arjun** (UPI by ${c.day('trek-23')}), and the group needs to know **tonight** whether you're driving or they should book a cab.`,
      },
    ],
  },
  {
    match: /order|deliver|ship|track|parcel|courier|pickup/i,
    parts: [
      {
        cite: ['priya-5', 'priya-6'],
        text: (c) =>
          `**Priya's order #MS-2041** is stuck at “label created” and she needs it before **${c.day('priya-6')}**.`,
      },
      {
        cite: ['brewbay-2'],
        text: (c) => `**Brew Bay Café** wants to order 40 custom logo mugs and has waited ${c.since('brewbay-2')} for pricing.`,
      },
      {
        cite: ['courier-3'],
        text: (c) => `Ramesh is picking up **6 boxes ${c.when('courier-3')} at 11 AM**.`,
      },
    ],
  },
  {
    match: /price|pricing|cost|how much|kitne|kitna|\brate/i,
    parts: [
      { cite: ['rohan-2'], text: '**Rohan** wants the price of a set of 6 speckled mugs, shipped to Pune.' },
      {
        cite: ['brewbay-2'],
        text: '**Brew Bay Café** wants pricing for **40 custom logo mugs** in about 3 weeks.',
      },
    ],
  },
  {
    match: /plumber|sink|landlord|leak/i,
    parts: [
      {
        cite: ['landlord-2'],
        text: (c) => `Mr. Desai is sending the plumber on **${c.day('landlord-2')} at 10 AM** — someone needs to be at the studio.`,
      },
    ],
  },
  {
    match: /dentist|dental|doctor|appointment|check-?up/i,
    parts: [
      {
        cite: ['clinic-1'],
        text: (c) => `Your dental check-up with Dr. Kulkarni is on **${c.day('clinic-1')} at 5:30 PM** at SmileCare.`,
      },
    ],
  },
  {
    match: /lunch|maa|\bmom\b|sunday/i,
    parts: [
      {
        cite: ['maa-3', 'maa-4'],
        text: "Maa asked if you're coming for **Sunday lunch** — she's making rajma chawal and Didi is coming. She's still waiting for your answer.",
      },
    ],
  },
  {
    match: /lookbook|design|print|ishaan/i,
    parts: [
      {
        cite: ['ishaan-2', 'ishaan-3'],
        text: 'Ishaan shared **lookbook v2** (new cover and planter shots) and needs your feedback **by tomorrow EOD** to make the print deadline.',
      },
    ],
  },
  {
    match: /kiln|glaze|workshop|potter/i,
    parts: [
      {
        cite: ['potters-3', 'potters-4'],
        text: (c) =>
          `Kiln firing slots for next month are open — **fill the form by ${c.day('potters-4')}**. The glaze workshop at Anita's studio is **${c.day('potters-3')} at 4 PM** (₹800).`,
      },
    ],
  },
]

export function cannedAnswer(question: string, sources: AiSearchSource[], now: number): SearchAnswer | null {
  const byId = new Map(sources.map((s) => [s.messageId, s]))
  const c = makeCtx((id) => byId.get(id), now)
  for (const candidate of ANSWERS) {
    if (!candidate.match.test(question)) continue
    const rendered = candidate.parts
      .filter((part) => part.cite.every((id) => byId.has(id)))
      .map((part) => attempt(() => ({ text: render(part.text, c), cite: part.cite })))
      .filter((part): part is { text: string; cite: string[] } => !!part)
    if (rendered.length === 0) continue
    return {
      answer: rendered.map((p) => p.text).join(' '),
      citedMessageIds: rendered.flatMap((p) => p.cite),
    }
  }
  return null
}
