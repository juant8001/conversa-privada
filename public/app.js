(() => {
  'use strict';

  // Keep --app-height (used by .screen instead of a plain vh/dvh unit) in
  // sync with the REAL visible viewport via the Visual Viewport API.
  // vh/dvh alone are not reliable once the on-screen keyboard opens - on
  // iOS especially, the layout viewport those units are based on doesn't
  // reliably shrink with the keyboard, so a box sized purely with CSS
  // units can stay taller than what's actually visible above the
  // keyboard, and the part that gets pushed off-screen reads as a white
  // gap. window.visualViewport tracks the actual visible area instead,
  // keyboard included, in every browser that supports it (Safari 13+,
  // Chrome 61+); older browsers just keep the 100dvh CSS fallback.
  function setAppHeight() {
    const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-height', `${h}px`);
  }
  setAppHeight();
  if (!window.visualViewport) {
    window.addEventListener('resize', setAppHeight);
  }
  // The visualViewport 'resize' listener that also keeps the conversation
  // glued to the bottom across a keyboard open/close is registered further
  // down, once #messages and isNearBottom() exist (see "keyboard-aware
  // scroll" below) - it needs to read the OLD layout before setAppHeight
  // touches it, so it owns the setAppHeight() call for that listener too.

  const roomPath = location.pathname.replace(/\/$/, ''); // e.g. /c/<slug>
  const api = (p) => `${roomPath}${p}`;

  const loginScreen = document.getElementById('login-screen');
  const chatScreen = document.getElementById('chat-screen');
  const decoyScreen = document.getElementById('decoy-screen');
  const loginForm = document.getElementById('login-form');
  const codeInput = document.getElementById('code-input');
  const codeRevealBtn = document.getElementById('code-reveal-btn');
  const loginError = document.getElementById('login-error');
  const messagesEl = document.getElementById('messages');
  const composer = document.getElementById('composer');
  const nameInput = document.getElementById('name-input');
  const textInput = document.getElementById('text-input');
  const fileInput = document.getElementById('file-input');
  const attachBtn = document.getElementById('attach-btn');
  const ephemeralToggleBtn = document.getElementById('ephemeral-toggle-btn');
  const exportBtn = document.getElementById('export-btn');
  const clearBtn = document.getElementById('clear-btn');
  const logoutBtn = document.getElementById('logout-btn');
  const uploadProgress = document.getElementById('upload-progress');
  const lightbox = document.getElementById('lightbox');
  const lightboxContent = document.getElementById('lightbox-content');
  const lightboxClose = document.getElementById('lightbox-close');
  const confirmOverlay = document.getElementById('confirm-overlay');
  const confirmText = document.getElementById('confirm-text');
  const confirmCancel = document.getElementById('confirm-cancel');
  const confirmOk = document.getElementById('confirm-ok');
  const loveOverlay = document.getElementById('love-overlay');
  const loveList = document.getElementById('love-list');
  const loveClose = document.getElementById('love-close');
  const konamiHeart = document.getElementById('konami-heart');
  const loadingState = document.getElementById('loading-state');
  const emptyState = document.getElementById('empty-state');
  const toastEl = document.getElementById('toast');
  const presenceDotEl = document.querySelector('.chat-header .dot');
  const replyBar = document.getElementById('reply-bar');
  const replyBarSender = document.getElementById('reply-bar-sender');
  const replyBarSnippet = document.getElementById('reply-bar-snippet');
  const replyBarCancel = document.getElementById('reply-bar-cancel');
  const scrollBottomBtn = document.getElementById('scroll-bottom-btn');

  // The access code field is masked via -webkit-text-security instead of
  // type="password" (see style.css for why: it's the one lever left
  // against Safari's AutoFill/Keychain suggestion bar). That property only
  // exists in WebKit/Blink though - Firefox implements neither it nor the
  // standards-track text-security - so anywhere else it would silently do
  // nothing and leave the code fully visible while being typed. Feature-
  // detect and fall all the way back to a real type="password" field
  // rather than ever leaving type="text" unmasked.
  const supportsCodeMask = !!(window.CSS && CSS.supports &&
    (CSS.supports('-webkit-text-security', 'disc') || CSS.supports('text-security', 'disc')));
  let codeRevealed = false;
  function setCodeRevealed(revealed) {
    codeRevealed = revealed;
    if (supportsCodeMask) {
      codeInput.style.webkitTextSecurity = revealed ? 'none' : 'disc';
    } else {
      codeInput.type = revealed ? 'text' : 'password';
    }
    codeRevealBtn.classList.toggle('is-revealed', revealed);
    codeRevealBtn.title = revealed ? 'Ocultar código' : 'Mostrar código';
    codeRevealBtn.setAttribute('aria-label', codeRevealBtn.title);
  }
  if (!supportsCodeMask) codeInput.removeAttribute('data-mask');
  setCodeRevealed(false);
  codeRevealBtn.addEventListener('click', () => {
    setCodeRevealed(!codeRevealed);
    codeInput.focus();
  });

  // Dismiss the keyboard on a tap anywhere in the conversation background,
  // same as every native chat app - without this the only way to close the
  // keyboard is to tap something that happens to blur the input, which
  // isn't anywhere obvious. Ignored when the tap is on an actual bubble/
  // button/link inside the list, so replying, opening media, etc. still
  // work normally.
  messagesEl.addEventListener('click', (e) => {
    if (e.target.closest('.msg-row, button, a')) return;
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
  });

  // Deterministic per-name color so the same sender always reads as the
  // same color across the whole conversation (avatar, name label, quotes).
  const NAME_COLORS = ['#e2896a', '#6fb98f', '#7aa8d9', '#d9a441', '#c47fd0', '#5ec2c2', '#d97a94', '#9fb85c', '#8f96e0', '#e0a85e'];
  function nameColor(name) {
    const str = String(name || '');
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    }
    return NAME_COLORS[hash % NAME_COLORS.length];
  }

  function snippetFor(m) {
    if (m.deleted) return `Mensagem apagada por ${m.deletedBy || m.sender}`;
    if (m.type === 'text') return m.text.length > 140 ? `${m.text.slice(0, 140)}...` : m.text;
    const labels = { image: '📷 Foto', video: '🎥 Video', audio: '🎤 Audio', file: '📄 Arquivo' };
    return labels[m.type] || 'Arquivo';
  }

  let replyingTo = null;
  function setReplyingTo(m) {
    replyingTo = { id: m.id, sender: m.sender, snippet: snippetFor(m) };
    replyBarSender.textContent = m.sender;
    replyBarSender.style.color = nameColor(m.sender);
    replyBarSnippet.textContent = replyingTo.snippet;
    replyBar.classList.remove('hidden');
    textInput.focus();
  }
  function clearReplyingTo() {
    replyingTo = null;
    replyBar.classList.add('hidden');
  }
  replyBarCancel.addEventListener('click', clearReplyingTo);

  function scrollToMessage(id) {
    const row = messagesEl.querySelector(`[data-id="${id}"]`);
    if (!row) {
      toast('Mensagem original nao esta mais visivel.');
      return;
    }
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const bubble = row.querySelector('.bubble');
    if (bubble) {
      bubble.classList.add('flash-highlight');
      setTimeout(() => bubble.classList.remove('flash-highlight'), 1100);
    }
  }

  let toastTimer = null;
  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.remove('hidden');
    // force reflow so the transition replays if called twice in a row
    void toastEl.offsetWidth;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('show');
      setTimeout(() => toastEl.classList.add('hidden'), 250);
    }, 3200);
  }

  // "A outra pessoa esta online agora" - presence tracking piggybacks on
  // the same SSE stream as messages (see connectStream): the server sends
  // a presence-init snapshot the instant this tab connects (who was ALREADY
  // here), then keeps pushing presence updates as either side joins/leaves.
  // announcedPresenceOnEntry guards against re-toasting on the browser's own
  // silent EventSource auto-reconnect (flaky wifi, phone screen lock, etc.) -
  // it only resets when connectStream() is explicitly called again (fresh
  // login), not on every dropped/retried connection.
  let announcedPresenceOnEntry = false;
  function otherPeopleOnline(online) {
    return (online || []).filter((n) => n && n !== myName());
  }
  function updatePresenceIndicator(online) {
    if (!presenceDotEl) return;
    const others = otherPeopleOnline(online);
    presenceDotEl.classList.toggle('offline', others.length === 0);
    presenceDotEl.title = others.length
      ? `${others[0]} está online agora`
      : 'Ninguém mais online agora';
  }

  function updateEmptyState() {
    const isEmpty = renderedIds.size === 0;
    emptyState.classList.toggle('hidden', !isEmpty || !loadingState.classList.contains('hidden'));
  }

  function askConfirm(text, okLabel) {
    return new Promise((resolve) => {
      confirmText.textContent = text;
      confirmOk.textContent = okLabel || 'Continuar';
      confirmOverlay.classList.remove('hidden');

      const cleanup = (result) => {
        confirmOverlay.classList.add('hidden');
        confirmCancel.removeEventListener('click', onCancel);
        confirmOk.removeEventListener('click', onOk);
        resolve(result);
      };
      const onCancel = () => cleanup(false);
      const onOk = () => cleanup(true);
      confirmCancel.addEventListener('click', onCancel);
      confirmOk.addEventListener('click', onOk);
    });
  }

  // Secret "você me ama?" counter. Typing (and sending) a variant of that
  // question doesn't post a real message - it's intercepted client-side
  // and instead reveals, only to whoever typed it, how many times each
  // person has said some variant of "eu te amo" across the visible
  // history. Purely local: never touches the server, never shows up in
  // export or on the other person's screen unless they trigger it too.
  function stripAccents(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  function normalizeLoveText(s) {
    return stripAccents(s).toLowerCase().replace(/[!?.,]+$/g, '').trim();
  }

  const LOVE_TRIGGERS = ['voce me ama', 'vc me ama'];
  const LOVE_PHRASES = [
    'eu te amo', 'te amo', 'amo voce', 'amo vc',
    'i love you', 'love you',
    'te quiero', 'te quiero mucho',
    "je t'aime",
    'ti amo',
  ];

  function isLoveTrigger(text) {
    return LOVE_TRIGGERS.includes(normalizeLoveText(text));
  }

  function countLoveMessages() {
    const counts = new Map();
    for (const { sender, text } of messageLog.values()) {
      if (!text) continue;
      const n = normalizeLoveText(text);
      if (LOVE_PHRASES.some((phrase) => n.includes(phrase))) {
        counts.set(sender, (counts.get(sender) || 0) + 1);
      }
    }
    return counts;
  }

  function showLoveCounter() {
    const counts = countLoveMessages();
    loveList.replaceChildren();
    if (counts.size === 0) {
      const row = document.createElement('div');
      row.className = 'love-row love-empty';
      row.textContent = 'Ninguém falou isso ainda por aqui...';
      loveList.appendChild(row);
    } else {
      // Stable order: whoever has said it more comes first.
      [...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([sender, count]) => {
        const row = document.createElement('div');
        row.className = 'love-row';
        const nameEl = document.createElement('span');
        nameEl.className = 'love-name';
        nameEl.style.color = nameColor(sender);
        nameEl.textContent = sender;
        const countEl = document.createElement('span');
        countEl.className = 'love-count';
        countEl.textContent = `${count}x`;
        row.appendChild(nameEl);
        row.appendChild(countEl);
        loveList.appendChild(row);
      });
    }
    loveOverlay.classList.remove('hidden');
  }

  loveClose.addEventListener('click', () => loveOverlay.classList.add('hidden'));

  // Secret touch "Konami code" - and see also isKonamiEmojiTrigger()
  // further below for a second, easier-to-land way in (typing the emoji
  // version into the composer), both leading to the same showKonamiHeart().
  // Real hardware volume buttons never reach a website's JS (the OS eats
  // them before the browser sees anything), so "volume up"/"volume down"
  // are stood in for by a genuine double-tap
  // right at the very top/bottom edge of the screen - fast enough (within
  // KONAMI_DOUBLE_TAP_MS) to be distinct from the plain single "top"/
  // "bottom" taps earlier in the sequence, which land in a wider band just
  // inside those edges. Full sequence: top, top, bottom, bottom, left,
  // right, left, right, (double-tap top edge), (double-tap bottom edge),
  // center. On completion, a heart shows for a few seconds - nothing is
  // sent to the server, nothing shows up for the other person unless they
  // do it too on their own screen.
  const KONAMI_SEQUENCE = ['top', 'top', 'bottom', 'bottom', 'left', 'right', 'left', 'right', 'volume-up', 'volume-down', 'center'];
  const KONAMI_EDGE_BAND = 0.06; // outermost sliver reserved for the volume double-taps
  const KONAMI_OUTER_BAND = 0.25; // top/bottom/left/right zones, just inside the edge sliver
  const KONAMI_CENTER_MIN = 0.35;
  const KONAMI_CENTER_MAX = 0.65;
  const KONAMI_DOUBLE_TAP_MS = 450;
  const KONAMI_STEP_TIMEOUT_MS = 2500;
  const KONAMI_HEART_MS = 3000;

  let konamiProgress = 0;
  let konamiLastStepAt = 0;
  let konamiPendingEdge = null; // 'top' | 'bottom' | null - awaiting the 2nd tap of a double-tap
  let konamiPendingEdgeAt = 0;
  let konamiHeartTimer = null;

  function konamiZoneFor(xPct, yPct) {
    if (yPct < KONAMI_EDGE_BAND) return 'edge-top';
    if (yPct > 1 - KONAMI_EDGE_BAND) return 'edge-bottom';
    if (xPct >= KONAMI_CENTER_MIN && xPct <= KONAMI_CENTER_MAX && yPct >= KONAMI_CENTER_MIN && yPct <= KONAMI_CENTER_MAX) return 'center';
    if (yPct < KONAMI_OUTER_BAND) return 'top';
    if (yPct > 1 - KONAMI_OUTER_BAND) return 'bottom';
    if (xPct < KONAMI_OUTER_BAND) return 'left';
    if (xPct > 1 - KONAMI_OUTER_BAND) return 'right';
    return null; // dead zone - doesn't match any step, ignored
  }

  function showKonamiHeart() {
    if (!konamiHeart) return;
    clearTimeout(konamiHeartTimer);
    konamiHeart.classList.remove('hidden');
    konamiHeartTimer = setTimeout(() => konamiHeart.classList.add('hidden'), KONAMI_HEART_MS);
  }

  function konamiHandleToken(token, now) {
    if (konamiProgress > 0 && now - konamiLastStepAt > KONAMI_STEP_TIMEOUT_MS) {
      konamiProgress = 0;
    }
    if (token === KONAMI_SEQUENCE[konamiProgress]) {
      konamiProgress += 1;
      konamiLastStepAt = now;
      if (konamiProgress === KONAMI_SEQUENCE.length) {
        konamiProgress = 0;
        showKonamiHeart();
      }
    } else if (token === KONAMI_SEQUENCE[0]) {
      // Wrong step, but this tap could be the start of a fresh attempt.
      konamiProgress = 1;
      konamiLastStepAt = now;
    } else {
      konamiProgress = 0;
    }
  }

  // Second way in: the classic Konami code typed as emoji into the
  // composer (⬆️⬆️⬇️⬇️⬅️➡️⬅️➡️🅱️🅰️🕹️), commas/spaces optional between
  // them - same "secret, local-only" treatment as the touch version and
  // the love counter: intercepted before it ever becomes a real message,
  // never sent to the server, never seen by the other person unless they
  // type it themselves on their own screen.
  const KONAMI_EMOJI_SEQUENCE = '⬆️⬆️⬇️⬇️⬅️➡️⬅️➡️🅱️🅰️🕹️';
  function normalizeKonamiEmojiText(s) {
    return String(s || '').replace(/[,\s]+/g, '');
  }
  function isKonamiEmojiTrigger(text) {
    return normalizeKonamiEmojiText(text) === KONAMI_EMOJI_SEQUENCE;
  }

  // Passive: never preventDefault/stopPropagation, so this can never
  // interfere with normal taps, scrolling, typing, or button presses -
  // it just watches where every tap lands, everywhere in the app.
  window.addEventListener('pointerdown', (evt) => {
    if (typeof evt.clientX !== 'number' || typeof evt.clientY !== 'number') return;
    if (!window.innerWidth || !window.innerHeight) return;
    const xPct = evt.clientX / window.innerWidth;
    const yPct = evt.clientY / window.innerHeight;
    const zone = konamiZoneFor(xPct, yPct);
    if (!zone) return;
    const now = Date.now();

    if (zone === 'edge-top' || zone === 'edge-bottom') {
      const edge = zone === 'edge-top' ? 'top' : 'bottom';
      if (konamiPendingEdge === edge && now - konamiPendingEdgeAt <= KONAMI_DOUBLE_TAP_MS) {
        konamiPendingEdge = null;
        konamiHandleToken(edge === 'top' ? 'volume-up' : 'volume-down', now);
      } else {
        konamiPendingEdge = edge;
        konamiPendingEdgeAt = now;
      }
      return;
    }
    konamiPendingEdge = null;
    konamiHandleToken(zone, now);
  }, { passive: true });

  function resetMessagesView() {
    messagesEl.querySelectorAll('.msg-row, .date-divider').forEach((el) => el.remove());
    renderedIds = new Set();
    messageLog = new Map();
    authorSide = new Map();
    lastRow = null;
    lastSender = null;
    lastTs = null;
    lastDateKey = null;
    clearReplyingTo();
    updateEmptyState();
    updateScrollBtn();
  }

  const NAME_KEY = 'private-chat:my-name';
  nameInput.value = localStorage.getItem(NAME_KEY) || '';
  nameInput.addEventListener('change', () => {
    localStorage.setItem(NAME_KEY, nameInput.value.trim());
  });

  let renderedIds = new Set();
  let es = null;

  // Backs the secret "you love me?" counter Easter egg (see isLoveTrigger/
  // showLoveCounter below): id -> { sender, text } for every currently-
  // visible TEXT message that isn't deleted. Kept in sync as messages
  // render and as deletions come in, so the count always matches what's
  // actually on screen right now - never sent to or read from the server.
  let messageLog = new Map();

  // Tracks the previously-rendered row/sender/time so consecutive messages
  // from the same author can be visually grouped (tighter spacing, avatar/
  // name shown once, timestamp only on the last one of the run) instead of
  // each rendering as a fully separate message like before. lastTs also
  // gates grouping on a time gap (see renderMessage) and lastDateKey drives
  // the day-divider rows.
  let lastRow = null;
  let lastSender = null;
  let lastTs = null;
  let lastDateKey = null;

  // Consecutive messages from the same sender stop being visually grouped
  // once more than this much time has passed between them, even though
  // they're still "the same conversation turn" as far as sideForSender is
  // concerned - matches how WhatsApp breaks a run after a gap instead of
  // grouping messages sent hours apart under one shared timestamp.
  const GROUP_GAP_MS = 5 * 60 * 1000;

  // Which side of the screen each author's bubbles render on. Deterministic
  // and shared by every viewer (unlike comparing against "my name" typed
  // into this particular browser): the first sender to appear in the
  // conversation's chronological order (same for everyone, since the server
  // always returns messages in send order) renders on the left, any other
  // sender renders on the right. That way two different authors always end
  // up on opposite sides, for whoever is looking at the chat.
  let authorSide = new Map();
  function sideForSender(name) {
    if (!authorSide.has(name)) {
      authorSide.set(name, authorSide.size === 0 ? 'them' : 'me');
    }
    return authorSide.get(name);
  }

  // Bubble timestamps are HH:mm only - the date lives in the divider rows
  // instead (see fmtDateDivider/dateKey below), matching how WhatsApp
  // doesn't repeat the full date on every single message.
  function fmtTime(ts) {
    return new Date(ts).toLocaleString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function dateKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function fmtDateDivider(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (dateKey(ts) === dateKey(today.getTime())) return 'Hoje';
    if (dateKey(ts) === dateKey(yesterday.getTime())) return 'Ontem';
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }

  function myName() {
    return (nameInput.value || '').trim();
  }

  async function handleDeleteClick(id) {
    if (!myName()) {
      nameInput.focus();
      return;
    }
    const ok = await askConfirm('Apagar esta mensagem para os dois? Vai ficar marcado que você apagou.', 'Apagar');
    if (!ok) return;
    try {
      const res = await fetch(api(`/api/messages/${id}/delete`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterName: myName() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast(data.message || 'Nao foi possivel apagar essa mensagem.');
      }
      // UI update happens via the SSE "message-deleted" broadcast (same
      // pattern as sending a message), so nothing else to do here.
    } catch (err) {
      // network hiccup — the message just stays as-is
    }
  }

  // WhatsApp-style: the time sits inside the bubble itself, not on a
  // separate line below it. For text (and file/audio) bubbles it floats
  // bottom-right so the text wraps around it; for photo/video it's a small
  // pill overlaid on the media itself (see .msg-time-overlay in style.css).
  function makeTimeEl(ts, overlay) {
    const el = document.createElement('span');
    el.className = overlay ? 'msg-time msg-time-overlay' : 'msg-time';
    el.textContent = fmtTime(ts);
    return el;
  }

  // Matches a URL inside a text message. Deliberately excludes ) . , ! ? ; :
  // from the "core" match so trailing sentence punctuation right after a
  // link ("veja https://exemplo.com." or "(https://exemplo.com)") doesn't
  // get swallowed into the href - see stripTrailingPunctuation below,
  // which hands anything like that back to be rendered as plain text.
  const URL_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+\.[a-z]{2,}[^\s<>"']*)/gi;

  function stripTrailingPunctuation(raw) {
    let trail = '';
    while (raw.length) {
      const last = raw[raw.length - 1];
      if (last === ')') {
        const opens = (raw.match(/\(/g) || []).length;
        const closes = (raw.match(/\)/g) || []).length;
        // Only strip the trailing ) if it's unbalanced (more closes than
        // opens) - a Wikipedia-style URL ending in "_(disambiguation)"
        // should keep its own closing paren.
        if (closes > opens) {
          trail = last + trail;
          raw = raw.slice(0, -1);
          continue;
        }
        break;
      }
      if ('.,!?;:'.includes(last)) {
        trail = last + trail;
        raw = raw.slice(0, -1);
        continue;
      }
      break;
    }
    return { raw, trail };
  }

  // Turns any http(s)/www. link inside a text message into a real, clickable
  // <a> - built entirely with DOM nodes (never innerHTML on user text, which
  // would be an XSS hole) so this is exactly as safe as the plain
  // textContent assignment it replaces.
  function linkify(container, text) {
    URL_RE.lastIndex = 0;
    let lastIndex = 0;
    let match;
    let any = false;
    while ((match = URL_RE.exec(text))) {
      any = true;
      if (match.index > lastIndex) {
        container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const { raw, trail } = stripTrailingPunctuation(match[0]);
      const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      const a = document.createElement('a');
      a.className = 'msg-link';
      a.href = href;
      a.textContent = raw;
      a.target = '_blank';
      a.rel = 'noopener noreferrer nofollow';
      // Don't let a tap-to-open-link also trigger the bubble's own click
      // handling (reply-quote scrolling etc. elsewhere uses bubble clicks).
      a.addEventListener('click', (e) => e.stopPropagation());
      container.appendChild(a);
      if (trail) container.appendChild(document.createTextNode(trail));
      lastIndex = match.index + match[0].length;
    }
    if (!any) {
      container.textContent = text;
      return;
    }
    if (lastIndex < text.length) {
      container.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  // Compact Open Graph preview card for the first link in a message (see
  // scheduleLinkPreview in server.js). Everything here is set via
  // textContent/attributes, never innerHTML - title/description come from
  // a third-party page's <meta> tags and must be treated the same as any
  // other untrusted text. -webkit-line-clamp in the CSS caps how tall the
  // title/description can get; the image itself is capped by
  // .link-preview-img's max-height - between the two, nothing here can
  // grow the bubble past what a normal photo message already can.
  function buildLinkPreviewCard(preview) {
    const card = document.createElement('a');
    card.className = 'link-preview-card';
    card.href = preview.url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer nofollow';
    card.addEventListener('click', (e) => e.stopPropagation());

    if (preview.image) {
      const img = document.createElement('img');
      img.className = 'link-preview-img';
      img.src = preview.image;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.alt = '';
      // A broken/unreachable preview image shouldn't leave an empty-alt
      // broken-image icon sitting in the middle of the chat - just drop it.
      img.addEventListener('error', () => img.remove());
      card.appendChild(img);
    }

    const body = document.createElement('span');
    body.className = 'link-preview-body';
    let site;
    try {
      site = preview.siteName || new URL(preview.url).hostname;
    } catch (e) {
      site = preview.siteName || '';
    }
    if (site) {
      const siteEl = document.createElement('span');
      siteEl.className = 'link-preview-site';
      siteEl.textContent = site;
      body.appendChild(siteEl);
    }
    if (preview.title) {
      const titleEl = document.createElement('span');
      titleEl.className = 'link-preview-title';
      titleEl.textContent = preview.title;
      body.appendChild(titleEl);
    }
    if (preview.description) {
      const descEl = document.createElement('span');
      descEl.className = 'link-preview-desc';
      descEl.textContent = preview.description;
      body.appendChild(descEl);
    }
    card.appendChild(body);
    return card;
  }

  // A preview finished resolving after its message was already rendered
  // (see the "message-updated" SSE listener in connectStream) - patch it
  // into the already-on-screen bubble instead of re-rendering anything.
  function applyLinkPreview(id, linkPreview) {
    if (!linkPreview) return;
    const row = messagesEl.querySelector(`[data-id="${id}"]`);
    const bubble = row && row.querySelector('.bubble');
    if (!bubble || bubble.querySelector('.link-preview-card')) return;
    const wasNearBottom = isNearBottom();
    bubble.appendChild(buildLinkPreviewCard(linkPreview));
    if (wasNearBottom) scrollToBottom();
  }

  function buildBubbleContent(bubble, m) {
    if (m.type === 'text') {
      // append (not bubble.textContent=) so we don't wipe out a reply-quote
      // block that may already have been appended before this call.
      const textEl = document.createElement('span');
      textEl.className = 'bubble-text';
      linkify(textEl, m.text);
      bubble.appendChild(textEl);
      bubble.appendChild(makeTimeEl(m.ts));
      // Already resolved by the time this message loaded from history
      // (see /api/messages); a preview still in flight arrives later via
      // the "message-updated" SSE event (applyLinkPreview).
      if (m.linkPreview) {
        bubble.appendChild(buildLinkPreviewCard(m.linkPreview));
      }
    } else if (m.type === 'image') {
      const wrap = document.createElement('span');
      wrap.className = 'bubble-media-wrap';
      const img = document.createElement('img');
      img.src = api(`/api/media/${m.mediaId}`);
      img.loading = 'lazy';
      img.decoding = 'async';
      // Reserves the right box on first paint (browsers derive an intrinsic
      // aspect-ratio from width/height attrs even under responsive CSS) so
      // the bubble doesn't grow/shift once the real file finishes loading -
      // see readMediaDimensions, captured client-side before upload.
      if (m.width && m.height) {
        img.width = m.width;
        img.height = m.height;
      }
      img.addEventListener('click', () => openLightbox('image', img.src));
      wrap.appendChild(img);
      wrap.appendChild(makeTimeEl(m.ts, true));
      bubble.appendChild(wrap);
    } else if (m.type === 'video') {
      const wrap = document.createElement('span');
      wrap.className = 'bubble-media-wrap';
      const vid = document.createElement('video');
      vid.src = api(`/api/media/${m.mediaId}`);
      vid.controls = true;
      vid.preload = 'metadata';
      if (m.width && m.height) {
        vid.width = m.width;
        vid.height = m.height;
      }
      wrap.appendChild(vid);
      wrap.appendChild(makeTimeEl(m.ts, true));
      bubble.appendChild(wrap);
    } else if (m.type === 'audio') {
      const audio = document.createElement('audio');
      audio.src = api(`/api/media/${m.mediaId}`);
      audio.controls = true;
      bubble.appendChild(audio);
      bubble.appendChild(makeTimeEl(m.ts));
    } else {
      bubble.classList.add('file-bubble');
      bubble.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M8 3.5h6.5L18.5 8v11.5a1.5 1.5 0 0 1-1.5 1.5H8a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 8 3.5Z"/><path d="M14 3.5V8h4.5"/></svg>';
      const label = document.createElement('span');
      label.textContent = m.filename || 'arquivo';
      bubble.appendChild(label);
      bubble.appendChild(makeTimeEl(m.ts));
      bubble.addEventListener('click', () => {
        window.open(api(`/api/media/${m.mediaId}`), '_blank');
      });
    }
  }

  // "Visualização única": a locked placeholder instead of the real photo/
  // video, matching what the server actually sends (no mediaId at all
  // until someone opens it - see sanitizeMessage in server.js). The
  // sender's own copy is never interactive (only the recipient can open a
  // view-once message, enforced server-side too), matching how every real
  // view-once messaging feature works.
  function buildEphemeralLockedContent(bubble, m, isSender) {
    bubble.classList.add('ephemeral-locked');
    const icon = document.createElement('span');
    icon.className = 'ephemeral-icon';
    icon.innerHTML = m.type === 'video'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="M16 10.5 21 7.5v9L16 13.5"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.6" fill="currentColor" stroke="none"/><path d="M5 17.5l4.5-5 3.5 3.5 2-2.2L20 17.5"/></svg>';
    bubble.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'ephemeral-label';
    label.textContent = isSender ? (m.viewedAt ? 'Aberto' : 'Visualização única enviada') : 'Toque para ver';
    bubble.appendChild(label);
    bubble.appendChild(makeTimeEl(m.ts));

    if (!isSender) {
      bubble.classList.add('is-interactive');
      bubble.addEventListener('click', () => openEphemeralMessage(m.id, bubble));
    }
  }

  async function openEphemeralMessage(id, bubble) {
    if (bubble.classList.contains('is-opening') || !bubble.classList.contains('ephemeral-locked')) return;
    bubble.classList.add('is-opening');
    const label = bubble.querySelector('.ephemeral-label');
    if (label) label.textContent = 'Abrindo...';
    try {
      const res = await fetch(api(`/api/messages/${id}/view`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterName: myName() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.message) {
        if (res.status === 410) {
          applyDeletedPlaceholder(id, true);
        } else {
          toast(data.message || 'Não foi possível abrir essa mídia.');
          bubble.classList.remove('is-opening');
          if (label) label.textContent = 'Toque para ver';
        }
        return;
      }
      revealEphemeralBubble(bubble, data.message, data.remainingMs);
    } catch (err) {
      toast('Erro de conexão ao abrir a mídia.');
      bubble.classList.remove('is-opening');
      if (label) label.textContent = 'Toque para ver';
    }
  }

  // Swaps the locked placeholder for the real media (server just revealed
  // the mediaId in its direct response to POST .../view) and starts a
  // local countdown for the rest of the window. The authoritative removal
  // still comes from the server's own "message-deleted" broadcast a few
  // seconds later (applyDeletedPlaceholder is idempotent), so this local
  // countdown reaching zero is just the visible half of that.
  function revealEphemeralBubble(bubble, m, remainingMs) {
    bubble.classList.remove('ephemeral-locked', 'is-interactive', 'is-opening');
    bubble.replaceChildren();
    buildBubbleContent(bubble, m);

    const countdown = document.createElement('span');
    countdown.className = 'ephemeral-countdown';
    const wrap = bubble.querySelector('.bubble-media-wrap');
    (wrap || bubble).appendChild(countdown);

    let remaining = Math.max(Math.round((remainingMs || 0) / 1000), 1);
    countdown.textContent = `${remaining}s`;
    const tick = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(tick);
        applyDeletedPlaceholder(m.id, true);
        return;
      }
      countdown.textContent = `${remaining}s`;
    }, 1000);
  }

  function renderMessage(m, opts) {
    if (renderedIds.has(m.id)) return;
    renderedIds.add(m.id);
    if (m.type === 'text' && !m.deleted && m.text) {
      messageLog.set(m.id, { sender: m.sender, text: m.text });
    }
    const animate = !!(opts && opts.animate);

    // A new calendar day since the last rendered message → insert a
    // centered date pill and start a fresh group, same as WhatsApp never
    // groups across a day boundary even if it's the same sender.
    const thisDateKey = dateKey(m.ts);
    if (thisDateKey !== lastDateKey) {
      const divider = document.createElement('div');
      divider.className = 'date-divider';
      divider.textContent = fmtDateDivider(m.ts);
      messagesEl.appendChild(divider);
      lastDateKey = thisDateKey;
      lastSender = null;
    }

    const color = nameColor(m.sender);
    const mine = sideForSender(m.sender) === 'me';
    // Same author as the message right before this one, sent within the
    // grouping window → render as part of the same visual group instead of
    // a brand-new block.
    const grouped = lastSender === m.sender && lastTs !== null && (m.ts - lastTs) < GROUP_GAP_MS;

    const row = document.createElement('div');
    row.className = `msg-row ${mine ? 'me' : 'them'}${grouped ? ' grouped' : ''}${animate ? ' msg-enter' : ''}`;
    row.dataset.id = m.id;

    const line = document.createElement('div');
    line.className = 'msg-line';

    if (!mine) {
      if (grouped) {
        // Keep the same left indentation as the group's first message
        // without repeating the avatar on every bubble.
        const spacer = document.createElement('div');
        spacer.className = 'avatar-spacer';
        line.appendChild(spacer);
      } else {
        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.style.background = color;
        avatar.textContent = (m.sender || '?').trim().charAt(0).toUpperCase();
        line.appendChild(avatar);
      }
    }

    const body = document.createElement('div');
    body.className = 'msg-body';

    if (!grouped) {
      const senderEl = document.createElement('div');
      senderEl.className = 'msg-sender';
      senderEl.textContent = m.sender;
      senderEl.style.color = color;
      body.appendChild(senderEl);
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (m.deleted) {
      bubble.classList.add('deleted');
      const label = document.createElement('span');
      label.className = 'bubble-text';
      label.textContent = m.expiredEphemeral ? 'mídia expirada' : `mensagem apagada por ${m.deletedBy || m.sender}`;
      bubble.appendChild(label);
      bubble.appendChild(makeTimeEl(m.ts));
    } else if (m.ephemeral) {
      // Deliberately NOT the `mine` (visual left/right side) flag here -
      // sideForSender is a fixed, conversation-wide left/right convention
      // shared identically by both devices (see its own comment above), not
      // "did THIS device send it". Whether view-once media is even
      // tappable has to key off actual identity - m.sender === myName() -
      // or someone could see their own sent photo rendered as an openable
      // "toque para ver" and get an unexplained 403 back from the server
      // when they tap it, which already refuses that (see server.js).
      buildEphemeralLockedContent(bubble, m, m.sender === myName());
    } else {
      if (m.replyTo) {
        const quote = document.createElement('div');
        quote.className = 'reply-quote';
        quote.style.borderColor = nameColor(m.replyTo.sender);
        const qSender = document.createElement('div');
        qSender.className = 'reply-quote-sender';
        qSender.style.color = nameColor(m.replyTo.sender);
        qSender.textContent = m.replyTo.sender;
        const qSnippet = document.createElement('div');
        qSnippet.className = 'reply-quote-snippet';
        qSnippet.textContent = m.replyTo.snippet;
        quote.appendChild(qSender);
        quote.appendChild(qSnippet);
        quote.addEventListener('click', () => scrollToMessage(m.replyTo.id));
        bubble.appendChild(quote);
      }
      buildBubbleContent(bubble, m);
    }
    body.appendChild(bubble);

    if (!m.deleted) {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';

      const replyBtn = document.createElement('button');
      replyBtn.type = 'button';
      replyBtn.className = 'msg-action-btn';
      replyBtn.title = 'Responder';
      replyBtn.setAttribute('aria-label', 'Responder');
      replyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6 4 11l5 5"/><path d="M4 11h9a6 6 0 0 1 6 6v1.5"/></svg>';
      replyBtn.addEventListener('click', () => setReplyingTo(m));
      actions.appendChild(replyBtn);

      // Either person can delete either message (2-person private chat,
      // server enforces the same rule - see server.js) - not gated on
      // identity at all anymore. The deleted placeholder shows who actually
      // did it (applyDeletedPlaceholder), so this stays transparent even
      // though it's no longer restricted to "only the original sender".
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'msg-action-btn is-danger';
      delBtn.title = 'Apagar';
      delBtn.setAttribute('aria-label', 'Apagar mensagem');
      delBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14"/><path d="M7 7l.8 12.1a2 2 0 0 0 2 1.9h4.4a2 2 0 0 0 2-1.9L17 7"/><path d="M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2"/></svg>';
      delBtn.addEventListener('click', () => handleDeleteClick(m.id));
      actions.appendChild(delBtn);

      body.appendChild(actions);
    }

    line.appendChild(body);
    row.appendChild(line);

    if (grouped && lastRow) {
      // Only the last message of a group keeps its visible timestamp - but
      // never hide a photo/video's overlay pill, which WhatsApp always
      // shows regardless of grouping since it doesn't cost any extra
      // vertical space the way the floated text-bubble time does.
      const prevTime = lastRow.querySelector('.msg-time:not(.msg-time-overlay)');
      if (prevTime) prevTime.classList.add('hidden');
    }

    messagesEl.appendChild(row);
    lastRow = row;
    lastSender = m.sender;
    lastTs = m.ts;
    updateEmptyState();
  }

  function applyDeletedPlaceholder(id, expiredEphemeral, deletedBy) {
    messageLog.delete(id);
    const row = messagesEl.querySelector(`[data-id="${id}"]`);
    if (!row) return;
    const bubble = row.querySelector('.bubble');
    if (bubble) {
      // Grab whatever time text is already showing (works whether this
      // bubble was a normal message, a still-locked view-once placeholder,
      // or already mid-reveal with a live countdown) before wiping it, so
      // the placeholder still carries a timestamp like every other bubble.
      const existingTime = bubble.querySelector('.msg-time');
      const tsText = existingTime ? existingTime.textContent : '';
      bubble.className = 'bubble deleted';
      bubble.replaceChildren();
      const label = document.createElement('span');
      label.className = 'bubble-text';
      // Either person can delete either message now (see server.js), so
      // this always names who actually did it, not just "pelo autor".
      label.textContent = expiredEphemeral ? 'mídia expirada' : `mensagem apagada por ${deletedBy}`;
      bubble.appendChild(label);
      if (tsText) {
        const timeEl = document.createElement('span');
        timeEl.className = 'msg-time';
        timeEl.textContent = tsText;
        bubble.appendChild(timeEl);
      }
    }
    const actions = row.querySelector('.msg-actions');
    if (actions) actions.remove();
  }

  function openLightbox(kind, src) {
    lightboxContent.innerHTML = '';
    const el = document.createElement(kind === 'image' ? 'img' : 'video');
    el.src = src;
    if (kind === 'video') el.controls = true;
    lightboxContent.appendChild(el);
    lightbox.classList.remove('hidden');
  }

  lightboxClose.addEventListener('click', () => lightbox.classList.add('hidden'));
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) lightbox.classList.add('hidden');
  });

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Media (img/video/audio) inside newly rendered bubbles loads asynchronously,
  // so the container's real height isn't known right after the synchronous
  // render. Nudge the scroll position down again as things settle so we
  // reliably land on the very last message instead of stopping wherever the
  // layout happened to be at that instant.
  function scrollToBottomWhenReady() {
    scrollToBottom();
    requestAnimationFrame(() => {
      scrollToBottom();
      requestAnimationFrame(scrollToBottom);
    });
    // Media that already has width/height reserved (see readMediaDimensions/
    // renderMessage) doesn't reflow when it finishes loading, so most of
    // these listeners now simply never fire in practice. They're still
    // useful as a fallback for older messages sent before this feature
    // existed (no stored dimensions) and for a handful of edge cases (a
    // slow/odd decode). What changed: instead of one hard, instant
    // scrollTop=scrollHeight PER media element - which is what produced the
    // flicker/"snaps to the top and back" effect when several photos/videos
    // finished loading close together - every load now just requests a
    // single batched correction on the next frame, and that correction only
    // actually moves the scroll position if we were still following the
    // bottom at that moment (isNearBottom()), so it never yanks someone who
    // has since scrolled up to read something else.
    let correctionQueued = false;
    function queueScrollCorrection() {
      if (correctionQueued) return;
      correctionQueued = true;
      requestAnimationFrame(() => {
        correctionQueued = false;
        if (isNearBottom()) scrollToBottom();
      });
    }
    messagesEl.querySelectorAll('img, video, audio').forEach((el) => {
      const ready = el.tagName === 'IMG' ? el.complete : el.readyState >= 1;
      if (ready) return;
      const evt = el.tagName === 'IMG' ? 'load' : 'loadedmetadata';
      el.addEventListener(evt, queueScrollCorrection, { once: true });
      el.addEventListener('error', queueScrollCorrection, { once: true });
    });
    // The media-load listeners above fire later (once images decode), so
    // give the floating button a beat to re-check before settling.
    setTimeout(updateScrollBtn, 400);
  }

  function isNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  }

  // Floating "go to last messages" button: a manual fallback for whenever
  // the automatic scroll doesn't land exactly at the bottom (slow network,
  // a browser that fires load events late, etc.) or for whenever someone
  // has scrolled up to read older messages on purpose.
  function updateScrollBtn() {
    scrollBottomBtn.classList.toggle('hidden', isNearBottom());
  }
  messagesEl.addEventListener('scroll', updateScrollBtn);
  scrollBottomBtn.addEventListener('click', () => {
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
  });

  // Keyboard-aware scroll: --app-height (set by setAppHeight, top of file)
  // shrinks .screen/.messages the instant the on-screen keyboard opens, but
  // #messages' scrollTop doesn't move on its own - the same scrollTop now
  // sits farther from the (smaller) bottom, so the message someone was
  // reading can end up hidden behind the keyboard. This listener owns
  // setAppHeight() for the resize case specifically so it can check
  // isNearBottom() against the PRE-resize layout, then re-clamp scroll
  // afterwards if that check said "yes, keep following the bottom".
  // It also guards against iOS occasionally nudging the whole page (not
  // just the visual viewport) when a field gets focus - since every
  // scrollable area here is meant to be #messages, never the document.
  function syncViewportHeight() {
    const stickToBottom = isNearBottom();
    setAppHeight();
    requestAnimationFrame(() => {
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
      if (stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewportHeight);
    // iOS also fires 'scroll' on visualViewport (not just 'resize') when
    // the keyboard shifts the layout viewport on focus - same fix applies.
    window.visualViewport.addEventListener('scroll', () => {
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    });
  }
  // Belt-and-suspenders for the rotation case: visualViewport's own resize
  // usually covers it, but Safari has historically fired it a beat late on
  // orientationchange, so re-check shortly after too - reusing the same
  // stick-to-bottom + scroll-drift logic, not just the raw height, since a
  // rotation with the keyboard already open is the shortest viewport this
  // app ever renders at and needs the same protection.
  window.addEventListener('orientationchange', () => setTimeout(syncViewportHeight, 60));

  async function loadMessages() {
    loadingState.classList.remove('hidden');
    emptyState.classList.add('hidden');
    try {
      const res = await fetch(api('/api/messages'));
      if (!res.ok) return;
      const { messages } = await res.json();
      resetMessagesView();
      messages.forEach(renderMessage);
      scrollToBottomWhenReady();
      updateScrollBtn();
    } finally {
      loadingState.classList.add('hidden');
      updateEmptyState();
    }
  }

  function connectStream() {
    if (es) es.close();
    announcedPresenceOnEntry = false;
    es = new EventSource(api(`/api/stream?name=${encodeURIComponent(myName())}`));
    // Snapshot sent once, right when this tab connects: who was ALREADY in
    // the room before I joined. This - and only this - is what triggers the
    // entry toast; later joins/leaves just update the header dot silently.
    es.addEventListener('presence-init', (evt) => {
      const { online } = JSON.parse(evt.data);
      updatePresenceIndicator(online);
      const others = otherPeopleOnline(online);
      if (others.length && !announcedPresenceOnEntry) {
        toast(`${others[0]} já está online agora.`);
      }
      announcedPresenceOnEntry = true;
    });
    es.addEventListener('presence', (evt) => {
      const { online } = JSON.parse(evt.data);
      updatePresenceIndicator(online);
    });
    es.addEventListener('message-updated', (evt) => {
      const { id, linkPreview } = JSON.parse(evt.data);
      applyLinkPreview(id, linkPreview);
    });
    es.addEventListener('message', (evt) => {
      // Only auto-follow to the new message if the person was already at
      // (or very near) the bottom — otherwise this would yank them away
      // from older messages they're in the middle of reading. They still
      // get the floating button to jump down whenever they want.
      const wasNearBottom = isNearBottom();
      const m = JSON.parse(evt.data);
      renderMessage(m, { animate: true });
      if (wasNearBottom) {
        scrollToBottomWhenReady();
      } else {
        updateScrollBtn();
      }
    });
    es.addEventListener('cleared', () => {
      resetMessagesView();
    });
    es.addEventListener('message-deleted', (evt) => {
      const { id, expiredEphemeral, deletedBy } = JSON.parse(evt.data);
      applyDeletedPlaceholder(id, expiredEphemeral, deletedBy);
    });
    // The other person opened a view-once photo/video I sent - just a
    // label update (locked → "Aberto"); the media itself never reaches
    // this client, only whoever actually called .../view gets it.
    es.addEventListener('message-viewed', (evt) => {
      const { id } = JSON.parse(evt.data);
      const row = messagesEl.querySelector(`[data-id="${id}"]`);
      const label = row && row.querySelector('.ephemeral-locked .ephemeral-label');
      if (label) label.textContent = 'Aberto';
    });
    es.onerror = () => {
      // browser auto-retries; nothing to do
    };
  }

  async function checkAuth() {
    const res = await fetch(api('/api/me'));
    const { authenticated } = await res.json();
    if (authenticated) showChat();
    else showLogin();
  }

  function showLogin() {
    loginScreen.classList.remove('hidden');
    chatScreen.classList.add('hidden');
    decoyScreen.classList.add('hidden');
    codeInput.focus();
  }

  // Tela-armadilha: nada de mensagens, SSE ou qualquer chamada que toque o
  // chat de verdade - só o texto fixo, pra quem digitou o código-armadilha
  // não ver nada além disso.
  function showDecoy() {
    loginScreen.classList.add('hidden');
    chatScreen.classList.add('hidden');
    decoyScreen.classList.remove('hidden');
  }

  async function showChat() {
    loginScreen.classList.add('hidden');
    chatScreen.classList.remove('hidden');
    await loadMessages();
    connectStream();
    textInput.focus();
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    const code = codeInput.value;
    if (!code) return;
    try {
      const res = await fetch(api('/api/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (res.ok && data.ok && data.decoy) {
        codeInput.value = '';
        showDecoy();
      } else if (res.ok && data.ok) {
        codeInput.value = '';
        showChat();
      } else {
        loginError.textContent = data.message || 'Codigo incorreto.';
      }
    } catch (err) {
      loginError.textContent = 'Erro de conexao.';
    }
  });

  composer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textInput.value.trim();
    const sender = myName();
    if (!sender) {
      nameInput.focus();
      return;
    }
    if (!text) return;
    if (isLoveTrigger(text)) {
      textInput.value = '';
      updateSendBtnState();
      showLoveCounter();
      return;
    }
    if (isKonamiEmojiTrigger(text)) {
      textInput.value = '';
      updateSendBtnState();
      showKonamiHeart();
      return;
    }
    textInput.value = '';
    updateSendBtnState();
    const replyToId = replyingTo ? replyingTo.id : undefined;
    clearReplyingTo();
    try {
      await fetch(api('/api/messages'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender, text, replyToId }),
      });
    } catch (err) {
      textInput.value = text;
      updateSendBtnState();
    }
  });

  const sendBtn = composer.querySelector('.send-btn');
  function updateSendBtnState() {
    sendBtn.classList.toggle('is-empty', !textInput.value.trim());
  }
  textInput.addEventListener('input', updateSendBtnState);
  updateSendBtnState();

  attachBtn.addEventListener('click', () => fileInput.click());

  // "Visualização única" toggle: arms the NEXT attachment (or batch of
  // attachments) to be sent as view-once media. Resets itself after each
  // send rather than staying on indefinitely, so it can't be left armed by
  // accident for some unrelated later photo.
  let ephemeralArmed = false;
  function setEphemeralArmed(v) {
    ephemeralArmed = v;
    ephemeralToggleBtn.classList.toggle('is-armed', v);
    ephemeralToggleBtn.setAttribute('aria-pressed', String(v));
    ephemeralToggleBtn.title = v
      ? 'Visualização única ativada — a próxima foto/vídeo expira 10s depois de aberta'
      : 'Ativar visualização única (mídia expira 10s depois de aberta)';
  }
  ephemeralToggleBtn.addEventListener('click', () => setEphemeralArmed(!ephemeralArmed));

  // Reads the intrinsic width/height of an image or video File BEFORE it's
  // uploaded (decoding it locally via a throwaway object URL - never
  // touches the network), so the server can hand those numbers back with
  // the message and the bubble can reserve the right box from the very
  // first paint. This is what actually stops the page from jumping/
  // flickering as each photo/video finishes downloading later - without
  // it the browser has no idea how tall the bubble will be until the file
  // arrives, so every one that loads reflows everything below it.
  // Best-effort: any failure (unsupported format, slow decode) just
  // resolves with null and that one bubble falls back to the old
  // grows-once-loaded behavior instead of blocking the upload.
  function readMediaDimensions(file) {
    return new Promise((resolve) => {
      const isImage = file.type.startsWith('image/');
      const isVideo = file.type.startsWith('video/');
      if (!isImage && !isVideo) {
        resolve(null);
        return;
      }
      const url = URL.createObjectURL(file);
      let done = false;
      const finish = (dims) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        URL.revokeObjectURL(url);
        resolve(dims);
      };
      const timer = setTimeout(() => finish(null), 8000);
      if (isImage) {
        const probe = new Image();
        probe.onload = () => finish(
          probe.naturalWidth && probe.naturalHeight
            ? { width: probe.naturalWidth, height: probe.naturalHeight }
            : null
        );
        probe.onerror = () => finish(null);
        probe.src = url;
      } else {
        const probe = document.createElement('video');
        probe.preload = 'metadata';
        probe.onloadedmetadata = () => finish(
          probe.videoWidth && probe.videoHeight
            ? { width: probe.videoWidth, height: probe.videoHeight }
            : null
        );
        probe.onerror = () => finish(null);
        probe.src = url;
      }
    });
  }

  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    fileInput.value = '';
    if (!files.length) return;
    const sender = myName();
    if (!sender) {
      nameInput.focus();
      return;
    }

    const wantsEphemeral = ephemeralArmed;
    setEphemeralArmed(false);
    if (wantsEphemeral && files.some((f) => !f.type.startsWith('image/') && !f.type.startsWith('video/'))) {
      toast('Áudio e arquivos são enviados normalmente — visualização única vale só para foto/vídeo.');
    }

    // Reply applies only to the first item of a multi-file batch - quoting
    // the same message on every one of five photos would just be noise.
    const replyToId = replyingTo ? replyingTo.id : undefined;
    clearReplyingTo();

    let failCount = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      uploadProgress.textContent = files.length > 1 ? `Enviando ${i + 1} de ${files.length}...` : `Enviando ${file.name}...`;
      uploadProgress.classList.remove('hidden');

      const dims = await readMediaDimensions(file);

      const form = new FormData();
      form.append('file', file);
      form.append('sender', sender);
      if (i === 0 && replyToId) form.append('replyToId', replyToId);
      if (wantsEphemeral) form.append('ephemeral', '1');
      if (dims) {
        form.append('width', String(dims.width));
        form.append('height', String(dims.height));
      }

      try {
        const res = await fetch(api('/api/media'), { method: 'POST', body: form });
        if (!res.ok) throw new Error('upload failed');
      } catch (err) {
        failCount++;
      }
    }

    if (failCount) {
      uploadProgress.textContent = files.length > 1
        ? `${files.length - failCount} de ${files.length} arquivos enviados. ${failCount} falharam.`
        : 'Falha ao enviar arquivo.';
      setTimeout(() => uploadProgress.classList.add('hidden'), 2500);
    } else {
      uploadProgress.classList.add('hidden');
    }
  });

  exportBtn.addEventListener('click', () => {
    window.open(api('/api/export'), '_blank');
  });

  clearBtn.addEventListener('click', async () => {
    const step1 = await askConfirm(
      'Tem certeza que quer limpar essa conversa? Todas as mensagens, fotos, vídeos e áudios serão apagados.'
    );
    if (!step1) return;

    const step2 = await askConfirm(
      'Essa ação não pode ser desfeita: tudo será apagado permanentemente do Mac agora. Confirma mesmo?',
      'Apagar tudo'
    );
    if (!step2) return;

    try {
      const res = await fetch(api('/api/clear'), { method: 'POST' });
      if (res.ok) resetMessagesView();
    } catch (err) {
      // ignora — a conversa simplesmente continua como estava
    }
  });

  logoutBtn.addEventListener('click', async () => {
    await fetch(api('/api/logout'), { method: 'POST' });
    if (es) es.close();
    showLogin();
  });

  checkAuth();
})();
