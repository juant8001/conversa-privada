# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-room private chat for **two people**, self-hosted on a Mac. Text, photo,
video, audio and file messages over a secret link, protected by an access code.
Comments and user-facing strings are in Portuguese (pt-BR); keep new ones in
Portuguese too.

## Commands

- `npm start` — run the server (`node server.js`). Listens on `127.0.0.1:$PORT`
  (default 4177). Requires `ROOM_SLUG` (≥16 chars) in `.env` or it exits.
- `npm install --omit=dev` — install runtime deps (express, multer, archiver).
- `scripts/install.sh` — generates `.env` with a random `ROOM_SLUG`, then
  installs a `launchd` agent (`com.privatechat.server`) that keeps the server
  running and restarts it on boot. Used for real deployment on the Mac.
- `scripts/setup-ngrok.sh <authtoken> <domain>` — adds a second `launchd` agent
  exposing the local port through a fixed ngrok domain.
- `scripts/uninstall.sh` — unloads both `launchd` agents. Does **not** touch
  `data/`.

There is **no test suite, linter, or build step** despite some code comments
referencing "tests" (e.g. the `EPHEMERAL_TTL_MS` env override exists for tests
that were never committed). To iterate locally, run `npm start` with a hand-made
`.env` and hit `http://127.0.0.1:4177/c/<slug>`.

Useful env vars: `PORT`, `ROOM_SLUG`, `DATA_DIR`, `MAX_UPLOAD_MB` (default 300),
`EPHEMERAL_TTL_MS` (default 10000), `COOKIE_INSECURE=1` (drop `Secure` flag so
cookies work over plain-HTTP localhost).

## Architecture

### Encryption model (the core constraint)

The access code is **never stored anywhere** — not plaintext, not hashed. It only
exists in memory during the moment someone logs in.

- On first login ever, `Store.unlock(code)` bootstraps an empty conversation
  encrypted under whatever code the first visitor typed. That visitor defines the
  access code.
- `lib/crypto.js`: `deriveKey` runs scrypt(code, salt) → 32-byte key. `salt.bin`
  is public, stored in `data/`. `encryptBuffer`/`decryptBuffer` are AES-256-GCM
  with layout `[iv(12)][authTag(16)][ciphertext]`. A GCM auth failure on decrypt
  **is** how a wrong code is detected (`WrongCodeError`).
- Everything on disk is ciphertext: `data/store.enc` (the whole message log as
  one JSON blob) and `data/media/<id>.enc` — one file per upload, plus a second
  one holding the thumbnail when the message has a `thumbId` (see the media
  tab below). Writes are atomic (temp file + rename), mode `0600`.
- `lib/auth.js`: on successful login the derived key is held in an in-memory
  `sessions` Map keyed by a random session id; the client gets an HMAC-signed
  HttpOnly cookie (`pc_session`, 30-day TTL, `Path` scoped to the room).
  `SESSION_SECRET` is regenerated every process start, so **restarting the server
  invalidates every session** — by design, since the key lives only in RAM.
- Authenticated requests never re-derive the key. `loadWithSessionKey(req)` in
  `server.js` reads `store.enc` fresh off disk and decrypts it with
  `req.session.key` on every request (no long-lived in-memory copy of the
  conversation — avoids one request clobbering the other person's concurrent
  write).

### Routing / obscurity

- Everything lives under `/c/<ROOM_SLUG>`. A top-level middleware in `server.js`
  returns bare `404` for any path that isn't exactly the room path or a child of
  it — a wrong/absent slug gets no hint that a chat exists here.
- `roomRouter` serves `public/` statically plus the `/api/*` endpoints.
- `lib/env.js` is a tiny dependency-free `.env` loader (`KEY=VALUE` only).

### Real-time

- `GET /api/stream` is a Server-Sent Events endpoint. A single Node
  `EventEmitter` (`bus`) fans out events: `message`, `message-updated`,
  `message-deleted`, `message-viewed`, `cleared`, `presence` / `presence-init`.
- **Presence** (`onlineConnections` Map) and **ephemeral expiry timers**
  (`pendingExpiry` Map) are in-memory only, same "wiped on restart" philosophy as
  sessions.
- Frontend (`public/app.js`) holds one `EventSource` with silent auto-reconnect.
  All fetches go through `api(path)` which prefixes the room path derived from
  `location.pathname`.

### "Visualização única" (view-once media)

The most intricate feature — spread across `sanitizeMessage`, the `/view`
endpoint, `scheduleExpiry`, and `reconcileEphemeral` in `server.js`:

- Ephemeral image/video messages have their `mediaId` (and `filename`,
  `mimeType`, `size`, `width`, `height`) **stripped** by `sanitizeMessage` from
  every list response and every SSE broadcast.
- `POST /api/messages/:id/view` is the single deliberate reveal point: it returns
  the real `mediaId` once, arms a `setTimeout` expiry (`EPHEMERAL_TTL_MS` after
  first open), and persists `viewedAt`. The original sender is forbidden from
  opening it.
