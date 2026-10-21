import type { NetworkId } from '@/data/types'

export interface NetworkMeta {
  id: NetworkId
  name: string
  /** Tailwind class for the identifying dot. */
  dot: string
}

export const NETWORKS: Record<NetworkId, NetworkMeta> = {
  whatsapp: { id: 'whatsapp', name: 'WhatsApp', dot: 'bg-net-whatsapp' },
  telegram: { id: 'telegram', name: 'Telegram', dot: 'bg-net-telegram' },
  instagram: { id: 'instagram', name: 'Instagram', dot: 'bg-net-instagram' },
  slack: { id: 'slack', name: 'Slack', dot: 'bg-net-slack' },
  sms: { id: 'sms', name: 'SMS', dot: 'bg-net-sms' },
}

export const NETWORK_ORDER: NetworkId[] = ['whatsapp', 'telegram', 'instagram', 'slack', 'sms']
