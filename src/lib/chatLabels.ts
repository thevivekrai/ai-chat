import {
  Briefcase,
  CalendarDays,
  Clock,
  Heart,
  HelpCircle,
  Info,
  Lightbulb,
  Megaphone,
  Package,
  PiggyBank,
  Plane,
  Repeat2,
  ShoppingBag,
  Stethoscope,
  Timer,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import type { ChatLabel } from '@/ai'
import type { LabelSource } from '@/store/selectors'

/** How each of the AI's tags for a chat is shown. */
export const LABELS: Record<ChatLabel, { label: string; icon: LucideIcon; hint: string }> = {
  question: { label: 'Question', icon: HelpCircle, hint: 'They asked you something' },
  'follow-up': { label: 'Follow-up', icon: Repeat2, hint: "They're chasing a reply" },
  deadline: { label: 'Deadline', icon: Timer, hint: 'Something is due or happens soon' },
  payment: { label: 'Payment', icon: Wallet, hint: 'Money: a payment, bill, refund or price' },
  order: { label: 'Order', icon: Package, hint: 'An order, delivery or booking' },
  meeting: { label: 'Meeting', icon: CalendarDays, hint: 'A call, meeting or plan to meet' },
  work: { label: 'Work', icon: Briefcase, hint: 'Work, business or customers' },
  personal: { label: 'Personal', icon: Heart, hint: 'Family and friends' },
  finance: { label: 'Finance', icon: PiggyBank, hint: 'Banking, bills, salary, tax or investments' },
  travel: { label: 'Travel', icon: Plane, hint: 'Trips, tickets, hotels and directions' },
  health: { label: 'Health', icon: Stethoscope, hint: 'Doctors, prescriptions and appointments' },
  shopping: { label: 'Shopping', icon: ShoppingBag, hint: 'Buying things, prices and returns' },
  idea: { label: 'Idea', icon: Lightbulb, hint: 'Something to think about, not to do now' },
  later: { label: 'Later', icon: Clock, hint: 'Worth coming back to, but not now' },
  promo: { label: 'Promo', icon: Megaphone, hint: 'Offers, newsletters and other automated messages' },
  fyi: { label: 'FYI', icon: Info, hint: 'Nothing needed from you' },
}

/** "Why this tag?": who put it there, and the AI's reason and how sure it was. */
export function whyOf(source: LabelSource | undefined): string | undefined {
  if (!source) return undefined
  if (source.by === 'you') return 'You tagged this'
  const sure = source.confidence !== undefined ? ` · ${Math.round(source.confidence * 100)}% sure` : ''
  return `AI: ${source.why ?? 'from what the chat says'}${sure}`
}
