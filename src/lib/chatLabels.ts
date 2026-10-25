import {
  Briefcase,
  CalendarDays,
  Heart,
  HelpCircle,
  Info,
  Megaphone,
  Package,
  Repeat2,
  Timer,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import type { ChatLabel } from '@/ai'

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
  promo: { label: 'Promo', icon: Megaphone, hint: 'Offers, newsletters and other automated messages' },
  fyi: { label: 'FYI', icon: Info, hint: 'Nothing needed from you' },
}
