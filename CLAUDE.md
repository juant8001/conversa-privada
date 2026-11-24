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

- `npm test` — `node test/smoke.js`: spawns the real `server.js` on a random
  port with a throw-away `DATA_DIR` (plus a fake GIPHY server) and exercises
  the API over `fetch`. No dependencies, never touches the real `.env`/`data/`.
  It covers the server only — there is no committed browser test, linter or
  build step. To iterate on the UI, run `npm start` with a hand-made `.env`
  and hit `http://127.0.0.1:4177/c/<slug>`.

Useful env vars: `PORT`, `ROOM_SLUG`, `DATA_DIR`, `MAX_UPLOAD_MB` (default 300),
`EPHEMERAL_TTL_MS` (default 10000), `COOKIE_INSECURE=1` (drop `Secure` flag so
cookies work over plain-HTTP localhost).

Optional features, each **off unless its variable is set** (the repo is public,
so none of these values may ever be hardcoded): `HERMES_CODE` and/or
`HERMES_TRIGGER` (+ `HERMES_BIN`) for the Hermes portal, `GIPHY_API_KEY`
(+ `GIPHY_RATING`, default `r`) for GIF search, `WHATSAPP_IMPORT=1` for the
"import WhatsApp favorites" button. Test-only overrides: `FXTWITTER_API_BASE`,
`WHATSAPP_CONTAINER`, `WHATSAPP_MEDIA_BASE`, `STICKER_ENCODER=img2webp`,
`FFMPEG_PATH`.

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
  `message-deleted`, `message-viewed`, `message-reacted`, `message-starred`,
  `stickers-changed`, `typing`, `cleared`, `presence` / `presence-init`.
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

### Hermes portal

A full-screen chat with the local Hermes Agent (`POST /api/hermes` runs
`hermes --oneshot` with only the `memory` toolset, one request at a time).
Nothing is stored or broadcast. Two independent ways in:

- `HERMES_CODE`: typed on the **login screen** instead of the chat code. It
  creates a separate in-memory session (`hermesGuests`, own `pc_hermes`
  cookie, no store key) that is accepted by `/api/hermes` and **nothing
  else** — every chat route goes through `requireAuth`, which only knows
  `auth` sessions. It is checked after the rate-limit lock and deliberately
  does not call `registerSuccess` (otherwise it could be used to reset the
  failure counter while guessing the chat code).
- `HERMES_TRIGGER`: typed in the composer by someone already in the chat;
  the client only ever gets a salted hash of it from `/api/boot`.

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

## Security headers and user-uploaded files

- A top-level middleware sets a strict CSP on every response (`PAGE_CSP`:
  only our own `app.js`/`style.css`, `connect-src 'self'`, no inline script or
  `<style>`), `Referrer-Policy: no-referrer` (the secret room URL never leaks
  in a Referer), `X-Frame-Options`, `nosniff`. `style-src` has no
  `'unsafe-inline'`: set styles through `el.style.x = ...` (CSSOM, allowed),
  never through a `style="..."` attribute or an injected `<style>`.
  `img-src` allows `https:` only because of link-preview images.
- `GET /api/media/:id` serves user uploads with `MEDIA_CSP` (`sandbox`, no
  script) and forces `Content-Disposition: attachment` for anything that is
  not image/video/audio (and for SVG). An uploaded `.html`/`.svg` must never
  run as a page inside the chat's origin — it would have the viewer's session.
- Every `/api/*` response is `Cache-Control: no-store`.
- `index.html`/`app.js`/`style.css` are served by `sendStatic` (brotli/gzip,
  ETag, `no-cache`), compressed once and cached in memory until the file's
  mtime changes.
- `getMediaIndex` caches "blob id → mime/filename" for the media route, keyed
  on `store.enc`'s inode+mtime+size, so a grid of thumbnails doesn't decrypt
  and parse the whole conversation once per image. It holds no message text.

## Favoritas, reações, coleção (v44)

- **Favoritas**: `msg.starredBy` (array of names) — per person, never shown to
  the other side. `POST /api/messages/:id/star`, `GET /api/starred?name=`.
  Client: `.msg-row.is-starred` (star next to the time), `#fav-panel`, and
  the media tab (tile menu + `.media-tile.is-starred`; `/api/media-list`
  returns `starredBy`). Deleted and view-once messages can't be starred.
- **Reações**: any single emoji (`isSingleEmoji` on both sides). The six
  shortcuts in the context menu are per person, stored in `data.prefs` under
  `prefsKey(name)` (`POST /api/prefs`, returned by `GET /api/boot`) and
  mirrored in `localStorage`.
