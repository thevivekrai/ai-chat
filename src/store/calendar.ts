import { create } from 'zustand'
import { serverApi, ServerError } from '@/data/server/serverApi'
import type { CalendarStatus } from '@/data/server/types'
import type { Task } from '@/data/types'
import { useInbox } from './inbox'
import { toast } from './toasts'

/**
 * Tasks kept as events in the user's Google Calendar. The server holds the access (Google's
 * consent comes back to it); this side tells it when a task is made, changed or deleted.
 *
 * Any task without an event yet gets one, whenever it turns up: made here, added on another
 * device, or made before the calendar was connected.
 */

interface CalendarState {
  /** Null until asked, and when there's no account to ask for. */
  status: CalendarStatus | null
  refresh(): Promise<void>
  /** Off to Google's consent screen; it comes back to /tasks. */
  connect(): void
  disconnect(): Promise<void>
  forget(): void
}

/** How Google's consent screen came back, read before the router tidies the address. */
let landed = typeof window === 'undefined' || !window.location ? null : new URLSearchParams(window.location.search).get('calendar')
// Said once, in a toast; not kept in the address to be said again on reload.
if (landed) window.history.replaceState(window.history.state, '', window.location.pathname)

/** The tasks that have an event (or are being given one). */
let synced = new Set<string>()

export const useCalendar = create<CalendarState>()((set) => ({
  status: null,

  async refresh() {
    const status = await Promise.resolve()
      .then(() => serverApi.calendar())
      .catch(() => null)
    synced = new Set(status?.synced ?? [])
    set({ status })
    watchTasks()
    catchUp()
    const outcome = landed
    landed = null
    if (!outcome || !status) return
    if (outcome === 'connected' && status.connected) {
      toast({ title: 'Google Calendar connected', description: 'Your tasks will show up there as events.' })
    } else if (outcome === 'declined') {
      toast({ title: 'Google Calendar not connected', description: 'Google wasn’t given access, so nothing was changed.' })
    } else if (outcome === 'error') {
      toast({ title: 'Couldn’t connect Google Calendar', description: 'The answer from Google didn’t check out. Try again.' })
    }
  },

  connect() {
    window.location.assign('/api/calendar/connect')
  },

  async disconnect() {
    try {
      set({ status: await serverApi.disconnectCalendar() })
      synced = new Set()
      toast({ title: 'Google Calendar disconnected', description: 'Events already made stay in your calendar.' })
    } catch (error) {
      toast({ title: 'Couldn’t disconnect', description: error instanceof Error ? error.message : undefined })
    }
  },

  forget() {
    synced = new Set()
    set({ status: null })
  },
}))

const connected = () => {
  const status = useCalendar.getState().status
  return !!status?.connected && !status.problem
}

/** Gives every task that has no event yet its event. */
function catchUp() {
  if (!connected()) return
  for (const task of useInbox.getState().tasks) if (!synced.has(task.id)) void syncTask(task)
}

// New tasks, from here or anywhere else, as they arrive. (Started on first use: the inbox store
// imports this one, so it isn't there yet while this module loads.)
let watching = false
function watchTasks() {
  if (watching) return
  watching = true
  useInbox.subscribe((s, before) => {
    if (s.tasks !== before.tasks) catchUp()
  })
}

/** Google turning a change away is said once a minute at most, not for every task. */
let lastComplaint = 0
async function quietly(change: Promise<unknown>) {
  try {
    await change
    return true
  } catch (error) {
    if (error instanceof ServerError && error.status === 409) {
      void useCalendar.getState().refresh()
    } else if (Date.now() - lastComplaint >= 60_000) {
      lastComplaint = Date.now()
      toast({ title: 'Google Calendar wasn’t updated', description: error instanceof Error ? error.message : undefined, group: 'calendar' })
    }
    return false
  }
}

/** Where the task came from, for the event's description. */
function noteFor(task: Task) {
  const thread = task.source && useInbox.getState().threads[task.source.threadId]
  return thread ? `From the chat with ${thread.title}` : undefined
}

/** A task made or changed: its event follows, when the calendar is connected. */
export async function syncTask(task: Task) {
  if (!connected()) return
  synced.add(task.id)
  // Not made after all: tried again with the next change.
  if (!(await quietly(serverApi.syncTask(task, noteFor(task))))) synced.delete(task.id)
}

/** A task deleted: its event goes too. */
export async function unsyncTask(taskId: string) {
  if (!connected() || !synced.has(taskId)) return
  synced.delete(taskId)
  await quietly(serverApi.unsyncTask(taskId))
}
