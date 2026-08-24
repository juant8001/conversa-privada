(() => {
  'use strict';

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
    clearReplyingTo();
    updateEmptyState();
  }

  const NAME_KEY = 'private-chat:my-name';
  nameInput.value = localStorage.getItem(NAME_KEY) || '';
  nameInput.addEventListener('change', () => {
    localStorage.setItem(NAME_KEY, nameInput.value.trim());
  });

  let renderedIds = new Set();
  let es = null;

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
    const mine = myName() && m.sender === myName();

    const row = document.createElement('div');
    row.className = `msg-row ${mine ? 'me' : 'them'}`;
    row.dataset.id = m.id;

    const line = document.createElement('div');
    line.className = 'msg-line';

    if (!mine) {
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.style.background = color;
      avatar.textContent = (m.sender || '?').trim().charAt(0).toUpperCase();
      line.appendChild(avatar);
    }

    const body = document.createElement('div');
    body.className = 'msg-body';

    const senderEl = document.createElement('div');
    senderEl.className = 'msg-sender';
    senderEl.textContent = m.sender;
    senderEl.style.color = color;
    body.appendChild(senderEl);

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

    messagesEl.appendChild(row);
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

  async function loadMessages() {
    loadingState.classList.remove('hidden');
    emptyState.classList.add('hidden');
    try {
      const res = await fetch(api('/api/messages'));
      if (!res.ok) return;
      const { messages } = await res.json();
      resetMessagesView();
      messages.forEach(renderMessage);
      scrollToBottom();
    } finally {
      loadingState.classList.add('hidden');
      updateEmptyState();
    }
  }

  function connectStream() {
    if (es) es.close();
    es = new EventSource(api('/api/stream'));
    es.addEventListener('message', (evt) => {
      const m = JSON.parse(evt.data);
      renderMessage(m);
      scrollToBottom();
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
