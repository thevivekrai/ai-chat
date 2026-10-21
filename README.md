# Tidings — an AI-first unified inbox (prototype)

People with chats spread across WhatsApp, Telegram, Instagram, Slack and SMS lose track of who is
waiting on them, and replying takes effort. This prototype puts every chat in one place, tells you
**who needs a reply** (sorted by AI priority and how long they've waited) and **drafts the reply**
for you. Nothing is ever sent automatically.

It is a front-end prototype with realistic mock data: 15 conversations across 5 networks, generated
relative to the current time, in English and casual Hinglish. There are no real integrations yet;
the code is structured so a Matrix-bridge backend and a real LLM can replace the mocks.

![Needs-reply queue with AI priorities, a conversation, suggested drafts and the AI panel](docs/screenshots/inbox-light.jpg)

## Run it

Requires Node 20.19+ or 22.12+.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (Vitest)
npm run build      # typecheck + production build
npm run lint
```

**Try this:** click **Turn on AI** (AI is off until you allow it) · press `J`/`K` to move through the
queue · `R` for drafts, `1`–`3` to pick one, edit, `Enter` to send · `E` to mark done · `⌘K`/`Ctrl+K`
and ask *"what did the supplier quote me?"* · **Settings → Simulate incoming message** to watch the
queue react. **Settings → Reset demo data** regenerates everything relative to now.

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| `J` / `K` | Next / previous chat | `E` | Mark done |
| `Enter` | Reply (focus composer) | `S` | Snooze |
| `R` | Draft replies | `A` | Toggle AI panel |
| `1` `2` `3` | Use a draft | `⌘K` / `Ctrl+K` | Search & ask across chats |
| `Tab` | Next `[blank]` in a draft | `/` · `?` · `Esc` | Filter list · Help · Close |

## How it's built

React 19 + TypeScript + Vite, Tailwind CSS v4, Zustand, Motion for transitions.

```
src/
  data/
    api.ts          ← the ONLY data-access module: InboxApi interface + the active implementation
    types.ts        ← domain model (Thread, Message, Contact, Task…)
    mock/           ← in-browser mock backend: seed data, localStorage "server", search
  ai/
    index.ts        ← draftReply, summarizeThread, classifyPriority, extractTasks, answerQuestion
    access.ts       ← privacy gate every AI function checks
    llm.ts          ← the single place a real model gets called (stub today)
    prompts.ts      ← ready-to-use prompts for each function
    mock/           ← canned results for the demo chats + rule-based fallback
  store/            ← Zustand stores (inbox cache, AI results, UI, settings) and cross-store actions
  components/       ← layout, thread list, conversation, AI panel, command bar, settings…
```

Data flows one way: **components → stores → `api` / `ai`**. Components never import mock data, and
the inbox store only caches what `api` returns (the initial load, its own writes and pushed
`InboxEvent`s); it never persists chat data itself. The "Needs reply" queue is derived
(`store/selectors.ts`): the other person wrote last, it expects a response (AI decides when allowed,
simple on-device rules otherwise), and it isn't done, snoozed or scheduled.

**Privacy.** Chats are stored in this browser (`localStorage`), and the header says so. AI is off by
default; **Settings → Allow AI to read selected threads** turns it on for the chats you pick (or allow
a single chat from its AI panel). The gate is enforced inside `src/ai/access.ts`, not just in the UI, so
an unselected chat can't reach a model even by accident. Turning AI off clears AI results from the device.

## Swapping the mock API for real bridges

Everything goes through `InboxApi` in `src/data/api.ts`. To connect real networks, write a second
implementation, for example `src/data/matrix/matrixApi.ts` using `matrix-js-sdk` against a homeserver
running the mautrix bridges (whatsapp, telegram, meta for Instagram, slack, gmessages for SMS), and
change one line:

```ts
// src/data/api.ts
export const api: InboxApi = createMatrixApi({ baseUrl, accessToken })
```

| `InboxApi` | Matrix |
| --- | --- |
| `loadInbox()` | Initial `/sync` (or sliding sync). Each bridged *portal room* is a `Thread`; `network` comes from the bridge that owns the room (its `m.bridge` state event); `Contact`s are the bridge's ghost users; `messages` is each room's recent timeline. |
| `subscribe(listener)` | The sync loop: map `m.room.message` timeline events to `message.created`, receipts and edits to `message.updated`, and room account data changes to `thread.updated`. |
| `sendMessage()` | `client.sendMessage(roomId, { msgtype: 'm.text', body })`; the bridge relays it to the network. Attachments are `m.file` / `m.image` with `mxc://` URLs. |
| `markRead()` | Read receipt + `m.fully_read` marker. |
| `updateThreadState()` | Store `doneAt` / `snoozedUntil` in room account data (e.g. type `com.example.inbox.state`) so queue state syncs across devices. |
| `scheduleMessage()` & co. | Delayed events (MSC4140) where the homeserver supports them, otherwise a small server-side scheduler. |
| `searchMessages()` | Server `/search` for unencrypted rooms. Bridged rooms are often end-to-end encrypted, so index decrypted messages locally (SQLite FTS / IndexedDB, or embeddings for semantic search). |
| `addTask()` & co. | Account data, or your own store. |
| `demo` | Leave undefined; the demo controls disappear from Settings. |

Things the prototype leaves out that a real backend needs: paginating older messages (`/messages`),
merging one person's identities across networks, bridge login flows, and handling send failures
(the UI already shows a `failed` status).

## Plugging in a real LLM

1. **Implement `complete()` in `src/ai/llm.ts`.** Call your own backend endpoint (keep provider API
   keys off the client) or an on-device model. It takes `{ system, user, json }` and returns text.

   ```ts
   export async function complete(request: LlmRequest): Promise<string> {
     const res = await fetch('/api/ai/complete', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify(request),
     })
     if (!res.ok) throw new Error(`AI request failed: ${res.status}`)
     return (await res.json()).text
   }
   ```

2. **Replace the mock in each function.** Every file in `src/ai/` has a `TODO(LLM)` comment showing
   the exact swap, using the prompt builders in `src/ai/prompts.ts`, e.g. in `classifyPriority.ts`:

   ```ts
   const raw = await complete(buildPriorityPrompt(thread, new Date()))
   return parseJson<PriorityResult>(raw)
   ```

3. **Delete `src/ai/mock/` and `src/ai/latency.ts`.** Loading states, caching and error handling are
   already in place: results are cached per thread state in `src/store/ai.ts` (keyed by the latest
   message), so the model only runs when a chat changes.

Notes: keep the `assertAiCanRead()` calls — they are the consent check. A model sees only the
`AiThread` (`src/ai/types.ts`) for the chat in question, and `answerQuestion` only receives messages
from chats the user allowed. A small, fast model suits `classifyPriority` (it runs for every allowed
chat when it changes); drafts benefit from a stronger one. Drafts only ever fill the composer.

![Ask across chats: an AI answer with its source messages](docs/screenshots/ask-dark.jpg)
