# Sytext — an AI-first unified inbox

People with chats spread across WhatsApp, Telegram, Instagram, Slack and SMS lose track of who is
waiting on them, and replying takes effort. Sytext puts every chat in one place, tells you **who
needs a reply** (sorted by AI priority and how long they've waited) and **drafts the reply** for you.
Nothing is ever sent automatically.

- **Accounts.** Sign in with **Google**, or with an **email and password**.
- **Your own WhatsApp and Telegram.** Link **WhatsApp** by typing the 8-character code Sytext
  shows into *Linked devices* on your phone (or scanning a QR code), the way WhatsApp Web links.
  Link **Telegram** with your phone number and the login code Telegram sends you, or by scanning a
  QR code, plus your two-step password if you use one. Your chats sync to the inbox on every
  device you sign in on, and you reply from Sytext. The links keep running on the server when you
  sign out or close the app.
- **Chats live on your devices, not in the database.** Each browser keeps its own copy; the
  server keeps only the links and the latest 40 messages of each chat (plus any pinned or
  starred), so a small free database is enough.
- **Conversations as on the networks themselves.** Quoted replies, reactions, "typing…" both
  ways, profile and group pictures, read ticks, and earlier messages as you scroll back. Voice
  messages play in the chat. Edit your messages, unsend them or delete messages just for you, pin
  and star messages, search for a word in a chat, and archive chats. The demo chats have all of
  it too.
- **Incognito mode**, as in Beeper: read messages without sending read receipts, and type
  without showing "typing…".
- **Your own chat site.** Link **Guffshuff** with the username and password you use there, and its
  chats sit alongside the rest: messages both ways, photos, and read receipts.
- **Instagram DMs.** Link **Instagram** with its username and password (and the code it asks for).
  Text in and out, photos in, read receipts. Meta doesn't allow this way in — see the section below
  before using it.
- **More connections from the browser.** A **Telegram bot**, and a **Matrix** account (through
  Matrix bridges: WhatsApp, Instagram, Slack and SMS).
- **Real AI.** The built-in demo AI runs by default. Signed in, anyone can switch on the free
  **shared AI** (free models on OpenRouter, or Google's Gemini, with the server's key). Or bring
  your own key: **Claude, Gemini, ChatGPT, OpenRouter, Groq, Mistral,
  DeepSeek, Grok** or any OpenAI-compatible service.
- **Priority and tags.** Each allowed chat is marked **Urgent**, **Normal** or **Low**, and tagged
  with what it's about: **Question, Follow-up, Deadline, Payment, Order, Meeting, Work, Personal,
  Promo** or **FYI**. Tag a chat yourself from the same set with the tag button in its header, and
  tap a tag above the list to see only those chats. Marking a chat **done** clears the tags that
  asked something of you — only **Normal**, **Low** and **Personal** stay, and an Urgent chat reads
  Normal once it's dealt with — and they come back if someone writes again.
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

Then set the environment variables (**Environment** tab), or put them in a Secret File named
`.env` there (the server reads `.env` from its folder or from `/etc/secrets/`; variables set in the
Environment tab win). `MONGODB_URI` and `JWT_SECRET` are required; `.env.example` explains every
variable. The service's log says which file it read and which features are on:

| Variable | What it does |
| --- | --- |
| `MONGODB_URI` | Your database. Give Sytext one of its own (a name after the host, like `…mongodb.net/sytext?…`), not one another app uses. With MongoDB Atlas, allow connections from Render (Network Access → `0.0.0.0/0`). |
| `JWT_SECRET` | Signs sessions: 32+ random characters (`openssl rand -base64 48`). |
| `DATA_ENCRYPTION_KEY` | Encrypts stored chats and sessions (`openssl rand -base64 32`; the Blueprint generates one). |
| `GOOGLE_CLIENT_ID` | Turns on "Continue with Google". |
| `GOOGLE_CLIENT_SECRET` | With `GOOGLE_CLIENT_ID`, turns on syncing tasks to Google Calendar (see [Tasks in Google Calendar](#tasks-in-google-calendar)). |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | Turn on linking Telegram accounts. |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Your own profile photo. (Photos and files in chats don't need it.) |
| `GUFFSHUFF_URL` | Your own chat site's address: turns on linking Guffshuff accounts. `off` turns it off. |
| `INSTAGRAM` | `off` takes Instagram off the Settings page for everyone on this server (it's offered by default). |
| `AI_API` | An OpenRouter key (`sk-or-…`) or a Google Gemini key: turns on the shared AI for everyone signed in. `AI_PROVIDER` (`openrouter` or `gemini`) says which if the key doesn't; `AI_MODEL` and `AI_TRIAGE_MODEL` pick its models. |
| `KEEP_AWAKE` | `off` stops the server visiting itself to stay awake (see below). `KEEP_AWAKE_URL` sets the address to visit elsewhere than Render. |
| `TEMPORARY_STORAGE` | `off` stops the server keeping accounts in temporary storage while the database can't be reached (see below). |

`PORT` is optional: the server listens where Render tells it to.

Keep these values out of the repository, screenshots and chats. If one has been shared, rotate it:
a new database user password (and `MONGODB_URI`), a new Cloudinary API secret, and a new
`JWT_SECRET` (which signs everyone out).

Things to know about hosting:

- **A database it can't reach doesn't stop anything.** The server starts a private MongoDB of its
  own ("temporary storage") so signing in and linking work anyway, and keeps trying the real one
  every 30 seconds. When it answers, everything made meanwhile moves over (same ids, so sign-ins
  and links carry on) and the server switches without a restart. Until then, anything in
  temporary storage is lost if the server restarts, and the sign-in screen and Settings → Accounts
  say so, with what to fix. With MongoDB Atlas it's usually its IP Access List (allow `0.0.0.0/0`,
  since a host like Render has no fixed address) or a paused cluster. Temporary storage downloads
  MongoDB 7.0 on first use and takes about 150 MB of memory; `TEMPORARY_STORAGE=off` makes the
  server wait for the database instead, serving the app without accounts meanwhile.

- **Run one instance.** Each WhatsApp and Telegram link lives in the server process, and WhatsApp
  allows one connection per linked device.
- **Free instances sleep** after 15 minutes without visits, and a sleeping server can't hold the
  WhatsApp and Telegram connections. So while any account is linked, the server visits its own
  address (`RENDER_EXTERNAL_URL`, which Render sets) every 10 minutes to stay awake. One service
  running all month fits in Render's 750 free instance hours, but not two. Set `KEEP_AWAKE=off` to
  let it sleep: when it wakes, it reconnects and catches up (Telegram fetches what's new in your
  recent chats, and WhatsApp delivers what it held for the linked device).
- **Links look after themselves.** Every 5 minutes the server reconnects any linked account that
  isn't connected (a dropped connection, a failed reconnect, a restart), and every 10 minutes it
  checks Telegram for messages it missed while the connection was down.

**Try this:** click **Turn on AI** · press `J`/`K` to move through the queue · `R` for drafts,
`1`–`3` to pick one, edit, `Enter` to send · `E` to mark done · `⌘K`/`Ctrl+K` and ask *"what are
my tasks for today?"*, *"have I ordered anything?"* or *"when is my flight?"* · then open
**Settings** to connect your own accounts and choose an AI. Questions about tasks are answered from
your open tasks (with their due dates) as well as your chats.

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
- **Recovery keys** stand in for a reset email, which Sytext doesn't send. Creating an account
  shows a key once, like `7K2QP-M9XHD-4T8RW-CZ6NB-J3VFA` (125 random bits), to copy or download.
  If the password is forgotten, **Forgot password?** on the sign-in screen takes the email, the
  key and a new password. The key then stops working and a new one is shown, and the account's
  other sessions end. Only a SHA-256 hash of the key is stored. Resets are rate-limited more tightly
  than sign-ins. **Settings → Profile** makes a new key with the current password, for accounts
  made before keys existed or a lost key. Changing the password gives a new key too (the old one
  stops working: someone who knew the old password could have made it). Linking Google to an
  account with the same email removes its key, for the same reason it turns the password off.
- **Google**: the ID token from Google's button is verified on the server (signature, issuer,
  audience, expiry, verified email). Signing in with Google to an existing account with the same
  email links the two, and turns that account's password off and ends its sessions, since email
  addresses aren't verified on sign-up and whoever set the password may not own the address. The
  user can then set a new password under **Settings → Profile**.

To turn on Google sign-in, create an OAuth client id of type *Web application* in the
[Google Cloud console](https://console.cloud.google.com/apis/credentials), add your site's address
(and `http://localhost:5173`) under *Authorized JavaScript origins*, and set `GOOGLE_CLIENT_ID`.

### Tasks in Google Calendar

**Tasks → Connect Google Calendar** sends you to Google's consent screen, asking only to manage
calendar events. Once connected, every task gets an event in your primary calendar: a half hour at
its due time, or all day on the day it was made when it has no date. Ticking a task off marks its
event "✓" and greys it; deleting the task deletes the event; a task made before connecting, or on
another device, gets its event too. Google's refresh token is kept sealed with
`DATA_ENCRYPTION_KEY`, and **Disconnect** revokes it at once (events already made stay).

To turn it on, use the same OAuth client as Google sign-in:

1. In the Google Cloud console, enable the **Google Calendar API** for the project.
2. On the OAuth client, add `https://<your site>/api/calendar/callback` (and
   `http://localhost:5173/api/calendar/callback` for development) under *Authorized redirect URIs*.
3. Under *OAuth consent screen → Data access*, add the scope `…/auth/calendar.events`. While the app
   is in *Testing*, add the Google accounts that may connect as test users.
4. Set `GOOGLE_CLIENT_SECRET` (the client's secret) next to `GOOGLE_CLIENT_ID`.

**Settings → Profile** changes your name, photo (with Cloudinary set up), password and recovery key,
and signs out.

## Link WhatsApp and Telegram

In **Settings → Accounts** (or the account menu → *WhatsApp and Telegram*), once signed in.

### WhatsApp

Enter your number and Sytext shows an 8-character code. On your phone, open WhatsApp →
**Settings → Linked devices → Link a device → Link with phone number instead**, and type it in. Or
choose **QR code** and scan it from the same screen. Sytext becomes one of your linked devices,
like WhatsApp Web; your phone doesn't have to stay online.

![Linking WhatsApp: the pairing code and where to enter it](docs/screenshots/link-whatsapp.jpg)

- It brings in your recent chats (up to 40 messages each) and every new message after that, with
  delivery and read ticks for yours, edits and deletions.
- **Photos and files** both ways: photos show in the chat, videos and documents as cards, and
  each one downloads (see *Photos and files* below). Stickers show as stickers, animated ones
  too, and voice messages play in the chat (see below). The paperclip, pasting, or dropping files on
  the message box sends them; JPEG and PNG go as photos, MP4 as video, anything else as a document.
- Quoted replies and reactions come in and go out, also those on messages from history. You see
  when someone is typing, and they see when you are. Profile and group pictures show too.
- Scrolling back past what's stored asks your phone for older messages, as WhatsApp Web does.
  They arrive a moment later, if the phone is online.
- Reading a chat in Sytext marks it read on WhatsApp; replies go out from your number.
- **Unlink** logs the device out (it disappears from *Linked devices*) and deletes its chats from
  the server. If you remove the device from your phone instead, syncing stops and Settings offers
  to link again or remove its chats.
- It uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web client.
  WhatsApp doesn't support third-party clients and can restrict numbers that use them; the app
  says so before linking.

### Telegram

Enter your number; Telegram sends a login code to your Telegram app (or by SMS). Enter it, and your
two-step verification password if you have one. Or choose **QR code** and scan it in Telegram on
your phone (**Settings → Devices → Link Desktop Device**). Sytext signs in as you, like Telegram on
a new device, and shows up in Telegram under **Settings → Devices**, where you can end it.

- Your 30 most recent chats come in (20 messages each; broadcast channels are left out), then
  everything new, with read status both ways, edits, and photos, files, stickers and voice
  messages as above.
- Quoted replies, reactions (Telegram's standard set), typing both ways, and profile and group
  pictures. Scrolling back fetches earlier messages from Telegram.
- **Unlink** ends the session in Telegram and deletes its chats from the server.
- The server needs an `api_id` and `api_hash` for the deployment from
  [my.telegram.org](https://my.telegram.org) → *API development tools*. It uses
  [GramJS](https://gram.js.org), a client for Telegram's own API (MTProto).

### Photos and files

Nothing is uploaded anywhere else, and nothing is stored on the server:

- **Received** photos, videos and documents get a private link on your Sytext server. Opening it
  (or the photo showing in the chat) fetches the file from WhatsApp or Telegram right then and
  streams it to the browser, which caches it. The link carries, encrypted, what the network needs
  to find the file again, so it keeps working for messages the server no longer keeps.
- **Sending:** the browser hands the file to the server, which passes it straight on to WhatsApp or
  Telegram (they keep it). Up to 50 MB each, ten at a time, sent one after another in the order
  picked; the message text becomes the first one's caption (text longer than a caption's 1,024
  characters goes as its own message first). JPEG and PNG go as photos; anything else, WebP
  included, as a file. A photo that couldn't be fetched (the network reconnecting, say) offers
  **Try again**.
- **Safety:** a link works only for the account it belongs to. Only plain images, video and audio
  are shown in the page; anything else (say, an HTML file someone sent) is always a download, and
  is served with a sandboxing policy, so it can't run as part of the site.
- WhatsApp keeps media on its servers for a while, then asks your phone to upload it again when
  it's opened. If the phone no longer has it, Sytext says it's no longer available. Opening a file
  needs the account connected.
- **Stickers** show on their own, without a bubble: WebP images, Telegram's WebM video stickers,
  and animated Lottie stickers (Telegram's .tgs, WhatsApp's animated ones), which the app plays
  with lottie-web's light build. It runs nothing from the file, fetches no pictures or fonts from
  elsewhere, and stops unpacking a sticker once it passes 8 MB. Animated and video stickers load
  as they scroll into view, and only play while they're on screen.
- **Voice messages** play in the chat: a play button, the waveform WhatsApp or Telegram sends
  with it (tap or drag it to jump), how long it is, and 1× / 1.5× / 2× speed. One plays at a
  time. Audio files (music, recordings) play the same way, with their name and a download link.
  A voice message is fetched whole the first time it's played (they're small), so it can be
  scrubbed at once. Browsers that can't play WhatsApp's Ogg Opus offer it as a download instead.
- **Kept before this existed?** Stickers, voice messages, photos and files kept by earlier
  versions had no link (a sticker or voice message was only named). When the server reconnects
  (at most hourly), it asks again for the latest 40 of them: WhatsApp's phone sends each one again
  (it must be online), and Telegram is asked by message id. They then open like new ones; any
  that don't come are asked for again a day later. One deleted or edited since stays that way.

### Edit, delete, pin, star and search

Each message's **⋯** menu (hover, or tap the message on a phone) has what its network allows:

- **Edit** one of your messages: it goes back into the message box; `Enter` saves, `Esc` cancels.
  It changes for everyone and shows *edited*, as edits made on the phone do. WhatsApp allows 15
  minutes after sending, Telegram 48 hours; past that Sytext says so and keeps your new text.
- **Delete for everyone** (your own messages) leaves *You deleted this message*, as WhatsApp
  does; when someone else unsends one, it shows *This message was deleted*. WhatsApp allows about
  2 days. On Telegram the message just disappears, as it does there.
- **Delete for me** removes it from Sytext and, on WhatsApp, from your phone too. Telegram's
  large groups and channels have no "delete for me" (deleting there deletes for everyone), so
  there it's removed from Sytext only.
- **Pin** pins it in the chat for everyone (on WhatsApp for 30 days, the longest it offers). The
  chat's pinned messages show in a bar above it; tapping it jumps to each in turn. WhatsApp pins
  run out after the time they were pinned for (24 hours, 7 days or 30 days), and leave the bar then
  too. Pinning or starring an old message keeps it on the server however old, so it shows on every
  device.
- **Star** keeps it under **Starred** in the sidebar, from every chat, newest first. On WhatsApp
  it's starred on your phone too; Telegram has no stars, so they're kept by Sytext.
- **Copy text.**

Edits, deletions and pins made in WhatsApp or Telegram themselves show in Sytext too, and so do
stars from your phone's WhatsApp.

**Search in a chat** with the 🔍 in its header: every match is highlighted, and `Enter` /
`Shift+Enter` (or the arrows) go to the older or newer one. It searches the messages loaded in
the chat; **Earlier** loads older ones until it finds more. Deleted messages aren't searched.

### Archive

**Archive chat**, in a chat's **⋯** menu, takes it out of Needs reply, All chats and Waiting on
them, into **Archived** in the sidebar (its count is archived chats with something unread).
**Unarchive chat** brings it back; the toast offers Undo too.

- **WhatsApp and Telegram** chats are archived on the network itself, so your phone shows them
  archived too, and archiving or unarchiving on the phone shows in Sytext. Whether a new message
  brings a chat back is up to the network: WhatsApp keeps it archived while *Keep chats archived*
  is on in its settings; Telegram brings back chats that aren't muted.
- Other chats (a Telegram bot, Matrix, the demo) are archived in Sytext, on that device.

### Incognito mode

**Settings → Privacy → Incognito mode**, as in Beeper. While it's on, an **Incognito** badge shows
at the top:

- **No read receipts.** Opening a chat clears its unread count in Sytext, but WhatsApp's blue
  ticks and Telegram's "seen" don't go out (Matrix gets a private read receipt). It stays read in
  Sytext even though WhatsApp and Telegram still count it unread. To let one chat know, choose
  **Mark as read for them** in its ⋯ menu (it says so if that can't go out right now).
- **No "typing…"** while you write.
- Signed in, it's a setting of your account: every device follows it at once, and the server
  itself won't send read receipts or typing for you, whatever an older copy of the app asks.
  Without an account it applies on that device.
- Replying still shows you were there, of course, and opening the chat on your phone may send
  read receipts from the phone.

### Where your chats are kept

- **On the server:** the linked sessions (they have to run somewhere when no browser is open, and
  WhatsApp can't run inside a web page), your chats and contacts, and only the **latest 40
  messages of each chat**, to pass on to your devices, and pinned or starred messages however old.
  Older messages are deleted from the server every minute; data from before this limit is trimmed on start. Profile pictures aren't stored:
  only that one exists, and the image is kept in memory and fetched again from WhatsApp or
  Telegram when needed. So the database stays small however much you chat: about chats × 40
  messages, plus the session keys.
- **On each device:** everything that browser has seen, in its own storage (IndexedDB). It shows
  straight away when you open the app, even offline, and scrolling back reads it before asking
  the network. Further back, older messages come from Telegram, or from your phone for WhatsApp.
  If more came in while a device was away than the server keeps, the device fetches the gap.
  Messages deleted for you elsewhere go from it too; the server remembers those for a month (50
  per chat), so a device away longer starts those chats afresh from the server's copy.
  **Settings → Accounts** shows how much space it uses.
- **Signing out** deletes the copy on that device (and closing the app with an expired session
  does on the next start). The links keep running on the server: messages keep coming in, and
  they're there when you sign in again. To stop them, **unlink**.

On the server, session keys, chat and contact names, message text and attachments are **encrypted
at rest** (AES-256-GCM, with `DATA_ENCRYPTION_KEY`), so a copy of the database alone reveals no
chats. Ids, times, counts and whether a message is pinned or starred stay readable so the
database can sort and keep them. **Done and snoozed** state and **tasks** from linked chats are
kept with your account too (task text sealed like messages), so they're the same on every device
and still there after signing out and in. AI results stay in the browser.

## Addresses

Every part of the app has a URL, so a page can be bookmarked, shared and reloaded, and Back and
Forward work the way they should.

| | |
| --- | --- |
| `/` | Needs reply — where the app opens |
| `/chat`, `/chat/<chat id>` | All chats, and one conversation |
| `/waiting`, `/scheduled`, `/tasks`, `/starred`, `/archive` | The other lists |
| `/tags/<tag>` | One tag's chats |
| `/search`, `/shortcuts` | The command bar and the shortcut list |
| `/settings`, `/settings/<tab>` | Settings, at a tab (`profile`, `accounts`, `ai`, `privacy`, `appearance`) |
| `/login` | Signing in. A protected page sends you here with `?next=`, and back afterwards |
| `/demo` | The demo inbox, without an account |
| `/info`, `/help`, `/terms`, `/privacy` | The site's own pages (`public/`), served by the server as they are; the app links to them |
| anything else | A "that page isn't here" page with a search box and the ways back |

On a wide screen a chat sits beside the list, so the address bar names whichever of the two was
moved to last: picking a chat gives it a URL, picking a list goes back to the list's. The chat the
app opens by itself (so a wide screen never shows an empty pane) doesn't change the address.

## Your own chat site (Guffshuff)

[Guffshuff](https://guffshuff.onrender.com) is my own chat site, and the server bridges it like
any other network. Set `GUFFSHUFF_URL` to its address, then link it in **Settings → Accounts**
with the username and password you use there.

It has no bridge API of its own, so the server signs in the way the site's own pages do, and keeps
**both the username and password encrypted** (`DATA_ENCRYPTION_KEY`, like linked sessions). Its
cookie only lasts a week and it has no way to refresh one, so without the password the link would
stop every Monday; with it, the server signs in again by itself. Unlinking deletes both, along
with its chats.

| | |
| --- | --- |
| Chats | Everyone you've exchanged messages with. People on the site you've never written to aren't chats. |
| Messages | Text and photos, both ways. Photos come through this server (`/api/files/…`), not straight from the site. |
| Live | Its socket.io stream, with a look at the chat list every couple of minutes in case the stream missed something. |
| Read receipts | Opening a chat tells the site, as its own pages do — unless Incognito mode is on. |
| Not there | Replies, reactions, edits, unsending and "typing…": Guffshuff has none, so Sytext hides them rather than failing. Starring, pinning, deleting for me and archiving are kept by Sytext itself. |

If the site signs in but won't hand over its chats, **Settings says which call it refused** (rather
than sitting there "connected" with an empty inbox), and it tries again every couple of minutes.
A half-broken site still works as far as it can: missing unread counts, or one unreadable
conversation, don't stop the rest syncing.

**Linking reads your conversations in, which marks them read on Guffshuff** — the same as opening
them there. It's the only way its API hands over a conversation. Unread counts are read first, so
the queue still shows what was waiting. After that, new messages come from the live stream, which
marks nothing read.

## Instagram DMs

Instagram is linked in **Settings → Accounts** with its username and password; it usually asks for
a code as well (from your authentication app, or by text or email), and the card asks for that
next.

**Read this before you use it.** Meta has no API for a person's own DMs — its Messaging API only
covers messages sent *to* a business account — so Sytext signs in the way instagram.com does and
reads the endpoints its Direct page reads. Meta's terms don't allow that. A sign-in from a server
is often challenged ("was this you?"), and can get an account locked or asked for a password
change. Use it knowing that; `INSTAGRAM=off` takes it off the page entirely.

**Your password is never stored.** It's used once, to sign in; only the session Instagram hands
back is kept, encrypted (`DATA_ENCRYPTION_KEY`), so the link survives restarts without it. When
Instagram throws that session out, the account goes quiet and Settings says to link again — there
is nothing stored that could sign in by itself.

| | |
| --- | --- |
| Chats | Your DMs, one-to-one and group, as Instagram's own inbox lists them. |
| Messages | Text out; text and photos in. Photos come through this server (`/api/files/…`); Instagram's own links to them expire. |
| Live | No stream: the inbox is looked at every 45 seconds, so a message takes up to that long to appear. Replies go out at once. |
| Read receipts | Opening a chat tells Instagram — unless Incognito mode is on. |
| Not there | Replies, reactions, edits, unsending, "typing…", older history and sending photos. Starring, pinning, deleting for me and archiving are kept by Sytext itself. |

**Security checks.** Instagram often wants a sign-in from a server checked before it allows it. That
check is not a prompt in the app — nothing arrives on your phone — so Sytext answers it the way the
website does: a "was this you?" review is answered on the spot (it's this sign-in being asked
about), and when Instagram wants a code instead it sends one to your email or phone and the card
asks for it. If it insists on a check that only works in a browser, Settings says so: sign in on
instagram.com, clear it there, then link again.

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

The sample conversations are for trying Sytext without an account. **Settings → Accounts → Demo
chats** shows or hides them, and while they're shown you can simulate an incoming message or reset
them. Once you're signed in they never show: your inbox is only your own chats (the setting is
kept for when you sign out).

## AI

Choose the AI in **Settings → AI**:

- **Built-in demo AI** (the default): simple rules on the device; no chat leaves it.
- **Shared AI · free**, for anyone signed in. The server answers with its own key (`AI_API`):
  with an OpenRouter key, through `openrouter/free`, OpenRouter's router of free models (it picks
  one that supports structured output for each request); with a Gemini key, through Gemini Flash.
  Nobody needs a key, and the key never reaches a browser. Each user gets up to 30 requests a
  minute; a few run at once and the rest wait their turn. If a model isn't available to the key,
  the next one is tried. Free models' providers may keep what's sent to them.
- **Your own API key**: Claude, Gemini, ChatGPT (OpenAI), OpenRouter, Groq, Mistral, DeepSeek,
  Grok (xAI), or any OpenAI-compatible service by its address. The key is checked with the
  provider, stored only in this browser, and sent only to that provider. Models can be typed in
  freely; each provider suggests a few.

### With Claude

| Feature | Model (default) | Effort |
| --- | --- | --- |
| Sorting the queue: priority, tags, and whether a reply is expected | Claude Haiku 5.5 | low |
| Summaries and detected tasks | Claude Opus 5.5 | low |
| Drafts (all three tones in one request) and answers in ⌘K | Claude Opus 5.5 | medium |

Both models can be changed in Settings. Sorting gets the fast model by default because it runs
for every allowed chat whenever that chat changes.

How Claude is called (`src/ai/llm.ts`, `src/ai/claude.ts`):

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

### With other providers

Gemini (`src/ai/gemini.ts`) is asked for JSON held to the same schemas (`responseJsonSchema`).
OpenAI-compatible services (`src/ai/openai.ts`) get structured output where they support it, plain
JSON mode or instructions where they don't; the first mode a service accepts is remembered. Every
answer is checked against the schema (`src/ai/schemas.ts`) before it is used.

Tags you add by hand sit alongside the AI's and are kept with your account, like done and snoozed.

Results are cached per chat, keyed on its latest message, so the AI only runs again when a chat
(or the chosen AI) changes. Without a real AI, the same functions use the built-in demo AI (`src/ai/mock/`): canned
results for the demo chats and simple rules elsewhere.

**Privacy.** AI is off until you allow it, and then only for the chats you select (**Settings →
AI**, or a single chat from its AI panel). New chats stay unselected until you allow them. The gate
lives inside the AI module (`src/ai/access.ts`), not just the UI, so an unselected chat can't reach
a model even by accident. The allowed chats are sent to the chosen AI when a feature needs them:
through this app's server to the shared AI's provider, or straight to the provider for your own key. Turning AI off clears AI results from the device.

![Ask across chats: an AI answer with its source messages](docs/screenshots/ask-dark.jpg)

## Security

- **No injected code runs (XSS).** React escapes every message. A Content-Security-Policy allows
  scripts only from this site and Google's sign-in button, with no inline scripts, so injected text
  can't run even if it reaches the page. Attachment links must be web, local-preview or media data
  addresses (never `javascript:`). Files from chats are served with `nosniff` and a sandboxing
  policy, so an uploaded HTML file can't run as part of the site.
- **Headers:** `X-Frame-Options: DENY` and `frame-ancestors 'none'` block clickjacking.
  `Strict-Transport-Security` is sent over HTTPS, a `Permissions-Policy` turns off camera, mic and
  location, and `X-Powered-By` is removed.
- **Sessions:** a signed token in an `httpOnly`, `SameSite=Lax` cookie (`Secure` in production).
  Requests that change anything must be JSON, which a cross-site form can't send (CSRF).
- **Passwords and data:** passwords are hashed with scrypt. Linked sessions, chats and Google
  tokens are sealed with `DATA_ENCRYPTION_KEY`. Request values are checked for type before any
  database query.
- **Password guessing:** after 7 wrong passwords in a row, the next try has to wait 3 minutes.
  If guessing carries straight on after that, each wait doubles (6, 12, 24 minutes and so on, up to
  a day), so a script can't get far. This holds whichever addresses the guesses come from. During a
  wait even the right password isn't checked. Wrong current passwords in an open session count
  too. An email with no account answers the same way, so guessing doesn't reveal who has one. The
  owner is told how many wrong passwords were tried when they next sign in. Common passwords, key
  runs and ones made of the email or name are refused.
- **Forgot the password:** reset it with the recovery key given at sign-up. If that's lost too,
  answer the 2 security questions chosen at sign-up (or later in Settings → Profile). Answers are
  stored only as scrypt hashes and compared ignoring case, spaces and punctuation. Since answers
  are easier to guess than a key, 3 wrong tries mean a 1-hour wait, doubling after that. An email
  with no account is asked questions too (always the same ones for it), so asking reveals nothing.
  Either reset lifts any wait, gives a new recovery key and signs out other sessions.
- **One account, never another's data:** every chat, message, task, file and picture is looked up
  by the signed-in account as well as by id, so another account's ids lead to "not found". Tests
  check this route by route.
- **Limits:** sign-in, recovery, linking, people search, AI and calendar sync each have their own
  limits, under an overall ceiling per visitor.
- **Viewing the code:** a browser has to download a site's code to run it, so no site can stop it
  being viewed. Here it's minified, with no source maps or comments, and holds no secrets: every
  key, the database and other people's data stay on the server. To keep the source private, make
  the GitHub repository private (Render still deploys from a private repository).
- **Nothing exposed:** unknown `/api` addresses answer a plain 404, and errors never include stack
  traces or internals (those go to the server log only). Dotfiles aren't served, and the build has
  no source maps. `NODE_ENV=production` (set by the Blueprint) turns on secure cookies.
- **Secrets** are read only from the environment, never from the code. Keep `.env` out of git. If a
  secret was ever committed or shared (database password, `JWT_SECRET`, API keys), rotate it:
  deleting it from the code doesn't remove it from git history.
- `npm audit --omit=dev` reports no known vulnerabilities in the server's dependencies.

## How it's built

React 19 + TypeScript + Vite, Tailwind CSS v4, Zustand, Motion.

```
src/
  data/
    api.ts            ← the only data-access module: InboxApi + ConnectionsApi
    unified/          ← merges every source; routes by id prefix; done/snoozed, tasks and
                        scheduled sends for real accounts (on the device, or with the account
                        for chats linked on the server)
    connectors/
      telegram/       ← Bot API client and connector (long polling, local message store)
      matrix/         ← matrix-js-sdk connector, loaded on demand; bridge detection
    mock/             ← the demo inbox: seed data and a localStorage "server"
    search.ts         ← keyword search used for every source
  ai/
    index.ts          ← draftReply, summarizeThread, classifyPriority, extractTasks, answerQuestion
    access.ts         ← privacy gate every AI function checks
    llm.ts            ← the chosen AI, request limiter, errors
    providers.ts      ← the providers you can bring a key for
    schemas.ts        ← the shape of every result, checked for every provider
    claude.ts         ← Claude: structured output, fallbacks (loaded on demand)
    gemini.ts         ← Gemini, from the browser or the server (loaded on demand)
    openai.ts         ← OpenAI and OpenAI-compatible services (loaded on demand)
    shared.ts         ← the shared AI, through this app's server
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
- their last message is from the past week: after 7 days without a reply it's let go, badge and
  all (`NEEDS_REPLY_FOR` in `src/config.ts`), and comes back when they write again (a chat snoozed
  for longer gets its week from when the snooze ends);
- it isn't done, snoozed or scheduled.

Ids carry their source (`wa:…` and `tga:…` from the server, `tg:…`, `mx:…`, none for demo chats),
so writes route without lookups. To add a network, implement `Connector`
(`src/data/connectors/types.ts`) and register it in `src/data/unified/unifiedApi.ts`.

The server (Express 5, MongoDB, TypeScript run by `tsx` in development and bundled by Vite for
production):

```
server/
  index.ts            ← reads the environment, serves, connects (waiting as long as it takes)
  temporaryDatabase.ts ← a private MongoDB for while MONGODB_URI can't be reached
  holding.ts          ← what's served while there's no database at all: the app, and why accounts are off
  app.ts              ← the HTTP app: security headers, JSON-only API, the built web app
  config.ts           ← environment variables; what's required, what turns features on
  auth/               ← sign-up, sign-in, Google ID tokens, scrypt passwords, session tokens
  networks/
    whatsapp.ts       ← Baileys: pairing code / QR, sessions in MongoDB, history, live sync
    telegram.ts       ← GramJS: phone + code + 2FA, sessions, dialogs, live sync
    guffshuff.ts      ← the user's own chat site: its REST API and socket.io stream
    accounts.ts       ← linked accounts and their status
    routes.ts         ← /api/link/…
  inbox/              ← per-user chat store (encrypted fields) and /api/inbox, /api/threads/…
  ai.ts               ← the shared AI: /api/ai/generate, OpenRouter or Gemini with the server's key (AI_API), limits
  realtime.ts         ← server-sent events (/api/events) to the user's open tabs
  crypto.ts           ← AES-256-GCM for data at rest
```

In the browser, `src/data/server/` is the client: `serverApi.ts` for HTTP; `deviceStore.ts`, this
device's copy of the chats in IndexedDB; and `ServerConnector`, which shows that copy, loads
`/api/inbox` and merges it in, then follows `/api/events`, reloading whenever the stream
reconnects so nothing is missed. The wire types (`src/data/server/types.ts`) are shared by both
sides.

The Matrix SDK (~900 kB) and the Claude SDK are separate chunks, downloaded only once Matrix is
connected or Claude is chosen.

### Tests

- **Unit tests (`npm test`)** cover the demo data, search, selectors and reply rules, and the demo AI.
- **Server.** Sealing, passwords, session tokens, Google ID tokens (against a local key set),
  config, and mapping Telegram's objects. With `TEST_MONGODB_URI` set (any MongoDB; each run uses
  and drops its own database), integration tests run the whole API against fake WhatsApp and
  Telegram transports: sign-up and sign-in, Google account linking, CSRF and forged cookies,
  linking both networks step by step (Telegram by code and by QR), history, live messages,
  edits, read receipts, sending, quoted replies, reactions, typing, profile pictures, earlier
  messages, restarts, ended sessions, unlinking, that stored text is encrypted, trimming to the
  latest 40 messages, acting on messages only a device still has, Telegram catching up on missed
  messages, and links carrying on through signing out and back in.

  ```bash
  TEST_MONGODB_URI=mongodb://127.0.0.1:27017 npm test
  ```
- **Server connector and device copy.** Loading, live events, routing sends, reactions, typing,
  earlier messages and read markers, holding back the echo of a message being sent; the copy on
  the device (against an in-memory IndexedDB): shown before the server answers, kept when the
  server lets go, paged back through first, gaps filled, unlinked networks dropped, and deleted
  on sign-out.
- **In a browser.** `server/testing/e2e.ts` runs the app against the same fakes, with a control
  port standing in for the phone, for clicking through linking end to end.
- **Guffshuff.** A stand-in for the site (its REST API in memory and a live stream) checks linking,
  the chats coming in, sending and receiving, photos both ways, what it refuses, signing in again
  when the week-old session runs out, and unlinking.
- **Instagram.** A stand-in for instagram.com (its web API in memory) checks linking, the code it
  asks for, a login it wants confirmed in the app, the DMs coming in, sending, photos, read
  receipts, what Sytext refuses, a session Instagram throws out, and picking the link back up
  after a restart.
- **AI requests.** A stubbed `fetch` checks each provider's request shape (for Claude: model,
  effort, structured output, fallbacks, no sampling parameters), refusals and error mapping; the
  shared AI is tested against stand-ins for OpenRouter and Gemini, including its limits and model
  fallback.
- **Telegram connector.** Tested against an in-memory Bot API.
- **Unified inbox.** Merging, routing, local done/snooze state, scheduled sends, search and
  disconnecting.

The connectors were also run end-to-end in a browser against a local Synapse homeserver (with a
simulated WhatsApp bridge room) and a local Telegram Bot API server.

## Limits and next steps

- **One server instance**, and linked accounts sync only while it runs (see Deploy).
- **Changes to old messages.** An edit, deletion, pin or reaction made on the phone to a message
  the server no longer keeps (older than the latest 40 of its chat, and not pinned or starred)
  isn't passed on to devices.

- **Encryption.** Matrix end-to-end encrypted rooms (matrix-js-sdk's Rust crypto plus device
  verification).
- **History.** Linked WhatsApp and Telegram chats load earlier messages as you scroll back. Matrix
  rooms show their last 30 messages, and a Telegram bot only what it has seen.
- **Scheduled sends** go out while Sytext is open. One that was due while it was closed waits for
  you instead of arriving hours late. Matrix delayed events (MSC4140) would let the server send them.
- **Sync across devices.** Done, snoozed and tasks sync for WhatsApp and Telegram linked on the
  server; for a Telegram bot and Matrix they live on one device (Matrix could sync them through
  room account data).
- **One person, one chat.** The same person on several networks isn't merged yet.
- **Notifications.** No push notifications.