- On expiry the message is hard-deleted: media file unlinked, text/media fields
  removed, `expiredEphemeral: true` set.
- `reconcileEphemeral` runs on every authenticated load to self-heal timers lost
  to a restart — it catches up any window that finished while the process wasn't
  running, and re-arms live timers for windows still open.
- Ephemeral media is **never** included in the export zip, in any state.

### Other message behaviors

- **Replies**: `buildReplySnapshot` freezes sender + a short snippet at reply
  time; the quote keeps showing that even if the original is edited/deleted.
- **Jump to a message** (`?from=<id>` on `/api/messages`, `jumpToMessage` in
  `app.js`): returns the conversation *tail* — the target message plus
  `JUMP_CONTEXT_BEFORE` of context above it, through to the newest message —
  in one response, ignoring `limit`. Going all the way to the end is the whole
  point: `loadedMessages` on the client is always a suffix ending at the last
  message, and that invariant is what lets the SSE append, `loadOlderMessages`
  and the "scroll to bottom" button work without a second `hasMoreNewer`
  cursor. A window centred on the target would break all three, and a capped
  batch would leave a hole between it and the newest message. Unknown id →
  404. Used by the media tab's "Ir para a mensagem" and by the reply-quote
  click, which before could only toast "não está mais visível" for anything
  outside the loaded page. `jumpToMessage` deliberately leaves a reply in
  progress alone — jumping and replying are independent actions.
- **Delete**: either person can delete any message (2-person trusted room);
  `deletedBy` is recorded and shown on the placeholder.
- **Link previews**: `scheduleLinkPreview` runs *after* the message is saved and
  broadcast (fire-and-forget), fetches only the `<head>` of the first URL,
  extracts OpenGraph tags, and patches the bubble via `message-updated`. Any
  failure just means no card. `isBlockedPreviewHost` blocks obvious
  internal/loopback hosts — it is a courtesy filter, **not** a full SSRF defense
  (no DNS-rebinding protection); acceptable only because both users are already
  fully trusted. `stripTrailingPunctuationServer` must stay in sync with
  `stripTrailingPunctuation` in `app.js`.
- **Media dimensions**: `readMediaMeta` in `app.js` reads intrinsic width/height
  before upload and sends them so the bubble reserves layout space and doesn't
  jump on load.
- **Video bubbles use `poster`**: set to `/api/media/<thumbId>` when the message
  has one (same thumbnail the media tab uses). Without it a video bubble shows
  nothing at all until the browser resolves `preload="metadata"` — and since
  `/api/media` has no Range support, that can mean pulling a real chunk of a
  multi-MB file first. Video sent before thumbnails existed has no `thumbId`
  and falls back to the old (posterless) behavior.

### Aba "Mídia" (grade de fotos e vídeos)

A `#media-panel`, a full-screen panel over the chat (z-index 45 — under the
lightbox at 50, so tapping a tile opens the full media *over* the grid). It is
in-memory state, never a URL: `api()` derives the room path from
`location.pathname` verbatim, so any client-side sub-path would break every
request on the page.

The whole design exists to keep the grid cheap, since `/api/media/:id` returns
the entire decrypted file with no Range support and `no-store`:

