import { DAY } from '@/lib/time'

/** Working name for the app. Change it here. */
export const APP_NAME = 'Sytext'

/** Threads with at least this many messages get an automatic one-line summary on top. */
export const LONG_THREAD_MESSAGES = 12

/** Show the "Unanswered for 2d" badge once someone has waited this long. */
export const UNANSWERED_BADGE_AFTER = DAY

/**
 * How long a chat waits for my reply: once their last message is this old, it leaves Needs reply
 * (and loses its "Unanswered" badge). By then it's history rather than a to-do; it stays in All
 * chats, and comes back the moment they write again.
 */
export const NEEDS_REPLY_FOR = 7 * DAY
