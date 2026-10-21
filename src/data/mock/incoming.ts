/**
 * Messages the demo can "receive" on demand (Settings → Simulate incoming message), to show the
 * Needs-reply queue reacting live. A real backend pushes these through `subscribe()` instead.
 */
export const INCOMING_POOL: { threadId: string; senderId: string; body: string }[] = [
  { threadId: 'rohan', senderId: 'c-rohan', body: 'Also, do you have them in white? My wife loves white ceramics 🙂' },
  { threadId: 'arjun', senderId: 'c-arjun', body: 'Yes got it bro, thanks! Pics are 🔥' },
  { threadId: 'studio-ops', senderId: 'c-ravi', body: "I'll handle the pickup tomorrow, Simran is off" },
  { threadId: 'priya', senderId: 'c-priya', body: 'Hello? Any update please 🙏' },
  { threadId: 'zoya', senderId: 'c-zoya', body: 'Also bring the mug you promised me 😜' },
  {
    threadId: 'ishaan',
    senderId: 'c-ishaan',
    body: 'Small heads-up: the printer wants files by noon, so the earlier the better 🙏',
  },
  { threadId: 'maa', senderId: 'c-maa', body: 'Beta reply toh karo 😅' },
]
