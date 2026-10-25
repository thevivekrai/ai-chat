import { siInstagram, siMatrix, siTelegram, siWhatsapp } from 'simple-icons'
import type { NetworkId } from '@/data/types'

export interface NetworkMeta {
  id: NetworkId
  name: string
  /** SVG path (24×24 viewBox) of the network's mark, drawn in white on `background`. */
  icon: string
  /** CSS background of the round badge that holds the mark. */
  background: string
}

/** The Slack mark, which simple-icons no longer ships: four pill-and-dot pairs in a pinwheel. */
const SLACK_MARK =
  'M5.04 15.17a2.53 2.52 0 0 1-2.52 2.52A2.53 2.52 0 0 1 0 15.17a2.53 2.52 0 0 1 2.52-2.52h2.52zm1.27 0a2.53 2.52 0 0 1 2.52-2.52 2.53 2.52 0 0 1 2.52 2.52v6.31A2.53 2.52 0 0 1 8.83 24a2.53 2.52 0 0 1-2.52-2.52zM8.83 5.04a2.53 2.52 0 0 1-2.52-2.52A2.53 2.52 0 0 1 8.83 0a2.53 2.52 0 0 1 2.52 2.52v2.52zm0 1.27a2.53 2.52 0 0 1 2.52 2.52 2.53 2.52 0 0 1-2.52 2.52H2.52A2.53 2.52 0 0 1 0 8.83a2.53 2.52 0 0 1 2.52-2.52zm10.12 2.52a2.53 2.52 0 0 1 2.52-2.52A2.53 2.52 0 0 1 24 8.83a2.53 2.52 0 0 1-2.52 2.52h-2.52zm-1.27 0a2.53 2.52 0 0 1-2.52 2.52 2.53 2.52 0 0 1-2.52-2.52V2.52A2.53 2.52 0 0 1 15.17 0a2.53 2.52 0 0 1 2.52 2.52zm-2.52 10.12a2.53 2.52 0 0 1 2.52 2.52A2.53 2.52 0 0 1 15.17 24a2.53 2.52 0 0 1-2.52-2.52v-2.52zm0-1.27a2.53 2.52 0 0 1-2.52-2.52 2.53 2.52 0 0 1 2.52-2.52h6.31A2.53 2.52 0 0 1 24 15.17a2.53 2.52 0 0 1-2.52 2.52z'

/** Two overlapping speech bubbles for Guffshuff, the user's own chat site. */
const GUFFSHUFF_MARK =
  'M8.5 2h9A4.5 4.5 0 0 1 22 6.5v5a4.5 4.5 0 0 1-4.5 4.5h-.8l-3.1 2.6a.6.6 0 0 1-1-.46V16H8.5A4.5 4.5 0 0 1 4 11.5v-5A4.5 4.5 0 0 1 8.5 2zm-2.2 15.9A5.5 5.5 0 0 0 8.5 18h1.2v.5A3.5 3.5 0 0 0 13.2 22h2.6l2.3 1.9a.5.5 0 0 0 .8-.38V22h.6a3.5 3.5 0 0 0 .9-.12 5.5 5.5 0 0 1-3.9 1.62z'

/** Speech bubble for SMS, which has no brand of its own. */
const SMS_MARK =
  'M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9.2l-4.4 3.5a.6.6 0 0 1-1-.47V18H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm3 5.2a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zm5 0a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zm5 0a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2z'

export const NETWORKS: Record<NetworkId, NetworkMeta> = {
  whatsapp: { id: 'whatsapp', name: 'WhatsApp', icon: siWhatsapp.path, background: `#${siWhatsapp.hex}` },
  telegram: { id: 'telegram', name: 'Telegram', icon: siTelegram.path, background: `#${siTelegram.hex}` },
  instagram: {
    id: 'instagram',
    name: 'Instagram',
    icon: siInstagram.path,
    background:
      'radial-gradient(circle at 30% 107%, #fdf497 0%, #fdf497 5%, #fd5949 45%, #d6249f 60%, #285aeb 90%)',
  },
  slack: { id: 'slack', name: 'Slack', icon: SLACK_MARK, background: '#4a154b' },
  sms: { id: 'sms', name: 'SMS', icon: SMS_MARK, background: '#64748b' },
  matrix: { id: 'matrix', name: 'Matrix', icon: siMatrix.path, background: '#0f1115' },
  guffshuff: { id: 'guffshuff', name: 'Guffshuff', icon: GUFFSHUFF_MARK, background: '#6d28d9' },
}

export const NETWORK_ORDER: NetworkId[] = ['whatsapp', 'telegram', 'guffshuff', 'instagram', 'slack', 'sms', 'matrix']
