# Tidings — an AI-first unified inbox

People with chats spread across WhatsApp, Telegram, Instagram, Slack and SMS lose track of who is
waiting on them, and replying takes effort. Tidings puts every chat in one place, tells you **who
needs a reply** (sorted by AI priority and how long they've waited) and **drafts the reply** for you.
Nothing is ever sent automatically.

It runs entirely in the browser, with no server of its own:

- **Real accounts.** Connect a **Telegram bot**, and a **Matrix** account. Through Matrix bridges
  you also get WhatsApp, Instagram, Slack and SMS.
- **Real AI.** Add your **Claude API key** and every AI feature calls Claude. Without one, a
  built-in demo AI runs on the device.
- **Demo inbox.** 15 sample conversations across five networks, generated relative to now, in
  English and Hinglish. It's on by default and can be turned off once your own chats are in.

The interface is clear "liquid glass": nearly untinted, lightly blurred columns with bright specular
edges, floating over a neutral silver (or graphite) backdrop of soft light and a few crisp shapes
that the glass softens as they pass behind it. Light and dark.

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

It's a static site: `npm run build` produces `dist/`, which any static host can serve.
`render.yaml` deploys it as a Render static site.

**Try this:** click **Turn on AI** · press `J`/`K` to move through the queue · `R` for drafts,
`1`–`3` to pick one, edit, `Enter` to send · `E` to mark done · `⌘K`/`Ctrl+K` and ask *"what did
the supplier quote me?"* · then open **Settings** to connect your own accounts and a Claude key.

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| `J` / `K` | Next / previous chat | `E` | Mark done |
| `Enter` | Reply (focus composer) | `S` | Snooze |
| `R` | Draft replies | `A` | Toggle AI panel |
| `1` `2` `3` | Use a draft | `⌘K` / `Ctrl+K` | Search & ask across chats |
| `Tab` | Next `[blank]` in a draft | `/` · `?` · `Esc` | Filter list · Help · Close |

## Connect your accounts

Everything is in **Settings → Accounts**. Messages travel directly between your browser and each
network, and are kept in this browser's storage. Tokens are stored there too, so use a browser
profile you trust; **Disconnect** deletes an account's token and chats from the device.

### Telegram bot

Customers or friends message your bot (or a group it's in) and you answer as the bot. This uses the
Telegram Bot API, not your personal account; for that, use Matrix with the Telegram bridge.

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot` and copy the token.
2. To read group chats, also send `/setprivacy` → your bot → **Disable**.
3. Paste the token in **Settings → Accounts → Telegram bot**. It's checked with Telegram first.

Bots can't fetch chat history, only new messages, which Telegram keeps for 24 hours. So chats
start from the moment the bot is connected, and messages that arrive while Tidings is closed are
picked up when it opens. Only one browser tab polls Telegram (it allows a single reader per bot);
other tabs follow along. If the bot already delivers to a webhook, Settings offers to switch it
over. You can also point it at a self-hosted `telegram-bot-api` server.

### Matrix, and WhatsApp, Instagram, Slack and SMS through bridges

Sign in to any Matrix homeserver with a password, or paste an access token from another Matrix app
(needed for servers that only allow single sign-on). Every joined room becomes a chat.

Rooms created by [mautrix](https://docs.mau.fi/bridges/) bridges announce what they bridge (an
`m.bridge` state event), so a WhatsApp chat appears under **WhatsApp**, shows the contact's phone
number, and replies go out on WhatsApp. This covers mautrix-whatsapp, -meta (Instagram), -slack,
-gmessages (SMS/RCS) and -telegram. Run the bridges on your own homeserver; most bridges require
that, and it keeps your chats on infrastructure you control.

- The homeserver must allow requests from the site (CORS). Synapse does by default.
- **End-to-end encryption isn't supported yet.** Messages in encrypted rooms show as locked, and
  replying there is refused with an explanation. Bridges can be configured to keep portal rooms
  unencrypted (the `encryption` section of their config).
- Disconnecting signs out the session Tidings created. A pasted access token belongs to another
  app, so that session is left alone.

### The demo inbox

**Settings → Accounts → Demo chats** shows or hides the sample conversations. While they're shown,
you can simulate an incoming message or reset them.

## AI with Claude

Add a key in **Settings → AI** (create one in the [Claude Console](https://platform.claude.com/settings/keys)).
It is checked with Anthropic, stored only in this browser, and sent only to `api.anthropic.com`.

| Feature | Model (default) | Effort |
| --- | --- | --- |
| Sorting the queue: priority, and whether a reply is expected | Claude Haiku 5.5 | low |
| Summaries and detected tasks | Claude Opus 5.5 | low |
| Drafts (all three tones in one request) and answers in ⌘K | Claude Opus 5.5 | medium |

Both models can be changed in Settings. Sorting gets the fast model by default because it runs
for every allowed chat whenever that chat changes.

How it's called (`src/ai/llm.ts`, `src/ai/claude.ts`):

- **SDK.** The official `@anthropic-ai/sdk`, from the browser
  (`dangerouslyAllowBrowser`). That's appropriate here because it's your own key on your own
  device. A hosted, multi-user deployment should proxy requests through a backend instead.
- **Structured output.** Every request asks for it, with zod schemas, so results arrive already
  parsed. Ids and dates the model returns are checked against the chat before they're used.
- **Server-side fallbacks are on** (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`).
  If a model declines a request on policy grounds, the API retries it on a fallback model in the
  same call. Haiku 5.5 has no fallback, so a declined request there simply fails. A final
  `stop_reason: "refusal"` is shown as such.
- **Limits.** At most three requests run at once, and interactive ones (drafts, answers, the open
  chat) go ahead of background sorting.
- **Errors.** A rejected key or unavailable model pauses automatic calls and says so. Other errors
  show their reason next to the result, with a retry.

Results are cached per chat, keyed on its latest message, so Claude only runs again when a chat
changes. Without a key, the same functions use the built-in demo AI (`src/ai/mock/`): canned
results for the demo chats and simple rules elsewhere.

**Privacy.** AI is off until you allow it, and then only for the chats you select (**Settings →
AI**, or a single chat from its AI panel). New chats stay unselected until you allow them. The gate
lives inside the AI module (`src/ai/access.ts`), not just the UI, so an unselected chat can't reach
a model even by accident. With a Claude key, the allowed chats are sent to Anthropic when a feature
needs them. Turning AI off clears AI results from the device.

![Ask across chats: an AI answer with its source messages](docs/screenshots/ask-dark.jpg)

## How it's built

React 19 + TypeScript + Vite, Tailwind CSS v4, Zustand, Motion.

```
src/
  data/
    api.ts            ← the only data-access module: InboxApi + ConnectionsApi
    unified/          ← merges every source; routes by id prefix; done/snoozed, tasks and
                        scheduled sends for real accounts, kept on the device
    connectors/
      telegram/       ← Bot API client and connector (long polling, local message store)
      matrix/         ← matrix-js-sdk connector, loaded on demand; bridge detection
    mock/             ← the demo inbox: seed data and a localStorage "server"
    search.ts         ← keyword search used for every source
  ai/
    index.ts          ← draftReply, summarizeThread, classifyPriority, extractTasks, answerQuestion
    access.ts         ← privacy gate every AI function checks
    llm.ts            ← Claude config, request limiter, errors
    claude.ts         ← Claude calls: schemas, structured output, fallbacks (loaded on demand)
    prompts.ts        ← the prompt for each function
    mock/             ← the built-in demo AI
  store/              ← Zustand stores (inbox cache, AI results, connections, UI, settings) and actions
  components/         ← layout, thread list, conversation, AI panel, command bar, settings…
```

Data flows one way: **components → stores → `api` / `ai`**. Components never import a source
directly. The inbox store only caches what `api` returns: the initial load, its own writes, and
the events every source pushes.

The "Needs reply" queue is derived (`store/selectors.ts`). A chat is in it when:
- the other person wrote last;
- it expects a response (AI decides when allowed, simple on-device rules otherwise);
- it isn't done, snoozed or scheduled.

Ids carry their source (`tg:…`, `mx:…`, none for demo chats), so writes route without lookups. To
add a network, implement `Connector` (`src/data/connectors/types.ts`) and register it in
`src/data/unified/unifiedApi.ts`.

The Matrix SDK (~900 kB) and the Claude SDK are separate chunks, downloaded only once Matrix is
connected or a key is saved.

### Tests

- **Unit tests (`npm test`)** cover the demo data, search, selectors and reply rules, and the demo AI.
- **Claude requests.** A stubbed `fetch` checks the request shape (model, effort, structured
  output, fallbacks, no sampling parameters), refusals and error mapping.
- **Telegram connector.** Tested against an in-memory Bot API.
- **Unified inbox.** Merging, routing, local done/snooze state, scheduled sends, search and
  disconnecting.

The connectors were also run end-to-end in a browser against a local Synapse homeserver (with a
simulated WhatsApp bridge room) and a local Telegram Bot API server.

## Limits and next steps

- **Encryption.** Matrix end-to-end encrypted rooms (matrix-js-sdk's Rust crypto plus device
  verification).
- **History.** Only recent messages load: the last 30 per Matrix room, and what a Telegram bot has
  seen. Scrolling back doesn't fetch older ones yet.
- **Scheduled sends** go out while Tidings is open. One that was due while it was closed waits for
  you instead of arriving hours late. Matrix delayed events (MSC4140) would let the server send them.
- **Sync across devices.** Done, snoozed and tasks live on one device. For Matrix they could sync
  through room account data.
- **One person, one chat.** The same person on several networks isn't merged yet.
- **Notifications.** No push notifications.
