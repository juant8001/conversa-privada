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
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', setAppHeight);
  } else {
    window.addEventListener('resize', setAppHeight);
  }

  const roomPath = location.pathname.replace(/\/$/, ''); // e.g. /c/<slug>
  const api = (p) => `${roomPath}${p}`;

  const loginScreen = document.getElementById('login-screen');
  const chatScreen = document.getElementById('chat-screen');
  const loginForm = document.getElementById('login-form');
  const codeInput = document.getElementById('code-input');
  const loginError = document.getElementById('login-error');
  const messagesEl = document.getElementById('messages');
  const composer = document.getElementById('composer');
  const nameInput = document.getElementById('name-input');
  const textInput = document.getElementById('text-input');
  const fileInput = document.getElementById('file-input');
  const attachBtn = document.getElementById('attach-btn');
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
  const loadingState = document.getElementById('loading-state');
  const emptyState = document.getElementById('empty-state');
  const toastEl = document.getElementById('toast');
  const replyBar = document.getElementById('reply-bar');
  const replyBarSender = document.getElementById('reply-bar-sender');
  const replyBarSnippet = document.getElementById('reply-bar-snippet');
  const replyBarCancel = document.getElementById('reply-bar-cancel');
  const scrollBottomBtn = document.getElementById('scroll-bottom-btn');

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
    if (m.deleted) return 'Mensagem apagada pelo autor';
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

  function resetMessagesView() {
    messagesEl.querySelectorAll('.msg-row').forEach((el) => el.remove());
    renderedIds = new Set();
    authorSide = new Map();
    lastRow = null;
    lastSender = null;
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

  // Tracks the previously-rendered row/sender so consecutive messages from
  // the same author can be visually grouped (tighter spacing, avatar/name
  // shown once, timestamp only on the last one of the run) instead of each
  // rendering as a fully separate message like before.
  let lastRow = null;
  let lastSender = null;

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

  function fmtTime(ts) {
    return new Date(ts).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }

  function myName() {
    return (nameInput.value || '').trim();
  }

  async function handleDeleteClick(id) {
    const ok = await askConfirm('Apagar esta mensagem para os dois? Ela vira "mensagem apagada pelo autor".', 'Apagar');
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

  function buildBubbleContent(bubble, m) {
    if (m.type === 'text') {
      // append (not bubble.textContent=) so we don't wipe out a reply-quote
      // block that may already have been appended before this call.
      const textEl = document.createElement('span');
      textEl.className = 'bubble-text';
      textEl.textContent = m.text;
      bubble.appendChild(textEl);
    } else if (m.type === 'image') {
      const img = document.createElement('img');
      img.src = api(`/api/media/${m.mediaId}`);
      img.loading = 'lazy';
      img.addEventListener('click', () => openLightbox('image', img.src));
      bubble.appendChild(img);
    } else if (m.type === 'video') {
      const vid = document.createElement('video');
      vid.src = api(`/api/media/${m.mediaId}`);
      vid.controls = true;
      bubble.appendChild(vid);
    } else if (m.type === 'audio') {
      const audio = document.createElement('audio');
      audio.src = api(`/api/media/${m.mediaId}`);
      audio.controls = true;
      bubble.appendChild(audio);
    } else {
      bubble.classList.add('file-bubble');
      bubble.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M8 3.5h6.5L18.5 8v11.5a1.5 1.5 0 0 1-1.5 1.5H8a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 8 3.5Z"/><path d="M14 3.5V8h4.5"/></svg>';
      const label = document.createElement('span');
      label.textContent = m.filename || 'arquivo';
      bubble.appendChild(label);
      bubble.addEventListener('click', () => {
        window.open(api(`/api/media/${m.mediaId}`), '_blank');
      });
    }
  }

  function renderMessage(m) {
    if (renderedIds.has(m.id)) return;
    renderedIds.add(m.id);

    const color = nameColor(m.sender);
    const mine = sideForSender(m.sender) === 'me';
    // Same author as the message right before this one → render as part of
    // the same visual group instead of a brand-new block.
    const grouped = lastSender === m.sender;

    const row = document.createElement('div');
    row.className = `msg-row ${mine ? 'me' : 'them'}${grouped ? ' grouped' : ''}`;
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
      bubble.textContent = 'mensagem apagada pelo autor';
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

    const timeEl = document.createElement('div');
    timeEl.className = 'msg-time';
    timeEl.textContent = fmtTime(m.ts);
    body.appendChild(timeEl);

    if (!m.deleted) {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';

      const replyBtn = document.createElement('button');
      replyBtn.className = 'msg-action-btn';
      replyBtn.textContent = 'responder';
      replyBtn.addEventListener('click', () => setReplyingTo(m));
      actions.appendChild(replyBtn);

      if (mine) {
        const delBtn = document.createElement('button');
        delBtn.className = 'msg-action-btn is-danger';
        delBtn.textContent = 'apagar';
        delBtn.addEventListener('click', () => handleDeleteClick(m.id));
        actions.appendChild(delBtn);
      }

      body.appendChild(actions);
    }

    line.appendChild(body);
    row.appendChild(line);

    if (grouped && lastRow) {
      // Only the last message of a group keeps its visible timestamp.
      const prevTime = lastRow.querySelector('.msg-time');
      if (prevTime) prevTime.classList.add('hidden');
    }

    messagesEl.appendChild(row);
    lastRow = row;
    lastSender = m.sender;
    updateEmptyState();
  }

  function applyDeletedPlaceholder(id) {
    const row = messagesEl.querySelector(`[data-id="${id}"]`);
    if (!row) return;
    const bubble = row.querySelector('.bubble');
    if (bubble) {
      bubble.className = 'bubble deleted';
      bubble.textContent = 'mensagem apagada pelo autor';
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
    messagesEl.querySelectorAll('img, video, audio').forEach((el) => {
      const ready = el.tagName === 'IMG' ? el.complete : el.readyState >= 1;
      if (ready) return;
      const evt = el.tagName === 'IMG' ? 'load' : 'loadedmetadata';
      el.addEventListener(evt, scrollToBottom, { once: true });
      el.addEventListener('error', scrollToBottom, { once: true });
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
    es = new EventSource(api('/api/stream'));
    es.addEventListener('message', (evt) => {
      // Only auto-follow to the new message if the person was already at
      // (or very near) the bottom — otherwise this would yank them away
      // from older messages they're in the middle of reading. They still
      // get the floating button to jump down whenever they want.
      const wasNearBottom = isNearBottom();
      const m = JSON.parse(evt.data);
      renderMessage(m);
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
      const { id } = JSON.parse(evt.data);
      applyDeletedPlaceholder(id);
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
    codeInput.focus();
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
      if (res.ok && data.ok) {
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
    textInput.value = '';
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
    }
  });

  attachBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    const sender = myName();
    if (!sender) {
      nameInput.focus();
      return;
    }
    uploadProgress.textContent = `Enviando ${file.name}...`;
    uploadProgress.classList.remove('hidden');

    const form = new FormData();
    form.append('file', file);
    form.append('sender', sender);
    if (replyingTo) form.append('replyToId', replyingTo.id);
    clearReplyingTo();

    try {
      const res = await fetch(api('/api/media'), { method: 'POST', body: form });
      if (!res.ok) throw new Error('upload failed');
    } catch (err) {
      uploadProgress.textContent = 'Falha ao enviar arquivo.';
      setTimeout(() => uploadProgress.classList.add('hidden'), 2500);
      return;
    }
    uploadProgress.classList.add('hidden');
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