- **Coleção de figurinhas e GIFs**: `data.stickers`, one shared library.
  Sending an item creates a message that **points at the same blob** (no
  copy), so every delete path goes through `mediaStillReferenced` /
  `releaseMessageMedia` — a blob is unlinked only when no message and no
  library item references it. "Limpar conversa" keeps the library and prefs
  (`store.clearAll(key, preserved, keepMediaIds)`). Stickers are resized
  client-side to 512px (`imageToSticker`); message type is `sticker`, a GIF is
  an `image` message with `gif: true`.
- **GIF search** (`/api/gifs/*`, only with `GIPHY_API_KEY`): search, previews
  and the download of the chosen GIF all go through the server — the browser
  never talks to GIPHY (and the CSP wouldn't let it). `isAllowedGifUrl` pins
  every fetch to `*.giphy.com`.
- **Formatação**: `renderRich` in `app.js` (`*b*`/`**b**`, `_i_`, `~s~`/`~~s~~`,
  `` `code` ``, ```` ``` ````). Messages are stored and copied as raw text; the
  formatting is applied only when drawing, with DOM nodes (never `innerHTML`).
  Markers inside a URL are ignored. `stripTrailingPunctuation` (client) and
  `stripTrailingPunctuationServer` must keep the same character list.
- **Bandeja** (`#tray`): emoji / figurinhas / GIFs, in the page flow under the
  composer (not floating), so `#messages` shrinks by itself. Grids stay
  mounted while closed for the same `no-store` reason as the media tab.

## Figurinhas feitas no servidor (v46)

- **Conversão** (`lib/sticker-tools.js`): any image/GIF/video → WebP, longest
  side ≤512, animated when the input is (≤8s, retries with lower fps/quality
  until ~1MB). No npm dependency: uses the Mac's `ffmpeg`. Homebrew's ffmpeg
  has **no** `libwebp` encoder, so the usual path is ffmpeg → PNG frames →
  `img2webp`/`cwebp` (Homebrew `webp`); an ffmpeg with `libwebp_anim` is used
  directly. **GIFs** go through `convertGif`: ffmpeg re-encodes a smaller GIF
  (palette with `reserve_transparent`) and `gif2webp -lossy` makes the WebP —
  the only lossy animated encoder here that keeps alpha (`img2webp -lossy` and
  ffmpeg's `libwebp_anim` silently drop it, which ruins GIPHY stickers).
  One conversion at a time (`serialize`). WebP input passes through
  untouched (ffmpeg can't decode animated WebP). No tools → `stickerTools:
  false` in `/api/boot`; photos still go through the old client-side
  `imageToSticker`, small GIFs pass through as-is.
- **Routes**: `POST /api/stickers/convert` (multipart, ≤60MB, gallery
  video/GIF), `POST /api/stickers/from-link` (`{url}` — X/Twitter via the
  fxtwitter API with yt-dlp as fallback, GIPHY page/media links; also used by
  the GIPHY sticker search results), `GET /api/stickers/giphy-search` (same
  handler as GIF search, `/v1/stickers`). `lib/sticker-links.js` only fetches
  from `*.twimg.com`, `*.giphy.com` and the API hosts, re-checking the final
  URL after redirects — a pasted link can't make the Mac hit the LAN.
  Conversion runs **before** `loadWithSessionKey`, so a slow ffmpeg never
  writes a stale copy of the conversation over the other person's messages.
- **Favoritas do WhatsApp** (`lib/whatsapp-favorites.js`, `WHATSAPP_IMPORT=1`):
  the Mac WhatsApp keeps the synced favorites list in
  `AppState/*/AppState.sqlite` (`ZAPPSTATECONFIRMEDMUTATIONENTITY`, action
  `favoriteSticker`, protobuf `SyncActionValue.stickerAction` = field 33;
  index = `["favoriteSticker", base64 sha256 of the file]`; latest version
  wins, `isFavorite` false = removed). Files come from `stickers/` (matched by
  `ZFILEHASH` in `Sticker.sqlite`) or are downloaded from `mmg.whatsapp.net`
  and decrypted (HKDF "WhatsApp Image Keys", AES-CBC + 10-byte HMAC). Every
  file must hash to the favorite's sha256. Read-only through `/usr/bin/sqlite3
  -readonly`. In practice the signed download URLs expire after a few months,
  so old favorites the Mac never cached come back as `missing`.
  **Pick, then import, once** (v47): `scan()` loads every favorite's file
  (8 downloads in parallel) and caches the verified bytes for 10 min or until
  the WhatsApp DBs change. `GET /api/stickers/whatsapp-favorites` lists them
  (`key` = sha256 hex, `inLibrary`, plus `missing`), `GET .../:key` serves the
  preview from that same cache (`MEDIA_CSP`), and `POST
  /api/stickers/import-whatsapp {keys: [≤25], final}` imports only the chosen
  keys; the batch with `final: true` writes `data.waImportDone = {at, by}` in
  the encrypted store. From then on `waImport` is false in `/api/boot` and
  `/api/stickers` (button gone for both people), the list answers 410, the
  previews 404 and the import 409. "Limpar conversa" preserves
  `waImportDone`. To allow it again, someone would have to delete that key
  from the store (no UI for it, on purpose). `ts = now - order` keeps
  WhatsApp's order in the tray.
- **Client** (aba Figurinhas): `#sticker-search-form` — plain text searches
  GIPHY stickers (`stickerMode = 'search'`, tapping a result *creates* the
  sticker in the library, it doesn't send), a link shows "Criar".
  `#wa-import-btn` opens `#wa-panel` (full-screen, `.media-panel` skeleton):
  tiles to tick, "Todas/Nenhuma", footer button "Importar N figurinhas" →
  `askConfirm` (says it's one time only) → batches of 25, last one `final`.
  The "+" accepts `image/*,video/*`; video and GIF go to `/convert` when the
  server has the tools.


## WhatsApp de cada pessoa (v51)

- **Each person connects their own WhatsApp** (`lib/whatsapp-links.js`); the
  import routes take the person's name (`?name=` on GET, `sender` on POST,
  folded with `prefsKey`) and answer `409 not_linked` until that person
  connects. What anyone imports still goes to the one shared `data.stickers`.
- Routes: `GET /api/whatsapp/status?name=`, `POST /api/whatsapp/link
  {sender, number}`, `POST /api/whatsapp/verify {sender, code}`, `POST
  /api/whatsapp/cancel`, `POST /api/whatsapp/unlink`.
- **kind "mac"**: the number matches the Mac WhatsApp (asked to the Bot de
  Figurinhas, `GET /eu` on the same host/token as `/reenviar`; Brazilian
  numbers compare by DDD + last 8 digits). The bot sends a 6-digit code to the
  person's own "Você" chat (`POST /mandar-codigo`); after confirming, that
  person's source is the old `lib/whatsapp-favorites.js` scan.
- **kind "device"**: any other number. The server becomes a linked device via
  Baileys (`baileys` 7.0.0-rc14, ESM, loaded with `import()`), paired with the
  8-letter code the person types on the phone (`requestPairingCode`). Favorites
  come from app-state sync: Baileys doesn't handle `favoriteSticker`, it only
  logs it as `'unprocessable update'` — our custom logger catches that.
  Sent/received stickers come from history sync + `messages.upsert`; expired
  links are re-requested from the phone with `updateMediaMessage`. Note: in
  Baileys v7 `creds.registered` never turns true — "paired" = `creds.account`.
- Everything is encrypted with the room key under `data/wa-links/`
  (`index.enc` = who connected what; `<id>.enc` = Baileys creds/keys + sticker
  catalog; `<id>/` = cached webps). So a connection can only come up after
  someone logs in; it closes after 15 min idle and reconnects from the blob.
  Unlink logs the device out of the phone and deletes its files; imported
  stickers stay.
- Tests: `WHATSAPP_BAILEYS_MODULE=test/fake-baileys.mjs` +
  `WHATSAPP_FAKE_DATA` (JSON "phone") replace the real library.

## Cofre do dono (v52)

- `VAULT_OWNER` (name, e.g. `Juan`) turns it on; `/api/boot` returns
  `vault: true` only for that name (button `#vault-btn` → `#vault-panel`).
  The name only decides who SEES the button: the vault opens with its own
  code (scrypt with `data/vault/salt.bin`, a different code from the chat's),
  so even someone with the chat code can't read it. The vault key lives in
  `vaultKeys` (Map, session id → key) until lock, logout or restart.
- `lib/vault.js`: everything under `data/vault/` is ciphertext with no
  extension (`index.enc`, `blobs/<id>.enc`, `thumbs/<id>.enc`,
  `zips/<id>.enc` = the original .zip, stream-encrypted as
  `"PCVZ1" + iv + ciphertext + tag`). `data/vault/inbox/*.zip` is the only
  plaintext: a zip waiting for import. Import starts on setup/unlock (needs
  the key), encrypts and verifies the whole zip first, then
  `lib/vault-extract.py` streams each media member (nested zips too, read in
  header order so a deflated inner zip is only walked forward) over stdout in
  frames; HEIC → JPEG and thumbnails use `sips`/ffmpeg in `data/vault/tmp`
  (0700, deleted right away); then the inbox zip is deleted. Resumable via
  `index.seen`. Exact duplicates are skipped by SHA-256.
- Routes: `GET /api/vault/status|items`, `POST /api/vault/setup|unlock|lock|send`,
  `GET /api/vault/thumb/:id|file/:id` (Range). Sending decrypts with the vault
  key and re-encrypts with the room key as a normal message.
- `scripts/cofre-zip-original.js <out.zip>` recovers the original zip.
- `/api/media` keeps the last big (>8 MB) decrypted file for 2 min so
  Safari's Range requests don't decrypt a huge video over and over.

## v54 (edição, presença, backup, changelog)

- **Editar mensagem**: `POST /api/messages/:id/edit {requesterName, text}` — só
  texto, só quem mandou. A versão anterior vai pra `msg.edits` (`[{text, ts}]`,
  teto de 30, a original fica sempre); `msg.editedAt`. SSE `message-edited`.
  Cliente: "Editar" no `#msg-menu` reaproveita a `#reply-bar` (classe
  `is-editing`, variável `editingMsg`); a bolha ganha `.edited-tag` dentro da
  `.msg-time` (`.msg-row.is-edited` alarga o vão) e tocar abre
  `#edit-history-overlay` com diff por palavra (`diffTokens`).
- **Presença** (`lib/presence.js`): online = aba visível e com interação
  recente. Cada aba tem um `PRESENCE_CID`, manda `state` active/idle/hidden em
  `POST /api/presence` (a cada 20s na tela, na hora quando muda, e
  `sendBeacon` hidden no `pagehide`) e no `?cid=&state=&device=` do SSE. Aba
  que não bate há `PRESENCE_STALE_MS` (50s) cai, mesmo com SSE "fantasma"
  aberto pelo túnel. Payload `{online, people: [{name, state
  online|away|offline, lastSeen, devices}]}`; o visto por último é gravado em
  `data.presence` quando alguém sai do online. Header: `#presence-btn`
  (nome + status) abre `#presence-overlay`.
- **Visualização única de vídeo**: janela = duração×1.5+60s (cliente manda
  `duration` no upload; sem duração, `EPHEMERAL_VIDEO_FALLBACK_MS` = 30min) e
  `POST /api/messages/:id/view-done` encerra quando o vídeo acaba/fecha.
  `msg.viewWindowMs` é o que o `reconcileEphemeral` usa.
- **Backup**: `/api/export` é assíncrono, um arquivo por vez, mídia sem
  recompressão; `?only=text`, `?part=N` (partes de `EXPORT_PART_MB`, padrão
  1024) e `GET /api/export/plan`. Painel `#backup-overlay`.
- **Changelog no chat**: `lib/changelog.js` (entrada nova NO TOPO a cada
  versão). `announceChangelog` no `loadWithSessionKey` cria mensagens
  `type: 'system'` (cartão `.system-card`, sem menu) e grava
  `data.changelogVersion`. Store novo só marca a versão. Testes:
  `CHANGELOG_JSON`. Nunca no portal do Hermes.
- **Cofre**: `POST /api/vault/upload` (dono, cofre aberto) → `vault.addUpload`.
- **Foto do coração** (fora do changelog de propósito): só o dono escolhe a
  foto (`data.heartPhoto`; `POST /api/heart-photo`, `/remove` e `GET /crop`
  com `vaultOwnerGate`, salvar/tirar exigem cofre aberto). Desde a v55 o
  gesto vale pros dois: `heart` vai no boot de todo mundo e `GET
  /api/heart-photo` serve a foto pra qualquer sessão (quem desenha vê a foto
  na própria tela). Trocar/tirar a foto emite `heart-changed` no SSE. O
  cliente (`looksLikeHeart`, `playHeartFx`) só reconhece o gesto quando
  `heartEnabled`; o editor só abre pelo cofre (dono).
- Classes das folhas novas são `pc-sheet*` (já existe `.sheet-card` /
  `.sheet-title` na folha de emojis).
