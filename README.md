# Sytext — an AI-first unified inbox

People with chats spread across WhatsApp, Telegram, Instagram, Slack and SMS lose track of who is
waiting on them, and replying takes effort. Sytext puts every chat in one place, tells you **who
needs a reply** (sorted by AI priority and how long they've waited) and **drafts the reply** for you.
Nothing is ever sent automatically.

- **Accounts.** Sign in with **Google**, or with an **email and password**.
- **Your own WhatsApp and Telegram.** Link **WhatsApp** by typing the 8-character code Sytext
  shows into *Linked devices* on your phone (or scanning a QR code), the way WhatsApp Web links.
  Link **Telegram** with your phone number, the login code Telegram sends you and, if you use it,
  your two-step password. Your chats sync to the inbox on every device you sign in on, and you
  reply from Sytext.
- **More connections from the browser.** A **Telegram bot**, and a **Matrix** account (through
  Matrix bridges: WhatsApp, Instagram, Slack and SMS).
- **Real AI.** Add your **Claude API key** and every AI feature calls Claude. Without one, a
  built-in demo AI runs on the device.
- **Demo inbox.** 15 sample conversations across five networks, generated relative to now, in
  English and Hinglish. Try it without an account, too.

Sytext is a web app plus a small Node server (`server/`) that handles sign-in and keeps the
WhatsApp and Telegram links running. Without the server (say, built as a static site) the app still
works: just the demo, the browser connections and AI, with no accounts.

The interface is clear "liquid glass": nearly untinted, lightly blurred columns with bright specular
edges, floating over a neutral silver (or graphite) backdrop of soft light and a few crisp shapes
that the glass softens as they pass behind it. Light and dark.

![Needs-reply queue with AI priorities, a conversation, suggested drafts and the AI panel](docs/screenshots/inbox-light.jpg)

## Run it

Requires Node 22.12+ and, for accounts, a MongoDB database (local, or a free MongoDB Atlas cluster).

```bash
npm install
cp .env.example .env    # then fill in MONGODB_URI and JWT_SECRET at least
npm run dev:server      # the API on :5001, restarting on changes
npm run dev             # the app on http://localhost:5173 (forwards /api to the server)
npm test                # unit tests (Vitest); see Tests for the database ones
npm run build           # typecheck, the web app (dist/) and the server (dist-server/)
npm start               # production: the API and the built app on $PORT
npm run lint
```

### Deploy on Render

`render.yaml` describes one **Web Service** that serves both the API and the app. Either create it
from the Blueprint, or make a Web Service by hand with:

| Setting | Value |
| --- | --- |
| Build command | `npm ci --include=dev && npm run build` |
| Start command | `npm start` |
| Health check path | `/api/health` |

Then set the environment variables (**Environment** tab). `MONGODB_URI` and `JWT_SECRET` are
required; `.env.example` explains every variable:

| Variable | What it does |
| --- | --- |
| `MONGODB_URI` | Your database. With MongoDB Atlas, allow connections from Render (Network Access). |
| `JWT_SECRET` | Signs sessions: 32+ random characters (`openssl rand -base64 48`). |
| `DATA_ENCRYPTION_KEY` | Encrypts stored chats and sessions (`openssl rand -base64 32`; the Blueprint generates one). |
| `GOOGLE_CLIENT_ID` | Turns on "Continue with Google". |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | Turn on linking Telegram accounts. |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Profile photos, and pictures in linked chats. |

`PORT` is optional: the server listens where Render tells it to.

Keep these values out of the repository, screenshots and chats. If one has been shared, rotate it:
a new database user password (and `MONGODB_URI`), a new Cloudinary API secret, and a new
`JWT_SECRET` (which signs everyone out).

Things to know about hosting:

- **Run one instance.** Each WhatsApp and Telegram link lives in the server process, and WhatsApp
  allows one connection per linked device.
- **Free instances sleep** after 15 minutes without visits, and linked accounts only sync while the
  server runs. When it wakes, it reconnects and catches up: Telegram fetches what's new in your
  recent chats, and WhatsApp delivers what it held for the linked device. For syncing around the
  clock, use an always-on instance.

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

## Sign in

The first screen offers **Continue with Google**, email and password, or the demo without an
account.

- **Sessions** are a signed token in an `httpOnly`, `SameSite=Lax` cookie (secure in production),
  valid for 30 days. Every change to the server must be sent as JSON, which a page on another site
  can't do without the server's permission, so the cookie can't be used from elsewhere (CSRF).
- **Passwords** are hashed with scrypt. Sign-in attempts are rate-limited per IP address.
- **Google**: the ID token from Google's button is verified on the server (signature, issuer,
  audience, expiry, verified email). Signing in with Google to an existing account with the same
  email links the two, and turns that account's password off and ends its sessions, since email
  addresses aren't verified on sign-up and whoever set the password may not own the address. The
  user can then set a new password under **Settings → Profile**.