- **Thumbnails are generated client-side**, at upload time, by `readMediaMeta` →
  `drawThumb` — the probe element that was already being created to measure
  width/height also gets drawn into a `<canvas>`, longest side 400px, JPEG
  q0.72 (~20–60KB). For video it seeks to ~0.5s first (`muted` + `playsInline`
  are required or WebKit won't decode the frame at all). It also does a
  silent `play()`/`pause()` on the probe before seeking — confirmed by
  reproducing against the WebKit engine: without it, WebKit's `<video>` never
  actually decodes a frame even after `seeked` fires, and `drawImage` captures
  solid black. Chromium doesn't have this problem, so the extra step is a
  no-op there. Any failure resolves `thumb:
  null` and the message just ends up with no `thumbId` — it never blocks or
  fails the upload.
- `POST /api/media` takes both files (`upload.fields`, so **`req.file` doesn't
  exist on that route** — it's `req.files.file[0]`) and stores the thumb as a
  second encrypted blob under `thumbId`, capped at `MAX_THUMB_BYTES`.
- `GET /api/media/:id` resolves either `mediaId` **or** `thumbId`, and forces
  `Content-Type: image/jpeg` for thumbs — using `msg.mimeType` would serve
  `video/mp4` for a video's thumbnail and the `<img>` would render nothing. It
  uses `loadStoreOnly` (no `reconcileEphemeral`) because the grid fires dozens
  of these in a row.
- `GET /api/media-list` returns metadata only, newest first, with the same
  `before`-cursor pagination as `/api/messages`.
- The grid sets no `src` at all: an `IntersectionObserver` (600px margin)
  assigns it when a tile approaches the viewport, so only visible tiles fetch
  anything. A second observer on `#media-sentinel` pages. The full file is
  fetched in exactly one place — the tile's click handler, via `openLightbox`.
- The grid stays mounted in the DOM while the panel is closed. Destroying it
  would re-download every thumbnail on reopen, since responses are `no-store`.
- **Media predating this feature** self-heals, but only for photos: a photo
  tile with no `thumbId` loads the original (lazily — heavy but correct), and
  once it decodes, a one-at-a-time queue draws it to canvas and `POST`s to
  `/api/media/:mediaId/thumb`, so the next open is cheap. Silent on failure.
  A **video with no `thumbId` gets no `src` at all** — just a placeholder icon
  and the ▶ badge. Pointing an `<img>` at an `.mp4` downloads the entire file
  (measured: 5 MB) and then fails to decode it, rendering nothing; and there is
  no cheap way to grab a frame without that download, since `/api/media` has no
  Range support. Tapping the tile still plays it in the lightbox. Videos
  uploaded from now on carry a thumbnail from the start.
- **View-once media never enters any of this**: no thumbnail is stored for it
  (client and server both refuse), `sanitizeMessage` strips `thumbId` alongside
  `mediaId`, `/api/media-list` filters it out in every state, and the retrofit
  endpoint 403s on it. A thumbnail outliving the 10s window would defeat the
  whole feature.
- Deleting a message unlinks **both** blobs. Thumbnails are derived data, so
  they're excluded from the export zip (which only walks `mediaId`).

### Menu de contexto (`#msg-menu`)

One floating card serves two places, opened by the same gestures (right-click
on desktop, ~480ms long-press on touch) — `attachMenuGestures` in `app.js`
wires both roots, so the movement tolerance, scroll cancellation and
capture-phase suppression of the post-long-press ghost click exist once:

- **chat bubble** (`openMessageMenu`): reactions + Responder + Copiar (text
  only) + Apagar. The message object comes from `loadedMessages`.
- **media tile** (`openMediaTileMenu`): Ir para a mensagem, and nothing else
  for now. It deliberately never looks in `loadedMessages` — the grid spans
  months while the chat has only the newest `PAGE_SIZE` loaded, so the message
  usually isn't there. Only the id is needed, and the tile's `data-id` already
  *is* the message id.

`showMenu(id, mode, at, scrollEl)` is the shared half: positioning and the
dismissers. `scrollEl` is why it's a parameter — the chat menu closes on
`#messages` scroll, the tile menu on `#media-scroll`. `#msg-menu` sits at
z-index 56, already above both the media panel (45) and the lightbox (50).

Two gotchas: the document-level Escape chain (lightbox → panel) has to
early-return while a menu is open, or one Escape closes the menu *and* the
panel; and `.media-tile` needs `-webkit-touch-callout: none` (like
`.bubble img` already had) or iOS pops the native "Salvar imagem" sheet over
our menu.

### Decoy / trap password

`DECOY_CODE` (hardcoded in `server.js`) makes `/api/login` return
`{ ok: true, decoy: true }` — no session, no rate-limit hit, no failure log, no
contact with the store. The frontend then shows a fake "tool under development"
screen (`#decoy-screen`). Purpose: someone who shouldn't be poking around but
knows/guesses this specific code sees nothing that reveals a real chat exists.

### Rate limiting

`lib/auth.js`: 6 wrong codes from an IP → 10-minute lock (`isLocked` /
`registerFailure`). Cleared on success. In-memory `attempts` Map.

## Export

`GET /api/export` streams a zip (`archiver`) with `conversa.json`, `conversa.txt`
and `midias/`. The export is **decrypted** — that's the point (portable backup) —
so it's outside the security model once written.

## Frontend

`public/` is plain HTML/CSS/JS, no framework, no build. `app.js` is one large
IIFE. Notable client-only bits: love-message counter and Konami-style easter eggs
persisted in `localStorage`; heavy use of the Visual Viewport API to fight the
iOS keyboard/URL-bar layout jitter.

**Client-side identity.** `NAME_KEY` stores the display name, and `myName()`
reads it live off the composer's name field. That name *is* the identity: a
case-insensitive (trimmed) `sameName(m.sender, myName())` decides which side a
bubble renders on (`.msg-row me/them`), matches the server's view-once sender
check (`server.js`'s `sameSender`) and drives presence filtering — so typing
"Ana" on one device and "ana" on another is still recognized as the same
person. The stored/displayed `sender` string keeps whatever casing was typed
at send time; only comparisons are case-folded. Because the layout depends on
it, it can't be empty — `showChat()` routes a browser with no stored name to
the `#name-screen` gate before `enterChat()` renders anything, and renaming
calls `rerenderLoadedMessages()` so existing bubbles switch sides. The
view-once permission check deliberately spells out
`sameName(m.sender, myName())` instead of reusing the presentational `mine`
flag.