To turn on Google sign-in, create an OAuth client id of type *Web application* in the
[Google Cloud console](https://console.cloud.google.com/apis/credentials), add your site's address
(and `http://localhost:5173`) under *Authorized JavaScript origins*, and set `GOOGLE_CLIENT_ID`.

**Settings → Profile** changes your name, photo (with Cloudinary set up) and password, and signs out.

## Link WhatsApp and Telegram

In **Settings → Accounts** (or the account menu → *WhatsApp and Telegram*), once signed in.

### WhatsApp

Enter your number and Sytext shows an 8-character code. On your phone, open WhatsApp →
**Settings → Linked devices → Link a device → Link with phone number instead**, and type it in. Or
choose **QR code** and scan it from the same screen. Sytext becomes one of your linked devices,
like WhatsApp Web; your phone doesn't have to stay online.

![Linking WhatsApp: the pairing code and where to enter it](docs/screenshots/link-whatsapp.jpg)

- It brings in your recent chats (up to 40 messages each) and every new message after that, with
  delivery and read ticks for yours, edits and deletions. Pictures that arrive are copied to
  Cloudinary so the app can show them; other media shows as a labelled attachment.
- Reading a chat in Sytext marks it read on WhatsApp; replies go out from your number.
- **Unlink** logs the device out (it disappears from *Linked devices*) and deletes its chats from
  the server. If you remove the device from your phone instead, syncing stops and Settings offers
  to link again or remove its chats.
- It uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web client.
  WhatsApp doesn't support third-party clients and can restrict numbers that use them; the app
  says so before linking.

### Telegram

Enter your number; Telegram sends a login code to your Telegram app (or by SMS). Enter it, and your
two-step verification password if you have one. Sytext signs in as you, like Telegram on a new
device, and shows up in Telegram under **Settings → Devices**, where you can end it.

- Your 30 most recent chats come in (20 messages each; broadcast channels are left out), then
  everything new, with read status both ways, edits, and pictures as above.
- **Unlink** ends the session in Telegram and deletes its chats from the server.
- The server needs an `api_id` and `api_hash` for the deployment from
  [my.telegram.org](https://my.telegram.org) → *API development tools*. It uses
  [GramJS](https://gram.js.org), a client for Telegram's own API (MTProto).

### What the server keeps

Per user: the linked sessions, and the synced chats, contacts and messages. Session keys, chat and
contact names, message text and attachments are **encrypted at rest** (AES-256-GCM, with
`DATA_ENCRYPTION_KEY`), so a copy of the database alone reveals no chats. Ids, times and counts stay
readable so the database can sort them. Done/snoozed state, tasks and AI results stay in the
browser, as for every other source; signing out clears those for linked chats from the browser.

## More connections, from the browser

Also in **Settings → Accounts**. These talk to their networks directly from your browser, without
the server, and keep their messages in this browser's storage. Tokens are stored there too, so use
a browser profile you trust; **Disconnect** deletes an account's token and chats from the device.

### Telegram bot

Customers or friends message your bot (or a group it's in) and you answer as the bot. This uses the
Telegram Bot API, not your personal account; for that, use Matrix with the Telegram bridge.

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot` and copy the token.
2. To read group chats, also send `/setprivacy` → your bot → **Disable**.
3. Paste the token in **Settings → Accounts → Telegram bot**. It's checked with Telegram first.

Bots can't fetch chat history, only new messages, which Telegram keeps for 24 hours. So chats
start from the moment the bot is connected, and messages that arrive while Sytext is closed are
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
- Disconnecting signs out the session Sytext created. A pasted access token belongs to another
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

Ids carry their source (`wa:…` and `tga:…` from the server, `tg:…`, `mx:…`, none for demo chats),
so writes route without lookups. To add a network, implement `Connector`
(`src/data/connectors/types.ts`) and register it in `src/data/unified/unifiedApi.ts`.

The server (Express 5, MongoDB, TypeScript run by `tsx` in development and bundled by Vite for
production):

```
server/
  index.ts            ← reads the environment, connects, starts, reconnects linked accounts
  app.ts              ← the HTTP app: security headers, JSON-only API, the built web app
  config.ts           ← environment variables; what's required, what turns features on
  auth/               ← sign-up, sign-in, Google ID tokens, scrypt passwords, session tokens
  networks/
    whatsapp.ts       ← Baileys: pairing code / QR, sessions in MongoDB, history, live sync
    telegram.ts       ← GramJS: phone + code + 2FA, sessions, dialogs, live sync
    accounts.ts       ← linked accounts and their status
    routes.ts         ← /api/link/…
  inbox/              ← per-user chat store (encrypted fields) and /api/inbox, /api/threads/…
  realtime.ts         ← server-sent events (/api/events) to the user's open tabs
  crypto.ts           ← AES-256-GCM for data at rest
```

In the browser, `src/data/server/` is the client: `serverApi.ts` for HTTP, and `ServerConnector`,
which loads `/api/inbox` and then follows `/api/events`, reloading whenever the stream reconnects
so nothing is missed. The wire types (`src/data/server/types.ts`) are shared by both sides.

The Matrix SDK (~900 kB) and the Claude SDK are separate chunks, downloaded only once Matrix is
connected or a key is saved.

### Tests

- **Unit tests (`npm test`)** cover the demo data, search, selectors and reply rules, and the demo AI.
- **Server.** Sealing, passwords, session tokens, Google ID tokens (against a local key set),
  config, and mapping Telegram's objects. With `TEST_MONGODB_URI` set (any MongoDB; each run uses
  and drops its own database), integration tests run the whole API against fake WhatsApp and
  Telegram transports: sign-up and sign-in, Google account linking, CSRF and forged cookies,
  linking both networks step by step, history, live messages, edits, read receipts, sending,
  restarts, ended sessions, unlinking, and that stored text is encrypted.

  ```bash
  TEST_MONGODB_URI=mongodb://127.0.0.1:27017 npm test
  ```
- **Server connector.** Loading, live events, routing sends and read markers, holding back the
  echo of a message being sent, and clean-up on sign-out.
- **In a browser.** `server/testing/e2e.ts` runs the app against the same fakes, with a control
  port standing in for the phone, for clicking through linking end to end.
- **Claude requests.** A stubbed `fetch` checks the request shape (model, effort, structured
  output, fallbacks, no sampling parameters), refusals and error mapping.
- **Telegram connector.** Tested against an in-memory Bot API.
- **Unified inbox.** Merging, routing, local done/snooze state, scheduled sends, search and
  disconnecting.

The connectors were also run end-to-end in a browser against a local Synapse homeserver (with a
simulated WhatsApp bridge room) and a local Telegram Bot API server.

## Limits and next steps

- **WhatsApp and Telegram media.** Pictures are shown; other media are labelled, and sending is
  text only.
- **One server instance**, and linked accounts sync only while it runs (see Deploy).

- **Encryption.** Matrix end-to-end encrypted rooms (matrix-js-sdk's Rust crypto plus device
  verification).
- **History.** Only recent messages load: the last 30 per Matrix room, and what a Telegram bot has
  seen. Scrolling back doesn't fetch older ones yet.
- **Scheduled sends** go out while Sytext is open. One that was due while it was closed waits for
  you instead of arriving hours late. Matrix delayed events (MSC4140) would let the server send them.
- **Sync across devices.** Done, snoozed and tasks live on one device. For Matrix they could sync
  through room account data.
- **One person, one chat.** The same person on several networks isn't merged yet.
- **Notifications.** No push notifications.
