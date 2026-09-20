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
  // updateMediaMaxWidth (defined further down, near syncViewportHeight) is
  // also re-run from there on a visualViewport resize; this plain listener
  // is just the fallback for whenever that doesn't fire (unlike setAppHeight
  // above, kept unconditional since a plain window resize on desktop isn't
  // guaranteed to also fire visualViewport's).
  window.addEventListener('resize', updateMediaMaxWidth);

  const roomPath = location.pathname.replace(/\/$/, ''); // e.g. /c/<slug>
  const api = (p) => `${roomPath}${p}`;

  const loginScreen = document.getElementById('login-screen');
  const chatScreen = document.getElementById('chat-screen');
  const decoyScreen = document.getElementById('decoy-screen');
  const nameScreen = document.getElementById('name-screen');
  const nameForm = document.getElementById('name-form');
  const nameScreenInput = document.getElementById('name-screen-input');
  const loginForm = document.getElementById('login-form');
  const codeInput = document.getElementById('code-input');
  const codeRevealBtn = document.getElementById('code-reveal-btn');
  const loginError = document.getElementById('login-error');
  const messagesEl = document.getElementById('messages');
  const composer = document.getElementById('composer');
  const nameInput = document.getElementById('name-input');
  const textInput = document.getElementById('text-input');
  const fileInput = document.getElementById('file-input');
  const cameraInput = document.getElementById('camera-input');
  const plusBtn = document.getElementById('plus-btn');
  const plusMenu = document.getElementById('plus-menu');
  const plusMenuBackdrop = document.getElementById('plus-menu-backdrop');
  const cameraBtn = document.getElementById('camera-btn');
  const cameraMenu = document.getElementById('camera-menu');
  const cameraMenuBackdrop = document.getElementById('camera-menu-backdrop');
  const cameraMenuNormalBtn = document.getElementById('camera-menu-normal');
  const cameraMenuEphemeralBtn = document.getElementById('camera-menu-ephemeral');
  const cameraMenuAttachBtn = document.getElementById('camera-menu-attach');
  const cameraMenuAttachEphemeralBtn = document.getElementById('camera-menu-attach-ephemeral');
  const exportBtn = document.getElementById('export-btn');
  const clearBtn = document.getElementById('clear-btn');
  const logoutBtn = document.getElementById('logout-btn');
  const uploadProgress = document.getElementById('upload-progress');
  const lightbox = document.getElementById('lightbox');
  const lightboxContent = document.getElementById('lightbox-content');
  const lightboxClose = document.getElementById('lightbox-close');
  const mediaBtn = document.getElementById('media-btn');
  const mediaPanel = document.getElementById('media-panel');
  const mediaBack = document.getElementById('media-back');
  const mediaScroll = document.getElementById('media-scroll');
  const mediaGrid = document.getElementById('media-grid');
  const mediaSentinel = document.getElementById('media-sentinel');
  const mediaLoading = document.getElementById('media-loading');
  const mediaEmpty = document.getElementById('media-empty');
  const mediaCount = document.getElementById('media-count');
  const confirmOverlay = document.getElementById('confirm-overlay');
  const confirmText = document.getElementById('confirm-text');
  const confirmCancel = document.getElementById('confirm-cancel');
  const confirmOk = document.getElementById('confirm-ok');
  const loveOverlay = document.getElementById('love-overlay');
  const loveList = document.getElementById('love-list');
  const loveClose = document.getElementById('love-close');
  const konamiHeart = document.getElementById('konami-heart');
  const loadingState = document.getElementById('loading-state');
  const loadingOlderEl = document.getElementById('loading-older');
  const emptyState = document.getElementById('empty-state');
  const toastEl = document.getElementById('toast');
  const presenceDotEl = document.querySelector('.chat-header .dot');
  const replyBar = document.getElementById('reply-bar');
  const replyBarThumb = document.getElementById('reply-bar-thumb');
  const replyBarSender = document.getElementById('reply-bar-sender');
  const replyBarSnippet = document.getElementById('reply-bar-snippet');
  const replyBarCancel = document.getElementById('reply-bar-cancel');
  // Se a miniatura falhar ao carregar (ex: mídia original apagada), some
  // sem mais - mesma tolerância a falha do preview de link.
  replyBarThumb.addEventListener('error', () => replyBarThumb.classList.add('hidden'));
  const scrollBottomBtn = document.getElementById('scroll-bottom-btn');
  const msgMenu = document.getElementById('msg-menu');
  const msgMenuBackdrop = document.getElementById('msg-menu-backdrop');
  const msgMenuGotoBtn = document.getElementById('msg-menu-goto');
  const msgMenuReplyBtn = document.getElementById('msg-menu-reply');
  const msgMenuCopyBtn = document.getElementById('msg-menu-copy');
  const msgMenuSelectBtn = document.getElementById('msg-menu-select');
  const msgMenuDelBtn = document.getElementById('msg-menu-delete');
  const msgMenuReactions = document.getElementById('msg-menu-reactions');
  const reactionPicks = msgMenu.querySelectorAll('.reaction-pick');

  // Conjunto fixo de reações. Mantém em sincronia com REACTION_EMOJIS em
  // server.js (o servidor rejeita qualquer emoji fora dessa lista).
  const REACTION_EMOJIS = ['❤️', '👍', '😂', '😮', '😢', '🔥'];

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
  // Mesma regra do buildMediaTile (aba Mídia): prefere thumbId, cai pro
  // mediaId só pra foto (nunca vídeo - um <img> num .mp4 cru baixa o
  // arquivo inteiro e não decodifica nada), e nunca pra ephemeral (que já
  // chega sem thumbId/mediaId, sanitizado pelo servidor).
  function replyThumbId(m) {
    if (m.ephemeral) return undefined;
    if (m.type === 'image') return m.thumbId || m.mediaId;
    if (m.type === 'video') return m.thumbId;
    return undefined;
  }
  function setReplyingTo(m) {
    replyingTo = { id: m.id, sender: m.sender, snippet: snippetFor(m) };
    replyBarSender.textContent = m.sender;
    replyBarSender.style.color = nameColor(m.sender);
    replyBarSnippet.textContent = replyingTo.snippet;
    const thumbId = replyThumbId(m);
    if (thumbId) {
      replyBarThumb.src = api(`/api/media/${thumbId}`);
      replyBarThumb.classList.remove('hidden');
    } else {
      replyBarThumb.classList.add('hidden');
      replyBarThumb.removeAttribute('src');
    }
    replyBar.classList.remove('hidden');
    // scroll-bottom-btn's offset accounts for this so it floats above the
    // reply bar instead of on top of it (see .scroll-bottom-btn in style.css).
    // O thumb tem tamanho fixo no CSS, então isso é seguro antes dele carregar.
    document.documentElement.style.setProperty('--reply-bar-h', `${replyBar.offsetHeight}px`);
    textInput.focus();
  }
  function clearReplyingTo() {
    replyingTo = null;
    replyBar.classList.add('hidden');
    replyBarThumb.classList.add('hidden');
    replyBarThumb.removeAttribute('src');
    document.documentElement.style.setProperty('--reply-bar-h', '0px');
  }
  replyBarCancel.addEventListener('click', clearReplyingTo);

  // opts.smooth (padrão true) existe pro salto de longe: animar a rolagem por
  // cima de centenas de linhas recém-renderizadas fica lento e sacudido, então
  // jumpToMessage pede 'auto' e cai direto no lugar.
  function scrollToMessage(id, opts) {
    const row = messagesEl.querySelector(`[data-id="${id}"]`);
    if (!row) {
      toast('Mensagem original nao esta mais visivel.');
      return;
    }
    const smooth = !opts || opts.smooth !== false;
    row.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
    const bubble = row.querySelector('.bubble');
    if (bubble) {
      bubble.classList.add('flash-highlight');
      setTimeout(() => bubble.classList.remove('flash-highlight'), 1100);
    }
  }

  // "Ir para a mensagem". Diferente do scrollToMessage, que só olha o DOM e
  // desiste com um toast, este busca no servidor quando a mensagem está fora do
  // lote carregado - o caso normal vindo da aba Mídia, onde a grade mostra
  // meses de foto mas o chat só carregou as PAGE_SIZE mais novas.
  //
  // O ?from= devolve tudo daquela mensagem até a MAIS NOVA (ver a rota em
  // server.js): loadedMessages continua sendo um sufixo terminando na última
  // mensagem, que é o que o append do SSE, o loadOlderMessages e o botão "ir
  // pro fim" assumem. Uma janela centrada no alvo quebraria os três.
  async function jumpToMessage(id) {
    if (messagesEl.querySelector(`[data-id="${id}"]`)) {
      scrollToMessage(id);
      return;
    }
    let messages, hasMore;
    try {
      const res = await fetch(api(`/api/messages?from=${encodeURIComponent(id)}`));
      if (!res.ok) throw new Error('jump failed');
      ({ messages, hasMore } = await res.json());
    } catch (e) {
      toast('Mensagem original nao esta mais visivel.');
      return;
    }
    if (!messages || !messages.length) {
      toast('Mensagem original nao esta mais visivel.');
      return;
    }
    // Mesmo par de guardas de loadMessages: silencia a paginação por scroll
    // durante o re-render (o scrollTop baixo pós-salto dispararia
    // loadOlderMessages na hora) e a libera alguns frames depois.
    messagesReady = false;
    loadedMessages = messages.slice();
    hasMoreOlder = !!hasMore;
    // clearRenderedRows + render do zero, e não rerenderLoadedMessages: aquele
    // ancora na primeira linha visível pra PRESERVAR a posição de leitura, que
    // é exatamente o oposto do que um salto quer. Uma resposta em andamento na
    // barra do composer é deixada em paz de propósito - saltar e responder são
    // ações independentes.
    clearRenderedRows();
    loadedMessages.forEach(renderMessage);
    scrollToMessage(id, { smooth: false });
    updateEmptyState();
    updateScrollBtn();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      // Mídia antiga sem width/height salvos reflui depois do primeiro paint e
      // empurra o alvo; re-ancora uma vez com o layout já assentado.
      scrollToMessage(id, { smooth: false });
      updateScrollBtn();
      messagesReady = true;
    }));
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
    return (online || []).filter((n) => n && !sameName(n, myName()));
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

  // ---------------------------------------------------------------------
  // Menu de contexto (Responder / Copiar / Apagar / Ir para a mensagem)
  //
  // Antes cada balão carregava dois botõezinhos fixos embaixo dele - o jeito
  // mais rápido de um chat na web parecer página, não app. Agora as mesmas
  // ações vivem num menuzinho flutuante, aberto pelo gesto nativo de cada
  // plataforma:
  //   - mouse/desktop: clique direito (evento 'contextmenu');
  //   - toque:         toque longo (~480ms).
  // Os dois abrem exatamente o mesmo #msg-menu, a partir de DOIS lugares:
  //   - modo 'chat':  um balão na conversa. O id sai do dataset.id da
  //     .msg-row e o objeto completo vem de loadedMessages. Mostra reações,
  //     Responder, Copiar (só texto) e Apagar.
  //   - modo 'media': um tile da aba Mídia. O id sai do dataset.id do próprio
  //     tile - e é só o id que importa aqui, porque a única ação é Ir para a
  //     mensagem, que não precisa do objeto (a mensagem quase nunca está em
  //     loadedMessages: a grade cobre meses e o chat carrega só as PAGE_SIZE
  //     mais novas).
  // showMenu() é o miolo comum: posiciona e registra os dismissers. Quem abre
  // só decide quais itens aparecem.
  // ---------------------------------------------------------------------
  const LONG_PRESS_MS = 480;
  const LONG_PRESS_MOVE_TOL = 10; // px de folga antes de virar "isso é scroll"

  let activeMenuMsgId = null;
  let activeMenuMode = 'chat';      // 'chat' | 'media'
  let activeMenuScrollEl = null;    // qual scroller fecha o menu ao rolar

  function onMenuKey(e) {
    if (e.key === 'Escape') closeMessageMenu();
  }

  function openMessageMenu(id, at) {
    const m = loadedMessages.find((x) => x.id === id);
    if (!m || m.deleted) return;
    // Re-disparo em cima do mesmo balão (alguns Android disparam 'contextmenu'
    // E o nosso timer de toque longo quase juntos): não reposiciona, ignora.
    if (activeMenuMsgId === id) return;

    // "Copiar" e "Selecionar texto" só fazem sentido em texto.
    const isSelectableText = m.type === 'text' && !!m.text;
    msgMenuCopyBtn.classList.toggle('hidden', !isSelectableText);
    msgMenuSelectBtn.classList.toggle('hidden', !isSelectableText);
    msgMenuGotoBtn.classList.add('hidden');   // já estamos na conversa
    msgMenuReplyBtn.classList.remove('hidden');
    msgMenuDelBtn.classList.remove('hidden');
    msgMenuReactions.classList.remove('hidden');

    // Barra de reação: destaca o emoji com que EU já reagi (se reagi). Fica
    // visível pra qualquer mensagem não apagada - openMessageMenu já saiu
    // acima em m.deleted.
    const myReaction = (m.reactions || []).find((r) => sameName(r.sender, myName()));
    reactionPicks.forEach((b) => {
      b.classList.toggle('is-mine', !!myReaction && b.dataset.emoji === myReaction.emoji);
    });

    showMenu(id, 'chat', at, messagesEl);
  }

  // Menu de um tile da aba Mídia. Por enquanto uma ação só: as outras ou não
  // fazem sentido numa grade (Copiar) ou pedem uma confirmação destrutiva que
  // não combina com o gesto rápido daqui (Apagar).
  function openMediaTileMenu(item, at) {
    if (!item) return;
    if (activeMenuMsgId === item.id) return;

    msgMenuGotoBtn.classList.remove('hidden');
    msgMenuReplyBtn.classList.add('hidden');
    msgMenuCopyBtn.classList.add('hidden');
    msgMenuSelectBtn.classList.add('hidden');
    msgMenuDelBtn.classList.add('hidden');
    msgMenuReactions.classList.add('hidden');

    showMenu(item.id, 'media', at, mediaScroll);
  }

  // Miolo comum aos dois modos: posiciona o cartão dentro da viewport visível
  // e registra os dismissers. scrollEl é o container cuja rolagem fecha o menu
  // (a lista de mensagens ou a grade de mídia).
  function showMenu(id, mode, at, scrollEl) {
    closeMessageMenu();
    activeMenuMsgId = id;
    activeMenuMode = mode;
    activeMenuScrollEl = scrollEl;

    // Mostra antes de medir (offsetWidth/Height só valem com o elemento no
    // fluxo). A leitura de offsetWidth logo abaixo também força um reflow, o
    // que faz a transição de entrada (.is-in) animar de verdade.
    msgMenuBackdrop.classList.remove('hidden');
    msgMenu.classList.remove('hidden');

    const mw = msgMenu.offsetWidth;
    const mh = msgMenu.offsetHeight;
    const vv = window.visualViewport;
    const vw = (vv && vv.width) || window.innerWidth;
    const vh = (vv && vv.height) || window.innerHeight;
    const offX = vv ? vv.offsetLeft : 0;
    const offY = vv ? vv.offsetTop : 0;
    const pad = 8;

    // Ponto de origem: coords do clique (clique direito) ou o topo-esquerdo
    // logo abaixo do balão (toque longo).
    let x = at.point ? at.point.x : at.rect.left;
    let y = at.point ? at.point.y : at.rect.bottom + 4;

    // Estourou embaixo → abre pra cima (acima do balão, se veio de rect).
    if (y + mh + pad > offY + vh) {
      y = at.rect ? at.rect.top - mh - 4 : y - mh;
    }
    // Trava nas bordas da viewport visível (teclado/curva incluídos).
    x = Math.max(offX + pad, Math.min(x, offX + vw - mw - pad));
    y = Math.max(offY + pad, Math.min(y, offY + vh - mh - pad));

    msgMenu.style.left = `${x}px`;
    msgMenu.style.top = `${y}px`;
    msgMenu.classList.add('is-in');

    document.addEventListener('keydown', onMenuKey);
    scrollEl.addEventListener('scroll', closeMessageMenu, { passive: true });
    window.addEventListener('resize', closeMessageMenu);
    if (vv) vv.addEventListener('resize', closeMessageMenu);
  }

  function closeMessageMenu() {
    if (activeMenuMsgId === null) return;
    activeMenuMsgId = null;
    msgMenu.classList.add('hidden');
    msgMenu.classList.remove('is-in');
    msgMenuBackdrop.classList.add('hidden');
    document.removeEventListener('keydown', onMenuKey);
    if (activeMenuScrollEl) activeMenuScrollEl.removeEventListener('scroll', closeMessageMenu);
    activeMenuScrollEl = null;
    window.removeEventListener('resize', closeMessageMenu);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', closeMessageMenu);
  }

  msgMenuBackdrop.addEventListener('click', closeMessageMenu);
  // Um segundo clique direito (agora sobre o backdrop) fecha em vez de reabrir
  // o menu nativo do navegador.
  msgMenuBackdrop.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    closeMessageMenu();
  });
  // Clique direito em cima do próprio menu não abre o menu nativo do browser.
  msgMenu.addEventListener('contextmenu', (e) => e.preventDefault());

  msgMenuGotoBtn.addEventListener('click', () => {
    const id = activeMenuMsgId;
    closeMessageMenu();
    closeMediaPanel();
    if (id) jumpToMessage(id);
  });
  msgMenuReplyBtn.addEventListener('click', () => {
    const m = loadedMessages.find((x) => x.id === activeMenuMsgId);
    closeMessageMenu();
    if (m) setReplyingTo(m);
  });
  // navigator.clipboard só existe em contexto seguro (https, ou http em
  // localhost) - testando pelo IP da rede local (npm run start:lan) a
  // página é http "de verdade" pro browser, então a API some e cai sempre
  // no fallback abaixo. document.execCommand('copy') é obsoleto mas
  // funciona em http comum: seleciona o texto de um textarea fora da tela
  // e pede pro navegador copiar a seleção atual.
  function legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.left = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS ignora .select() sozinho
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (_) { /* segue pro toast de falha */ }
    document.body.removeChild(ta);
    return ok;
  }

  msgMenuCopyBtn.addEventListener('click', () => {
    const m = loadedMessages.find((x) => x.id === activeMenuMsgId);
    closeMessageMenu();
    if (!m || !m.text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(m.text)
        .then(() => toast('Mensagem copiada.'))
        .catch(() => {
          toast(legacyCopy(m.text) ? 'Mensagem copiada.' : 'Não foi possível copiar.');
        });
      return;
    }
    toast(legacyCopy(m.text) ? 'Mensagem copiada.' : 'Cópia não suportada neste navegador.');
  });

  // "Selecionar texto": em toque, o próprio toque longo já é tomado pelo
  // nosso menu (ver a regra @media (pointer: coarse) em .bubble no CSS), e
  // não dá pra "emprestar" pro navegador uma seleção nativa já em
  // andamento - o gesto de arrastar os alças de seleção do sistema só
  // começa a partir de um toque longo cru, sem nosso timer no meio. Por
  // isso este item não seleciona nada sozinho: ele desarma nosso gesto
  // NESSE balão (attachMenuGestures passa a ignorá-lo, ver resolve() logo
  // abaixo) e liga user-select nele via .text-select-armed, então o
  // PRÓXIMO toque longo ali vira um toque longo nativo de verdade.
  let armedBubbleEl = null;
  function disarmSelectableBubble() {
    if (!armedBubbleEl) return;
    armedBubbleEl.classList.remove('text-select-armed');
    armedBubbleEl = null;
    document.removeEventListener('pointerdown', onOutsideArmedPointerdown, true);
    document.removeEventListener('keydown', onArmedKey);
  }
  function onOutsideArmedPointerdown(e) {
    if (armedBubbleEl && !armedBubbleEl.contains(e.target)) disarmSelectableBubble();
  }
  function onArmedKey(e) {
    if (e.key === 'Escape') disarmSelectableBubble();
  }
  msgMenuSelectBtn.addEventListener('click', () => {
    const id = activeMenuMsgId;
    closeMessageMenu();
    disarmSelectableBubble();
    const bubble = id && messagesEl.querySelector(`.msg-row[data-id="${id}"] .bubble`);
    if (!bubble) return;
    armedBubbleEl = bubble;
    bubble.classList.add('text-select-armed');
    document.addEventListener('pointerdown', onOutsideArmedPointerdown, true);
    document.addEventListener('keydown', onArmedKey);
  });

  msgMenuDelBtn.addEventListener('click', () => {
    const id = activeMenuMsgId;
    closeMessageMenu();           // fecha antes: askConfirm assume a tela
    if (id) handleDeleteClick(id);
  });

  reactionPicks.forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = activeMenuMsgId;
      const emoji = btn.dataset.emoji;
      closeMessageMenu();
      if (id) sendReaction(id, emoji);
    });
  });

  // ---- os dois gatilhos ----
  // Clique direito (desktop) e toque longo (~480ms) abrem o mesmo menu. A
  // mecânica é idêntica no chat e na grade de mídia - só muda o que conta como
  // alvo - então mora aqui uma vez só: duplicar as regras de tolerância de
  // movimento, cancelamento e supressão do click fantasma é o caminho mais
  // curto pras duas versões divergirem no primeiro ajuste de iOS.
  //
  // `resolve(e)` devolve { el, id } pro alvo sob o evento, ou null se aquele
  // ponto não é um alvo válido. `open(id, at)` abre o menu do modo certo.
  // Safari no iOS nunca implementou a Vibration API, então navigator.vibrate
  // não faz nada lá - sem feedback tátil nesse caso.
  function triggerHaptic() {
    try {
      if (navigator.vibrate) navigator.vibrate(8);
    } catch (_) { /* ignora - vibrate pode ser bloqueado por permissions policy */ }
  }

  function attachMenuGestures(rootEl, scrollEl, resolve, open) {
    let lpTimer = null;
    let lpStartX = 0;
    let lpStartY = 0;
    let suppressClickUntil = 0;

    function cancelLongPress() {
      if (lpTimer !== null) {
        clearTimeout(lpTimer);
        lpTimer = null;
      }
    }

    rootEl.addEventListener('contextmenu', (e) => {
      const hit = resolve(e);
      if (!hit) return;
      e.preventDefault();
      cancelLongPress();
      open(hit.id, { point: { x: e.clientX, y: e.clientY } });
    });

    // Timer que dispara sozinho se o dedo ficar ~480ms parado sobre o alvo.
    // Cancela em movimento > tolerância, pointerup/cancel e scroll. Ao
    // disparar: vibra de leve, abre o menu ancorado no alvo e "engole" o click
    // sintético seguinte.
    rootEl.addEventListener('pointerdown', (e) => {
      if (e.button && e.button !== 0) return;        // ignora botão direito/meio
      const hit = resolve(e);
      if (!hit) return;
      lpStartX = e.clientX;
      lpStartY = e.clientY;
      cancelLongPress();
      lpTimer = setTimeout(() => {
        lpTimer = null;
        triggerHaptic();
        suppressClickUntil = Date.now() + 700;
        open(hit.id, {
          rect: hit.el.getBoundingClientRect(),
          point: { x: lpStartX, y: lpStartY },
        });
      }, LONG_PRESS_MS);
    }, { passive: true });

    rootEl.addEventListener('pointermove', (e) => {
      if (lpTimer === null) return;
      if (Math.abs(e.clientX - lpStartX) > LONG_PRESS_MOVE_TOL ||
          Math.abs(e.clientY - lpStartY) > LONG_PRESS_MOVE_TOL) {
        cancelLongPress();
      }
    }, { passive: true });

    rootEl.addEventListener('pointerup', cancelLongPress, { passive: true });
    rootEl.addEventListener('pointercancel', cancelLongPress, { passive: true });
    scrollEl.addEventListener('scroll', cancelLongPress, { passive: true });

    // Captura: roda ANTES dos handlers de click do alvo - no chat o img
    // (lightbox), o file-bubble (window.open), o ephemeral
    // (openEphemeralMessage) e o blur-de-fundo em #messages; na grade o
    // openLightbox do tile. Se o click é o fantasma logo depois de um toque
    // longo, mata ele aqui.
    rootEl.addEventListener('click', (e) => {
      if (Date.now() < suppressClickUntil && resolve(e)) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);
  }

  attachMenuGestures(messagesEl, messagesEl, (e) => {
    const bubble = e.target.closest('.bubble');
    if (!bubble || bubble.classList.contains('deleted')) return null;
    // Balão armado por "Selecionar texto": esse toque longo é do navegador,
    // não nosso - ver msgMenuSelectBtn acima.
    if (bubble.classList.contains('text-select-armed')) return null;
    // Controles nativos de áudio/vídeo precisam do gesto pra eles.
    if (e.type === 'pointerdown' && e.target.closest('audio, video')) return null;
    const row = bubble.closest('.msg-row');
    if (!row) return null;
    return { el: bubble, id: row.dataset.id };
  }, openMessageMenu);

  attachMenuGestures(mediaGrid, mediaScroll, (e) => {
    const tile = e.target.closest('.media-tile');
    return tile ? { el: tile, id: tile.dataset.id } : null;
  }, (id, at) => openMediaTileMenu(mediaItems.find((it) => it.id === id), at));

  // Secret "você me ama?" counter. Typing (and sending) a variant of that
  // question doesn't post a real message - it's intercepted client-side
  // and instead reveals, only to whoever typed it, how many times each
  // person has said some variant of "eu te amo", EVER (a lifetime tally,
  // not just what's currently on screen). Purely local: never touches the
  // server, never shows up in export or on the other person's screen
  // unless they trigger it too.
  //
  // Persisted in localStorage (LOVE_STATS_KEY) rather than recomputed live
  // from messageLog like it originally was - the live version looked
  // correct but silently reset to zero every time the underlying messages
  // went away (deleting a single "eu te amo" message, or "Limpar
  // conversa" wiping the whole history), because it was just re-counting
  // whatever text messages happened to still be rendered. countedIds
  // remembers which message ids already contributed to the tally so the
  // same message is never double-counted across page reloads (every
  // reload re-renders full history from the server) while still letting
  // the count survive that message being deleted later.
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

  const LOVE_STATS_KEY = 'private-chat:love-stats';
  function loadLoveStats() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LOVE_STATS_KEY) || 'null');
      return {
        counts: (parsed && typeof parsed.counts === 'object' && parsed.counts) || {},
        countedIds: (parsed && typeof parsed.countedIds === 'object' && parsed.countedIds) || {},
      };
    } catch {
      return { counts: {}, countedIds: {} };
    }
  }
  const loveStats = loadLoveStats();
  function saveLoveStats() {
    try {
      localStorage.setItem(LOVE_STATS_KEY, JSON.stringify(loveStats));
    } catch {
      // Best-effort only (private/full storage) - the in-memory tally for
      // this page load still works, it just won't survive a reload.
    }
  }

  // Called once per rendered text message (see renderMessage) - counts it
  // into the lifetime tally the first time this exact message id is ever
  // seen, then never again, so later deleting that message (individually
  // or via "Limpar conversa") can't make the tally go back down.
  function recordLoveMessageIfNeeded(id, sender, text) {
    if (!text || loveStats.countedIds[id]) return;
    const n = normalizeLoveText(text);
    if (!LOVE_PHRASES.some((phrase) => n.includes(phrase))) return;
    loveStats.countedIds[id] = true;
    loveStats.counts[sender] = (loveStats.counts[sender] || 0) + 1;
    saveLoveStats();
  }

  function countLoveMessages() {
    return new Map(Object.entries(loveStats.counts));
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

  // Só limpa o DOM das mensagens e o estado forward-only de renderização
  // (agrupamento, divisórias de data). NÃO mexe em loadedMessages nem na barra
  // de resposta - é o que rerenderLoadedMessages usa antes de redesenhar a
  // lista inteira a partir de loadedMessages.
  function clearRenderedRows() {
    messagesEl.querySelectorAll('.msg-row, .date-divider').forEach((el) => el.remove());
    renderedIds = new Set();
    lastRow = null;
    lastSender = null;
    lastTs = null;
    lastDateKey = null;
  }

  function resetMessagesView() {
    clearRenderedRows();
    loadedMessages = [];
    hasMoreOlder = false;
    clearReplyingTo();
    closeMessageMenu();
    updateEmptyState();
    updateScrollBtn();
  }

  const NAME_KEY = 'private-chat:my-name';
  nameInput.value = localStorage.getItem(NAME_KEY) || '';
  // Trocar de nome muda a identidade do lado do cliente, e a identidade é o
  // que decide de que lado cada bolha fica (ver `mine` em renderMessage), então
  // renomear tem que redesenhar a lista - senão as bolhas antigas ficariam do
  // lado errado até o próximo carregamento.
  nameInput.addEventListener('change', () => {
    const name = nameInput.value.trim();
    const previous = localStorage.getItem(NAME_KEY) || '';
    localStorage.setItem(NAME_KEY, name);
    if (name !== previous) rerenderLoadedMessages();
  });

  let renderedIds = new Set();
  let es = null;

  // Paginação "mais recentes primeiro": na abertura só as PAGE_SIZE mensagens
  // mais novas descem do servidor; lotes anteriores são buscados conforme a
  // pessoa rola pra cima (loadOlderMessages). loadedMessages é a lista
  // autoritativa em ordem ascendente do que já foi carregado - ao paginar pra
  // trás re-renderizamos tudo a partir dela (o agrupamento/data-divider é um
  // passo forward-only, prepender no DOM quebraria o estado). Mensagens novas
  // continuam só dando append normal, sem re-render.
  const PAGE_SIZE = 50;
  let loadedMessages = [];
  let hasMoreOlder = false;
  let loadingOlder = false;
  // Fica false durante a janela barulhenta da carga inicial (render + scroll
  // pra base + imagens assentando) pra não disparar paginação pra trás sem a
  // pessoa ter rolado. Volta a true poucos frames depois.
  let messagesReady = false;

  // Tracks the previously-rendered row/sender/time so consecutive messages
  // from the same author can be visually grouped (tighter spacing, avatar/
  // name shown once) instead of
  // each rendering as a fully separate message like before. lastTs also
  // gates grouping on a time gap (see renderMessage) and lastDateKey drives
  // the day-divider rows.
  let lastRow = null;
  let lastSender = null;
  let lastTs = null;
  let lastDateKey = null;

  // Consecutive messages from the same sender stop being visually grouped
  // once more than this much time has passed between them, even though they're
  // still the same sender on the same side - matches how WhatsApp breaks a run
  // after a gap instead of grouping messages sent hours apart under one shared
  // timestamp.
  const GROUP_GAP_MS = 5 * 60 * 1000;

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

  // A pessoa pode digitar o nome com capitalização diferente entre
  // sessões/dispositivos ("Ana" num, "ana" noutro) - a comparação de
  // identidade precisa ignorar isso.
  function sameName(a, b) {
    return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  async function handleDeleteClick(id) {
    if (!myName()) {
      focusNameInput();
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
    // Card entra ACIMA do texto, estilo WhatsApp (ver buildBubbleContent).
    const textEl = bubble.querySelector('.bubble-text');
    bubble.insertBefore(buildLinkPreviewCard(linkPreview), textEl);
    if (wasNearBottom) scrollToBottom();
  }

  // ---------------------------------------------------------------------
  // Reações (❤️ 👍 😂 😮 😢 🔥)
  //
  // Uma reação por pessoa por mensagem, com toggle: reagir com o mesmo
  // emoji remove, com outro troca. A escolha sai da barra no topo do
  // #msg-menu ou de um toque no próprio chip embaixo do balão. A UI
  // atualiza pelo SSE "message-reacted" (igual a apagar/enviar), não pela
  // resposta do fetch. A identidade é myName(), o mesmo critério de lado
  // da bolha e do requesterName usado em apagar/visualização única.
  // ---------------------------------------------------------------------
  async function sendReaction(id, emoji) {
    if (!REACTION_EMOJIS.includes(emoji)) return;
    if (!myName()) {
      focusNameInput();
      return;
    }
    try {
      const res = await fetch(api(`/api/messages/${id}/react`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesterName: myName(), emoji }),
      });
      if (!res.ok) toast('Não foi possível reagir a essa mensagem.');
    } catch (err) {
      // hiccup de rede — a reação simplesmente não vai
    }
  }

  // Agrega o array m.reactions ([{ sender, emoji, ts }]) por emoji,
  // preservando a ordem da 1ª aparição, e devolve o <div.msg-reactions>
  // com um chip por emoji. Tocar um chip alterna aquela reação (re-toque
  // no meu próprio emoji remove, igual ao WhatsApp).
  function buildReactions(m) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-reactions';
    const order = [];
    const byEmoji = new Map();
    for (const r of m.reactions || []) {
      if (!byEmoji.has(r.emoji)) {
        byEmoji.set(r.emoji, { count: 0, mine: false });
        order.push(r.emoji);
      }
      const agg = byEmoji.get(r.emoji);
      agg.count += 1;
      if (sameName(r.sender, myName())) agg.mine = true;
    }
    for (const emoji of order) {
      const agg = byEmoji.get(emoji);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `reaction-chip${agg.mine ? ' mine' : ''}`;
      chip.textContent = emoji;
      if (agg.count > 1) {
        const count = document.createElement('span');
        count.className = 'reaction-count';
        count.textContent = agg.count;
        chip.appendChild(count);
      }
      chip.addEventListener('click', () => sendReaction(m.id, emoji));
      wrap.appendChild(chip);
    }
    return wrap;
  }

  // Alguém reagiu (ou desfez) enquanto a bolha já estava na tela (SSE
  // "message-reacted"): troca o <div.msg-reactions> em vez de re-renderizar
  // a mensagem inteira. Mesma ideia de applyLinkPreview.
  function applyReactions(id, reactions) {
    const row = messagesEl.querySelector(`[data-id="${id}"]`);
    if (!row) return;
    const body = row.querySelector('.msg-body');
    if (!body) return;
    const existing = body.querySelector('.msg-reactions');
    if (existing) existing.remove();
    if (reactions && reactions.length) {
      const wasNearBottom = isNearBottom();
      const m = loadedMessages.find((x) => x.id === id) || { id, reactions };
      body.appendChild(buildReactions({ ...m, reactions }));
      if (wasNearBottom) scrollToBottom();
    }
  }

  function buildBubbleContent(bubble, m) {
    if (m.type === 'text') {
      // Card de preview ACIMA do texto (estilo WhatsApp). Já vem resolvido
      // no histórico (ver /api/messages); um preview ainda em voo chega
      // depois pelo SSE "message-updated" (applyLinkPreview).
      if (m.linkPreview) {
        bubble.appendChild(buildLinkPreviewCard(m.linkPreview));
      }
      // append (not bubble.textContent=) so we don't wipe out a reply-quote
      // block that may already have been appended before this call.
      const textEl = document.createElement('span');
      textEl.className = 'bubble-text';
      linkify(textEl, m.text);
      bubble.appendChild(textEl);
      // A hora é absoluta no canto do balão (ver .msg-time); a ordem no DOM
      // não muda onde ela aparece, mas deixamos por último por clareza.
      bubble.appendChild(makeTimeEl(m.ts));
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
      // see readMediaMeta, captured client-side before upload.
      if (m.width && m.height) {
        img.width = m.width;
        img.height = m.height;
        // Belt-and-suspenders alongside the width/height attributes above:
        // an explicit aspect-ratio doesn't depend on the browser's own
        // attribute->aspect-ratio UA-stylesheet mapping, which is a newer,
        // lower-priority mechanism that's more prone to timing differences
        // between an early layout pass and the one after the file decodes.
        // Must stay paired with width:auto;height:auto in .bubble img (style
        // .css) - forcing explicit width/height there instead would squash
        // the image, see that rule's own comment.
        img.style.aspectRatio = `${m.width} / ${m.height}`;
        // None of the above actually reserves space by itself: .bubble has
        // no width of its own (it hugs its content), and a replaced element
        // sized only via aspect-ratio contributes ~0 to that shrink-to-fit
        // measurement until naturalWidth/naturalHeight are known - a real
        // Chromium/WebKit gap, confirmed by instrumenting a real page load.
        // The whole bubble collapses to just its padding for the window
        // between "message rendered" and "enough bytes downloaded to read
        // the image header", which is exactly the "loads tiny then pops to
        // size" bug this is fixing. reserveMediaBox sets an explicit pixel
        // width/height up front (same contain math the browser applies
        // post-load) so the ancestor's fit-content pass always has a
        // definite number to work with, load state or not.
        reserveMediaBox(img, m.width, m.height);
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
      // Sem poster, o balão fica em branco até o navegador conseguir os
      // metadados do vídeo - e como /api/media não tem suporte a Range,
      // "metadados" pode significar baixar o arquivo inteiro (1-12MB) antes
      // de mostrar qualquer coisa. m.thumbId já existe (mesma miniatura da
      // aba Mídia, ~20-60KB) e resolve isso na hora. Vídeo antigo sem
      // thumbId cai de volta no comportamento de sempre.
      if (m.thumbId) {
        vid.poster = api(`/api/media/${m.thumbId}`);
      }
      if (m.width && m.height) {
        vid.width = m.width;
        vid.height = m.height;
        // See the matching comments in the image branch above.
        vid.style.aspectRatio = `${m.width} / ${m.height}`;
        reserveMediaBox(vid, m.width, m.height);
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
      recordLoveMessageIfNeeded(m.id, m.sender, m.text);
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
    // Lado da bolha = quem está olhando a tela, como em qualquer mensageiro:
    // o que EU mandei vai pra direita, o resto pra esquerda. A identidade é o
    // nome de exibição comparado sem diferenciar maiúsculas/minúsculas
    // (sameName), o mesmo critério que o servidor usa pra "visualização
    // única" (server.js) e que a presença usa em otherPeopleOnline - uma
    // noção só de identidade no app inteiro. Por isso myName() não pode
    // estar vazio: showChat() exige o nome antes de renderizar qualquer
    // mensagem, e renomear re-renderiza a lista.
    const mine = sameName(m.sender, myName());
    // Same author as the message right before this one, sent within the
    // grouping window → render as part of the same visual group instead of
    // a brand-new block.
    const grouped = sameName(lastSender, m.sender) && lastTs !== null && (m.ts - lastTs) < GROUP_GAP_MS;

    const row = document.createElement('div');
    row.className = `msg-row ${mine ? 'me' : 'them'}${grouped ? ' grouped' : ''}${animate ? ' msg-enter' : ''}`;
    row.dataset.id = m.id;

    // Esta mensagem se agrupa com a anterior → a bolha de cima deixa de ser a
    // última do grupo e perde o canto "apontado" (ver .has-follower no CSS).
    if (grouped && lastRow) lastRow.classList.add('has-follower');

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
      // Escrito por extenso, e não reaproveitando o `mine` acima, de
      // propósito: hoje as duas expressões são a mesma coisa, mas `mine` é o
      // lado VISUAL da bolha e isto aqui é uma permissão. Se o critério de
      // lado mudar de novo, quem pode abrir mídia de visualização única tem
      // que continuar preso à identidade real - sameName(m.sender, myName())
      // - ou alguém veria a própria foto enviada como um "toque para ver"
      // clicável e levaria um 403 sem explicação do servidor, que já recusa
      // isso (ver server.js).
      buildEphemeralLockedContent(bubble, m, sameName(m.sender, myName()));
    } else {
      if (m.replyTo) {
        const quote = document.createElement('div');
        quote.className = 'reply-quote';
        quote.style.borderColor = nameColor(m.replyTo.sender);
        if (m.replyTo.thumbId) {
          const qThumb = document.createElement('img');
          qThumb.className = 'reply-quote-thumb';
          qThumb.alt = '';
          // Diferente do IntersectionObserver da aba Mídia: aqui toda
          // mensagem carregada renderiza a citação de cara, então o
          // loading="lazy" nativo evita uma rajada de /api/media num
          // histórico longo (jumpToMessage, rerenderLoadedMessages).
          qThumb.loading = 'lazy';
          qThumb.src = api(`/api/media/${m.replyTo.thumbId}`);
          // Mídia original apagada depois da resposta -> 404 silencioso,
          // só some a miniatura.
          qThumb.addEventListener('error', () => qThumb.remove());
          quote.appendChild(qThumb);
        }
        const qText = document.createElement('div');
        qText.className = 'reply-quote-text';
        const qSender = document.createElement('div');
        qSender.className = 'reply-quote-sender';
        qSender.style.color = nameColor(m.replyTo.sender);
        qSender.textContent = m.replyTo.sender;
        const qSnippet = document.createElement('div');
        qSnippet.className = 'reply-quote-snippet';
        qSnippet.textContent = m.replyTo.snippet;
        qText.appendChild(qSender);
        qText.appendChild(qSnippet);
        quote.appendChild(qText);
        // jumpToMessage e não scrollToMessage: antes, clicar numa citação de
        // mensagem fora do lote carregado só dava o toast de "nao esta mais
        // visivel". Com o ?from= no lugar, o salto funciona de verdade.
        quote.addEventListener('click', () => jumpToMessage(m.replyTo.id));
        bubble.appendChild(quote);
      }
      buildBubbleContent(bubble, m);
    }
    body.appendChild(bubble);

    // Chips de reação colados embaixo do balão (fora do .bubble, no
    // .msg-body - não mexem no .msg-time). rerenderLoadedMessages redesenha
    // por aqui, então nada se perde ao paginar pra trás / trocar de nome.
    if (!m.deleted && m.reactions && m.reactions.length) {
      body.appendChild(buildReactions(m));
    }

    // As ações da mensagem (Responder / Copiar / Apagar) não vivem mais como
    // botões fixos embaixo do balão - agora saem no #msg-menu, aberto por
    // clique direito (desktop) ou toque longo (touch). Ver a seção "menu de
    // contexto da mensagem" mais acima.

    line.appendChild(body);
    row.appendChild(line);

    // Cada mensagem carrega o seu próprio horário (HH:mm), mesmo dentro de um
    // grupo de mensagens seguidas do mesmo remetente - antes só a última do
    // grupo mantinha o timestamp visível.

    messagesEl.appendChild(row);
    lastRow = row;
    lastSender = m.sender;
    lastTs = m.ts;
    updateEmptyState();
  }

  function applyDeletedPlaceholder(id, expiredEphemeral, deletedBy) {
    const row = messagesEl.querySelector(`[data-id="${id}"]`);
    if (!row) return;
    // Se o menu de contexto estava aberto pra esta mensagem quando a exclusão
    // chegou pelo SSE, fecha - não faz sentido "Responder/Copiar/Apagar" um
    // balão que virou "mensagem apagada".
    if (activeMenuMsgId === id) closeMessageMenu();
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

  // ---- aba de mídia ----
  //
  // Grade de todas as fotos e vídeos da conversa. A regra que define o
  // desenho todo: a grade baixa SÓ miniaturas (~30KB), e só das que estão
  // perto da tela; o arquivo original (1-12MB) só é buscado no clique, no
  // lightbox. Sem isso, abrir a aba com 40 fotos baixaria centenas de MB.
  //
  // O painel é estado em memória, nunca URL - o api() no topo do arquivo
  // deriva o caminho da sala de location.pathname, então mexer na URL
  // quebraria todos os requests da página.

  const MEDIA_PAGE_SIZE = 120;

  let mediaItems = [];          // tudo que já foi carregado, mais novo → mais antigo
  let mediaCursor = null;       // id da última mensagem do lote (paginação)
  let mediaHasMore = true;
  let mediaLoadingPage = false;
  let mediaLoadedOnce = false;
  let mediaLastMonthKey = null; // pra não repetir o cabeçalho do mês
  let thumbObserver = null;
  let mediaPageObserver = null;

  function isMediaPanelOpen() {
    return !mediaPanel.classList.contains('hidden');
  }

  // Carrega a miniatura só quando o tile chega perto da tela. rootMargin
  // generoso (600px) pra imagem já estar pronta quando a pessoa rola até
  // ela, em vez de aparecer um quadrado cinza que preenche depois.
  function ensureThumbObserver() {
    if (thumbObserver) return thumbObserver;
    thumbObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        thumbObserver.unobserve(img); // uma vez só: já tem src, acabou
        if (img.dataset.src) {
          img.src = img.dataset.src;
          delete img.dataset.src;
        }
      }
    }, { root: mediaScroll, rootMargin: '600px 0px' });
    return thumbObserver;
  }

  function ensureMediaPageObserver() {
    if (mediaPageObserver) return mediaPageObserver;
    mediaPageObserver = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMediaPage();
    }, { root: mediaScroll, rootMargin: '400px 0px' });
    mediaPageObserver.observe(mediaSentinel);
    return mediaPageObserver;
  }

  function monthKeyOf(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}`;
  }

  function monthLabelOf(ts) {
    return new Date(ts).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  }

  const VIDEO_BADGE_SVG =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5L8 5.5Z"/></svg>';

  // Mostrado no lugar da miniatura pro vídeo antigo, que não tem uma e
  // não pode ganhar sem baixar o arquivo inteiro.
  const VIDEO_PLACEHOLDER_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="M16 10.5 21 7.5v9L16 13.5"/></svg>';

  function buildMediaTile(item) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'media-tile';
    tile.dataset.id = item.id;
    // O tile é sempre quadrado (aspect-ratio no CSS) e a imagem é cortada
    // com object-fit: cover. Respeitar a proporção de cada mídia deixaria
    // as linhas irregulares - uma foto 4:3 do lado de um vídeo 16:9 - e é
    // por isso que toda galeria de verdade usa quadrado. Como o tamanho
    // não depende do arquivo, a grade também já nasce no lugar certo e
    // nunca reflui conforme as miniaturas chegam.

    // O que o tile carrega, em ordem de preferência:
    //   1. tem thumbId          -> a miniatura (~30KB). O caso normal.
    //   2. foto sem thumbId     -> o original. Pesado, mas renderiza, e é
    //      justamente o que alimenta o retrofit logo abaixo.
    //   3. vídeo sem thumbId    -> NADA. Um <img> apontando pra um .mp4
    //      baixa o arquivo inteiro (5MB medidos) e depois falha ao
    //      decodificar, mostrando um quadrado vazio - o desperdício exato
    //      que essa aba existe pra evitar. Fica só o placeholder com o
    //      ícone de vídeo; quem quiser ver, clica e abre no lightbox.
    const canPreview = item.thumbId || item.type === 'image';

    if (canPreview) {
      const img = document.createElement('img');
      img.decoding = 'async';
      img.alt = item.filename || (item.type === 'video' ? 'Vídeo' : 'Foto');
      // SEM src aqui: quem define é o IntersectionObserver, quando o tile
      // chega perto da tela.
      img.dataset.src = api(`/api/media/${item.thumbId || item.mediaId}`);
      img.addEventListener('load', () => {
        img.classList.add('is-loaded');
        if (!item.thumbId) queueThumbBackfill(item, img);
      });
      tile.appendChild(img);
      ensureThumbObserver().observe(img);
    } else {
      const ph = document.createElement('span');
      ph.className = 'media-tile-placeholder';
      ph.innerHTML = VIDEO_PLACEHOLDER_SVG;
      tile.appendChild(ph);
    }

    if (item.type === 'video') {
      const badge = document.createElement('span');
      badge.className = 'media-tile-badge';
      badge.innerHTML = VIDEO_BADGE_SVG;
      tile.appendChild(badge);
    }

    // O ÚNICO ponto em que o arquivo cheio é baixado.
    tile.addEventListener('click', () => {
      openLightbox(item.type === 'video' ? 'video' : 'image', api(`/api/media/${item.mediaId}`));
    });

    return tile;
  }

  // Retrofit da mídia antiga: o tile carregou o original, então a imagem
  // já está decodificada aqui no cliente - desenha no canvas e manda a
  // miniatura pro servidor guardar. Uma por vez, pra não competir com o
  // resto da grade por conexão, e silencioso: se falhar, o tile só
  // continua no caminho pesado na próxima abertura.
  const thumbBackfillQueue = [];
  let thumbBackfillRunning = false;

  function queueThumbBackfill(item, img) {
    if (item.thumbId || item.type !== 'image') return; // vídeo: ver nota abaixo
    thumbBackfillQueue.push({ item, img });
    runThumbBackfill();
  }

  async function runThumbBackfill() {
    if (thumbBackfillRunning) return;
    thumbBackfillRunning = true;
    try {
      while (thumbBackfillQueue.length) {
        const { item, img } = thumbBackfillQueue.shift();
        try {
          const w = img.naturalWidth;
          const h = img.naturalHeight;
          if (!w || !h) continue;
          const blob = await drawThumb(img, w, h);
          if (!blob) continue;
          const form = new FormData();
          form.append('thumb', blob, 'thumb.jpg');
          const res = await fetch(api(`/api/media/${item.mediaId}/thumb`), {
            method: 'POST',
            body: form,
          });
          if (!res.ok) continue;
          const out = await res.json();
          if (out && out.thumbId) item.thumbId = out.thumbId;
        } catch (e) {
          // silencioso de propósito - é otimização, não funcionalidade
        }
      }
    } finally {
      thumbBackfillRunning = false;
    }
  }
  // Nota: vídeo antigo não entra no retrofit. Pegar um frame exigiria
  // baixar o arquivo inteiro num <video> escondido só pra isso, e sem
  // suporte a Range no servidor seriam megabytes por tile - o oposto do
  // objetivo. Vídeo enviado a partir de agora já sobe com miniatura.

  function appendMediaItems(items) {
    const frag = document.createDocumentFragment();
    for (const item of items) {
      const key = monthKeyOf(item.ts);
      if (key !== mediaLastMonthKey) {
        mediaLastMonthKey = key;
        const head = document.createElement('div');
        head.className = 'media-month';
        head.dataset.key = key;
        head.textContent = monthLabelOf(item.ts);
        frag.appendChild(head);
      }
      frag.appendChild(buildMediaTile(item));
    }
    mediaGrid.appendChild(frag);
  }

  function updateMediaCount() {
    mediaCount.textContent = mediaItems.length
      ? `${mediaItems.length}${mediaHasMore ? '+' : ''}`
      : '';
    mediaEmpty.classList.toggle('hidden', mediaItems.length > 0 || mediaLoadingPage || !mediaLoadedOnce);
  }

  async function loadMediaPage() {
    if (mediaLoadingPage || !mediaHasMore) return;
    mediaLoadingPage = true;
    mediaLoading.classList.remove('hidden');
    try {
      const qs = `limit=${MEDIA_PAGE_SIZE}${mediaCursor ? `&before=${encodeURIComponent(mediaCursor)}` : ''}`;
      const res = await fetch(api(`/api/media-list?${qs}`));
      if (!res.ok) throw new Error('media list failed');
      const data = await res.json();
      const items = data.items || [];
      mediaHasMore = !!data.hasMore;
      if (items.length) {
        mediaCursor = items[items.length - 1].id;
        mediaItems = mediaItems.concat(items);
        appendMediaItems(items);
      }
      mediaLoadedOnce = true;
    } catch (e) {
      mediaHasMore = false;
      mediaLoadedOnce = true;
    } finally {
      mediaLoadingPage = false;
      mediaLoading.classList.add('hidden');
      updateMediaCount();
    }
    // A primeira página pode não encher a tela (ou pode ter vindo vazia
    // porque o lote só tinha texto): se o sentinela ainda está visível,
    // o observer não dispara de novo sozinho, então puxa a próxima aqui.
    if (mediaHasMore && !mediaLoadingPage && isMediaPanelOpen()
        && mediaScroll.scrollHeight <= mediaScroll.clientHeight) {
      loadMediaPage();
    }
  }

  function resetMediaPanel() {
    if (activeMenuMode === 'media') closeMessageMenu();
    mediaGrid.innerHTML = '';
    mediaItems = [];
    mediaCursor = null;
    mediaHasMore = true;
    mediaLoadedOnce = false;
    mediaLastMonthKey = null;
    thumbBackfillQueue.length = 0;
    updateMediaCount();
    // Se a aba estava aberta na hora (conversa limpa pela outra pessoa),
    // recarrega na hora - senão ficaria uma grade vazia sem nem o aviso de
    // "nenhuma foto ainda", esperando um fechar/abrir pra se resolver.
    if (isMediaPanelOpen()) loadMediaPage();
  }

  function openMediaPanel() {
    mediaPanel.classList.remove('hidden');
    ensureMediaPageObserver();
    // A grade fica montada entre aberturas de propósito: /api/media
    // responde com no-store, então destruir e recriar os <img> significaria
    // rebaixar todas as miniaturas toda vez que a aba fosse reaberta.
    if (!mediaLoadedOnce) loadMediaPage();
  }

  function closeMediaPanel() {
    mediaPanel.classList.add('hidden');
  }

  mediaBtn.addEventListener('click', openMediaPanel);
  mediaBack.addEventListener('click', closeMediaPanel);

  // Escape fecha o de cima primeiro: menu de contexto, lightbox, painel. O
  // menu já se fecha sozinho pelo onMenuKey dele; o early-return aqui é pra
  // esse Escape não fechar o painel JUNTO, no mesmo toque.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (activeMenuMsgId !== null) return;
    if (cameraMenuCtl.isOpen() || plusMenuCtl.isOpen()) return;
    if (!lightbox.classList.contains('hidden')) {
      lightbox.classList.add('hidden');
    } else if (isMediaPanelOpen()) {
      closeMediaPanel();
    }
  });

  // Mídia nova chegando pelo SSE entra no topo da grade (que é a posição
  // mais recente), sem refazer a página inteira.
  function addMediaItemToTop(m) {
    if (!mediaLoadedOnce) return; // ainda não carregou nada; vai vir na 1ª página
    if (m.type !== 'image' && m.type !== 'video') return;
    if (m.ephemeral || m.deleted || !m.mediaId) return;
    if (mediaItems.some((it) => it.id === m.id)) return;

    const item = {
      id: m.id, type: m.type, mediaId: m.mediaId, thumbId: m.thumbId,
      width: m.width, height: m.height, sender: m.sender, ts: m.ts,
      filename: m.filename,
    };
    mediaItems.unshift(item);

    const tile = buildMediaTile(item);
    const key = monthKeyOf(item.ts);
    const firstHead = mediaGrid.querySelector('.media-month');
    // Mês diferente do primeiro cabeçalho (ou grade vazia) → cabeçalho novo
    // na frente. Mesmo mês → o tile só entra depois do cabeçalho que já existe.
    if (!firstHead || firstHead.dataset.key !== key) {
      const head = document.createElement('div');
      head.className = 'media-month';
      head.dataset.key = key;
      head.textContent = monthLabelOf(item.ts);
      mediaGrid.prepend(tile);
      mediaGrid.prepend(head);
      if (!firstHead) mediaLastMonthKey = key;
    } else {
      firstHead.after(tile);
    }
    updateMediaCount();
  }

  function removeMediaItem(id) {
    const i = mediaItems.findIndex((it) => it.id === id);
    if (i === -1) return;
    // Menu aberto em cima do tile que a outra pessoa acabou de apagar: fecha
    // antes de tirar o tile do DOM (mesma guarda de applyDeletedPlaceholder).
    if (activeMenuMsgId === id) closeMessageMenu();
    mediaItems.splice(i, 1);
    const tile = mediaGrid.querySelector(`.media-tile[data-id="${id}"]`);
    if (tile) tile.remove();
    updateMediaCount();
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Media (img/video/audio) inside newly rendered bubbles loads asynchronously,
  // so the container's real height isn't known right after the synchronous
  // render. Nudge the scroll position down again as things settle so we
  // reliably land on the very last message instead of stopping wherever the
  // layout happened to be at that instant.
  // opts.pin: cola a base de forma mais teimosa por ~0,8s (ou até a pessoa
  // tocar/rolar), ignorando o isNearBottom(). Usado só na carga inicial - aí
  // a pessoa quer a última mensagem, e mídia antiga sem width/height salvos
  // reflui depois do render e empurra a base pra longe justo quando o
  // isNearBottom() passa a dar false, deixando a abertura "quase no fim".
  function scrollToBottomWhenReady(opts) {
    const pin = !!(opts && opts.pin);
    scrollToBottom();
    requestAnimationFrame(() => {
      scrollToBottom();
      requestAnimationFrame(scrollToBottom);
    });
    if (pin) {
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
        messagesEl.removeEventListener('wheel', cancel);
        messagesEl.removeEventListener('touchstart', cancel);
        messagesEl.removeEventListener('keydown', cancel);
      };
      messagesEl.addEventListener('wheel', cancel, { once: true, passive: true });
      messagesEl.addEventListener('touchstart', cancel, { once: true, passive: true });
      messagesEl.addEventListener('keydown', cancel, { once: true });
      const start = Date.now();
      const tick = () => {
        if (cancelled) return;
        scrollToBottom();
        if (Date.now() - start < 800) setTimeout(tick, 55);
        else cancel();
      };
      setTimeout(tick, 55);
    }
    // Media that already has width/height reserved (see readMediaMeta/
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
  // Rolou pra cima, perto do topo, e ainda há histórico → puxa o lote anterior.
  // Só depois que a carga inicial assentou (messagesReady) e desde que a pessoa
  // NÃO esteja colada na base - a abertura sempre termina colada na base, e a
  // reflow do spinner/imagens durante o primeiro paint não deve disparar isso.
  messagesEl.addEventListener('scroll', () => {
    if (!messagesReady || loadingOlder || !hasMoreOlder) return;
    if (isNearBottom()) return;
    if (messagesEl.scrollTop < 300) loadOlderMessages();
  });
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
    updateMediaMaxWidth();
    requestAnimationFrame(() => {
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
      if (stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  // Percentage max-width on .bubble img/.bubble-media-wrap can't resolve
  // reliably (the ancestor chain down to .msg-body never has a definite
  // width of its own - see the comment above .bubble img in style.css).
  // Mirror .msg-row's own 78% cap (style.css ~line 386) as an absolute px
  // value instead, kept live via --media-max-w so every bubble picks it up
  // automatically, including ones already rendered.
  function updateMediaMaxWidth() {
    const cs = getComputedStyle(messagesEl);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const rowW = (messagesEl.clientWidth - padL - padR) * 0.78; // keep in sync with .msg-row's max-width:78%
    // Just avatar(26)+.msg-line gap(8), shared conservatively for both sides -
    // NOT .bubble's own padding too: media bubbles render edge-to-edge now
    // (see .bubble-media-wrap in style.css), so there's no padding of theirs
    // left to reserve room for.
    const reserve = 34;
    const maxW = Math.max(120, Math.floor(rowW - reserve));
    messagesEl.style.setProperty('--media-max-w', `${maxW}px`);
    // reserveMediaBox's placeholder box (see its own comment) was computed
    // against whatever --media-max-w was at render time - refresh it for
    // anything still waiting on its real size, so a keyboard open/close
    // mid-download doesn't leave the placeholder sized for the old
    // viewport. Loaded media doesn't need this: it's already back to plain
    // CSS sizing, which already tracks --media-max-w live on its own.
    messagesEl.querySelectorAll('.bubble img, .bubble video').forEach((el) => {
      const loaded = el.tagName === 'IMG' ? el.complete : el.readyState >= 1;
      if (loaded) return;
      const w = parseInt(el.getAttribute('width'), 10);
      const h = parseInt(el.getAttribute('height'), 10);
      if (w && h) reserveMediaBox(el, w, h);
    });
  }

  const MEDIA_MAX_H = 320; // keep in sync with .bubble img/video's max-height in style.css

  // See the call sites in buildBubbleContent for why this exists: .bubble
  // has no width of its own (it hugs its content), and a replaced element
  // sized only via CSS aspect-ratio contributes ~0 to that shrink-to-fit
  // measurement until the browser actually knows the file's real
  // dimensions - so without this, the whole bubble collapses to just its
  // padding until the image/video has downloaded enough to report a
  // natural size. Sets an explicit width/height up front, using the exact
  // same contain-within-max-width/max-height math the browser itself
  // applies once loaded (mirrors CSS2.1 10.4's replaced-element sizing:
  // clamp to max-width first, then re-clamp to max-height from there),
  // so there's never a mismatch to visibly snap into once it does.
  // Released back to width:auto/height:auto (+ aspect-ratio, + the real
  // natural size the browser now has) the moment the file actually loads,
  // so live resizing via --media-max-w keeps working exactly as before
  // this existed.
  function reserveMediaBox(el, width, height) {
    const cs = getComputedStyle(messagesEl);
    const maxW = parseFloat(cs.getPropertyValue('--media-max-w')) || 260;
    let w = width;
    let h = height;
    if (w > maxW) { h = h * (maxW / w); w = maxW; }
    if (h > MEDIA_MAX_H) { w = w * (MEDIA_MAX_H / h); h = MEDIA_MAX_H; }
    el.style.width = `${Math.round(w)}px`;
    el.style.height = `${Math.round(h)}px`;
    const release = () => { el.style.width = ''; el.style.height = ''; };
    el.addEventListener(el.tagName === 'VIDEO' ? 'loadedmetadata' : 'load', release, { once: true });
    el.addEventListener('error', release, { once: true });
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
    messagesReady = false;
    loadingState.classList.remove('hidden');
    emptyState.classList.add('hidden');
    try {
      const res = await fetch(api(`/api/messages?limit=${PAGE_SIZE}`));
      if (!res.ok) return;
      const { messages, hasMore } = await res.json();
      resetMessagesView();
      loadedMessages = messages.slice();
      hasMoreOlder = !!hasMore;
      messages.forEach(renderMessage);
      scrollToBottomWhenReady({ pin: true });
      updateScrollBtn();
      // Libera a paginação por scroll só depois que o layout inicial assentou.
      requestAnimationFrame(() => requestAnimationFrame(() => { messagesReady = true; }));
    } finally {
      loadingState.classList.add('hidden');
      updateEmptyState();
    }
  }

  // Primeira .msg-row pelo menos parcialmente visível - a âncora usada pra
  // manter a posição de leitura estável quando a lista é re-renderizada.
  function firstVisibleRow() {
    const top = messagesEl.getBoundingClientRect().top;
    const rows = messagesEl.querySelectorAll('.msg-row');
    for (const r of rows) {
      if (r.getBoundingClientRect().bottom > top + 1) return r;
    }
    return rows[rows.length - 1] || null;
  }

  // Redesenha a lista inteira a partir de loadedMessages (ver comentário na
  // declaração de loadedMessages) preservando a posição de leitura: ancora na
  // primeira mensagem visível, mede onde ela está na viewport antes, e depois
  // do re-render corrige o scroll pra ela voltar exatamente pro mesmo lugar -
  // robusto mesmo se o conteúdo sofrer reflow. Usado ao paginar pra trás e ao
  // trocar de nome (que muda de que lado cada bolha fica).
  function rerenderLoadedMessages() {
    const anchor = firstVisibleRow();
    const anchorId = anchor && anchor.dataset.id;
    const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;

    clearRenderedRows();
    loadedMessages.forEach(renderMessage);

    const newAnchor = anchorId
      ? messagesEl.querySelector(`.msg-row[data-id="${anchorId}"]`)
      : null;
    // Assinala o scroll em absoluto (zera → mede a âncora nessa base → posiciona)
    // em vez de "+=", pra não depender de onde o navegador deixou o scrollTop
    // depois do teardown/re-render nem do scroll-anchoring dele.
    const reanchor = () => {
      if (!newAnchor) return;
      messagesEl.scrollTop = 0;
      messagesEl.scrollTop = newAnchor.getBoundingClientRect().top - anchorTop;
    };
    reanchor();
    updateScrollBtn();
    updateEmptyState();
    if (!newAnchor) return;

    // Every row just got recreated, so all their media elements are fresh
    // <img>/<video> nodes that haven't loaded/decoded yet - anything the
    // reanchor() above just lined up against can still reflow as each one
    // settles (most visibly for legacy messages with no stored width/height
    // to reserve space with). Same load/error + rAF-batched-correction
    // pattern as scrollToBottomWhenReady's queueScrollCorrection, but
    // re-running THIS anchor correction instead of scrolling to bottom -
    // and cancelled the moment the person actually scrolls/touches/types,
    // so it never fights someone reading.
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      messagesEl.removeEventListener('wheel', cancel);
      messagesEl.removeEventListener('touchstart', cancel);
      messagesEl.removeEventListener('keydown', cancel);
    };
    messagesEl.addEventListener('wheel', cancel, { once: true, passive: true });
    messagesEl.addEventListener('touchstart', cancel, { once: true, passive: true });
    messagesEl.addEventListener('keydown', cancel, { once: true });

    let correctionQueued = false;
    function queueReanchor() {
      if (cancelled || correctionQueued) return;
      correctionQueued = true;
      requestAnimationFrame(() => {
        correctionQueued = false;
        if (!cancelled) reanchor();
      });
    }
    messagesEl.querySelectorAll('img, video, audio').forEach((el) => {
      const ready = el.tagName === 'IMG' ? el.complete : el.readyState >= 1;
      if (ready) return;
      const evt = el.tagName === 'IMG' ? 'load' : 'loadedmetadata';
      el.addEventListener(evt, queueReanchor, { once: true });
      el.addEventListener('error', queueReanchor, { once: true });
    });
    setTimeout(cancel, 800); // matches scrollToBottomWhenReady's own settle window
  }

  // Busca o lote imediatamente anterior ao que já está carregado e redesenha a
  // lista com ele na frente.
  async function loadOlderMessages() {
    if (loadingOlder || !hasMoreOlder || !loadedMessages.length) return;
    loadingOlder = true;
    loadingOlderEl.classList.remove('hidden');
    let older, hasMore;
    try {
      const before = loadedMessages[0].id;
      const res = await fetch(api(`/api/messages?limit=${PAGE_SIZE}&before=${encodeURIComponent(before)}`));
      if (!res.ok) return;
      ({ messages: older, hasMore } = await res.json());
    } finally {
      loadingOlderEl.classList.add('hidden');
      loadingOlder = false;
    }
    if (!older || !older.length) {
      hasMoreOlder = false;
      return;
    }
    // A âncora é medida dentro de rerenderLoadedMessages, antes de ele mexer
    // no DOM - o array já ter crescido aqui em cima não interfere.
    loadedMessages = older.concat(loadedMessages);
    hasMoreOlder = !!hasMore;
    rerenderLoadedMessages();
  }

  // Aplica uma alteração ao item correspondente em loadedMessages (a lista
  // autoritativa), pra que um re-render disparado por loadOlderMessages não
  // reverta patches que só tinham sido aplicados no DOM (apagada, preview de
  // link, visualização única aberta).
  function patchLoadedMessage(id, patch) {
    const m = loadedMessages.find((x) => x.id === id);
    if (m) Object.assign(m, patch);
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
      patchLoadedMessage(id, { linkPreview });
      applyLinkPreview(id, linkPreview);
    });
    es.addEventListener('message-reacted', (evt) => {
      const { id, reactions } = JSON.parse(evt.data);
      patchLoadedMessage(id, { reactions });
      applyReactions(id, reactions);
    });
    es.addEventListener('message', (evt) => {
      // Only auto-follow to the new message if the person was already at
      // (or very near) the bottom — otherwise this would yank them away
      // from older messages they're in the middle of reading. They still
      // get the floating button to jump down whenever they want. A message
      // this person just sent themselves is the exception: sending is a
      // deliberate action, so always follow it down regardless of where
      // they were scrolled.
      const wasNearBottom = isNearBottom();
      const m = JSON.parse(evt.data);
      loadedMessages.push(m);
      renderMessage(m, { animate: true });
      addMediaItemToTop(m);
      if (wasNearBottom || sameName(m.sender, myName())) {
        scrollToBottomWhenReady();
      } else {
        updateScrollBtn();
      }
    });
    es.addEventListener('cleared', () => {
      resetMessagesView();
      resetMediaPanel();
    });
    es.addEventListener('message-deleted', (evt) => {
      const { id, expiredEphemeral, deletedBy } = JSON.parse(evt.data);
      patchLoadedMessage(id, { deleted: true, deletedBy, expiredEphemeral: !!expiredEphemeral });
      applyDeletedPlaceholder(id, expiredEphemeral, deletedBy);
      removeMediaItem(id);
    });
    // The other person opened a view-once photo/video I sent - just a
    // label update (locked → "Aberto"); the media itself never reaches
    // this client, only whoever actually called .../view gets it.
    es.addEventListener('message-viewed', (evt) => {
      const { id, viewedAt } = JSON.parse(evt.data);
      patchLoadedMessage(id, { viewedAt: viewedAt || Date.now() });
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
    nameScreen.classList.add('hidden');
    // O painel de mídia é fixed e vive fora das .screen, então sair não o
    // esconde sozinho. Zerar também descarta os metadados que ficaram em
    // memória da sessão anterior.
    closeMediaPanel();
    resetMediaPanel();
    codeInput.focus();
  }

  // Tela-armadilha: nada de mensagens, SSE ou qualquer chamada que toque o
  // chat de verdade - só o texto fixo, pra quem digitou o código-armadilha
  // não ver nada além disso.
  function showDecoy() {
    loginScreen.classList.add('hidden');
    chatScreen.classList.add('hidden');
    decoyScreen.classList.remove('hidden');
    nameScreen.classList.add('hidden');
    closeMediaPanel();
  }

  // Sem nome não dá pra saber o que é "meu", e é isso que decide o lado das
  // bolhas - então o nome vem antes de qualquer mensagem ser renderizada.
  // Único ponto de entrada do chat (checkAuth e o login passam por aqui).
  async function showChat() {
    if (!myName()) {
      showNamePrompt();
      return;
    }
    await enterChat();
  }

  function showNamePrompt() {
    loginScreen.classList.add('hidden');
    chatScreen.classList.add('hidden');
    decoyScreen.classList.add('hidden');
    nameScreen.classList.remove('hidden');
    nameScreenInput.value = localStorage.getItem(NAME_KEY) || '';
    nameScreenInput.focus();
  }

  nameForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameScreenInput.value.trim();
    if (!name) {
      nameScreenInput.focus();
      return;
    }
    localStorage.setItem(NAME_KEY, name);
    // O campo do compositor continua sendo a fonte que myName() lê.
    nameInput.value = name;
    nameScreen.classList.add('hidden');
    await enterChat();
  });

  async function enterChat() {
    loginScreen.classList.add('hidden');
    nameScreen.classList.add('hidden');
    chatScreen.classList.remove('hidden');
    // #chat-screen is display:none até aqui, então a chamada de
    // syncTextInputUI() lá embaixo (que roda no carregamento do script, com
    // a tela ainda escondida) mediu scrollHeight 0 e deixou o textarea com
    // height:0px preso no inline style. Recalcula agora que o layout é real.
    autoResizeTextInput();
    // Same reasoning: #messages has no real clientWidth until the screen is
    // actually visible, so this can only run now, before the first render.
    updateMediaMaxWidth();
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
      focusNameInput();
      return;
    }
    if (!text) return;
    if (isLoveTrigger(text)) {
      textInput.value = '';
      syncTextInputUI();
      showLoveCounter();
      return;
    }
    if (isKonamiEmojiTrigger(text)) {
      textInput.value = '';
      syncTextInputUI();
      showKonamiHeart();
      return;
    }
    textInput.value = '';
    syncTextInputUI();
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
      syncTextInputUI();
    }
  });

  // Enter envia no desktop (mouse/trackpad); Shift+Enter quebra linha. No
  // toque não há gesto prático pra Shift+Enter, entao Enter sempre quebra
  // linha e o envio fica só pelo botão. isComposing/keyCode 229 evita
  // enviar no meio da composição de um IME (ex.: candidatos de japonês).
  const isTouchPrimary = window.matchMedia('(pointer: coarse)').matches;
  textInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    if (isTouchPrimary || e.shiftKey) return;
    e.preventDefault();
    composer.requestSubmit();
  });

  const sendBtn = composer.querySelector('.send-btn');
  // No iOS, tocar em qualquer botão tira o foco do textarea antes do
  // evento de submit rodar, fechando o teclado a cada envio. preventDefault
  // no mousedown evita essa troca de foco (o click/submit continua normal),
  // então o teclado só fecha quando o usuário realmente toca fora.
  sendBtn.addEventListener('mousedown', (e) => e.preventDefault());
  function updateSendBtnState() {
    sendBtn.classList.toggle('is-empty', !textInput.value.trim());
  }
  function autoResizeTextInput() {
    textInput.style.height = 'auto';
    textInput.style.height = `${textInput.scrollHeight}px`;
  }
  function syncTextInputUI() {
    updateSendBtnState();
    autoResizeTextInput();
  }
  textInput.addEventListener('input', syncTextInputUI);
  syncTextInputUI();

  // Miolo comum aos dois menus flutuantes do composer (câmera e "+"):
  // posiciona acima do botão que abriu, travado nas bordas da viewport
  // visível (teclado incluído), e fecha por Escape ou clique no backdrop.
  // `onShow` existe só pra fechar o OUTRO menu - os dois nunca ficam
  // abertos ao mesmo tempo, senão iam se sobrepor.
  function makeFloatingMenu(menu, backdrop, btn, onShow) {
    let open = false;

    function onKey(e) {
      if (e.key === 'Escape') close();
    }

    // Recomputa a posição em cima do botão. Chamada de novo (não só no
    // show()) enquanto o menu está aberto porque o botão "+" mora no
    // composer, que sobe junto com --app-height quando o teclado do iOS
    // abre (ver syncViewportHeight) - sem reposicionar, o menu ficava
    // travado nas coordenadas de antes do teclado e o #name-input (o único
    // campo digitável que vive aqui) acabava escondido atrás do teclado.
    function reposition() {
      const rect = btn.getBoundingClientRect();
      const mw = menu.offsetWidth;
      const mh = menu.offsetHeight;
      const vv = window.visualViewport;
      const vw = (vv && vv.width) || window.innerWidth;
      const vh = (vv && vv.height) || window.innerHeight;
      const offX = vv ? vv.offsetLeft : 0;
      const offY = vv ? vv.offsetTop : 0;
      const pad = 8;

      let x = rect.right - mw;
      let y = rect.top - mh - 4;
      x = Math.max(offX + pad, Math.min(x, offX + vw - mw - pad));
      y = Math.max(offY + pad, Math.min(y, offY + vh - mh - pad));

      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;
    }

    function show() {
      if (open) return;
      onShow();
      open = true;
      btn.setAttribute('aria-expanded', 'true');
      backdrop.classList.remove('hidden');
      menu.classList.remove('hidden');
      reposition();
      menu.classList.add('is-in');
      document.addEventListener('keydown', onKey);
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', reposition);
        // Mesmo motivo do listener de 'scroll' em syncViewportHeight: no
        // iOS focar o #name-input às vezes dispara 'scroll' na
        // visualViewport em vez de (ou além de) 'resize'.
        window.visualViewport.addEventListener('scroll', reposition);
      }
    }

    function close() {
      if (!open) return;
      open = false;
      btn.setAttribute('aria-expanded', 'false');
      menu.classList.add('hidden');
      menu.classList.remove('is-in');
      backdrop.classList.add('hidden');
      document.removeEventListener('keydown', onKey);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', reposition);
        window.visualViewport.removeEventListener('scroll', reposition);
      }
    }

    btn.addEventListener('click', () => (open ? close() : show()));
    backdrop.addEventListener('click', close);

    return { open: show, close, isOpen: () => open };
  }

  const cameraMenuCtl = makeFloatingMenu(cameraMenu, cameraMenuBackdrop, cameraBtn, () => plusMenuCtl.close());
  const plusMenuCtl = makeFloatingMenu(plusMenu, plusMenuBackdrop, plusBtn, () => cameraMenuCtl.close());

  // A opção do menu de câmera decide sozinha, no momento do clique, se
  // aquela foto/vídeo é visualização única - não é um estado que fica
  // ligado/desligado por aí, então não tem como "esquecer armado" de um
  // envio pro próximo. Mesma ideia pro anexo da galeria, com sua própria
  // flag (fileInput e cameraInput são inputs diferentes).
  let pendingCameraEphemeral = false;
  let pendingAttachEphemeral = false;

  cameraMenuNormalBtn.addEventListener('click', () => {
    cameraMenuCtl.close();
    pendingCameraEphemeral = false;
    cameraInput.click();
  });
  cameraMenuEphemeralBtn.addEventListener('click', () => {
    cameraMenuCtl.close();
    pendingCameraEphemeral = true;
    cameraInput.click();
  });
  cameraMenuAttachBtn.addEventListener('click', () => {
    cameraMenuCtl.close();
    pendingAttachEphemeral = false;
    fileInput.click();
  });
  cameraMenuAttachEphemeralBtn.addEventListener('click', () => {
    cameraMenuCtl.close();
    pendingAttachEphemeral = true;
    fileInput.click();
  });

  // Foca o campo de nome pras rotas que precisam de um myName() não-vazio
  // (enviar mensagem, apagar, reagir, anexar) - o campo mora dentro do
  // menu "+" agora, então precisa abrir o menu primeiro ou o focus() não
  // teria nada visível pra mostrar.
  function focusNameInput() {
    plusMenuCtl.open();
    nameInput.focus();
  }

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
  //
  // O mesmo probe que já era criado só pra medir agora também é desenhado
  // num <canvas> pra gerar a miniatura que a aba "Mídia" usa na grade -
  // ver drawThumb abaixo. Resultado: { width, height, thumb } com thumb
  // podendo ser null (e aí o servidor simplesmente não guarda thumbId).
  function readMediaMeta(file) {
    return new Promise((resolve) => {
      const isImage = file.type.startsWith('image/');
      const isVideo = file.type.startsWith('video/');
      if (!isImage && !isVideo) {
        resolve(null);
        return;
      }
      const url = URL.createObjectURL(file);
      let done = false;
      const finish = (meta) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        URL.revokeObjectURL(url);
        resolve(meta);
      };
      const timer = setTimeout(() => finish(null), 8000);

      // Mede primeiro (é o que não pode falhar), depois tenta a miniatura.
      // Se o toBlob der errado, ainda entregamos width/height.
      const settle = (probe, width, height) => {
        if (!width || !height) return finish(null);
        drawThumb(probe, width, height).then((thumb) => {
          finish({ width, height, thumb });
        });
      };

      if (isImage) {
        const probe = new Image();
        probe.onload = () => settle(probe, probe.naturalWidth, probe.naturalHeight);
        probe.onerror = () => finish(null);
        probe.src = url;
      } else {
        const probe = document.createElement('video');
        probe.preload = 'metadata';
        // muted + playsInline: sem os dois o Safari do iOS se recusa a
        // decodificar o frame fora de um gesto do usuário, e o canvas sai
        // preto (ou o seek nunca completa).
        probe.muted = true;
        probe.playsInline = true;
        probe.onloadedmetadata = async () => {
          const w = probe.videoWidth;
          const h = probe.videoHeight;
          if (!w || !h) return finish(null);
          // O Safari (desktop e iOS - mesmo motor WebKit) não decodifica
          // frame nenhum antes de dar play() pelo menos uma vez: mesmo
          // depois do seeked, o <video> não tem nada de verdade pro
          // drawImage capturar, e o canvas sai sólido preto. Confirmado
          // reproduzindo com o motor WebKit - Chromium não tem esse
          // problema. muted + playsInline (já setados acima) são o que
          // permite esse play() rodar sem gesto do usuário; play/pause é
          // silencioso e nunca chega a ser visível.
          try {
            await probe.play();
            probe.pause();
          } catch (e) {
            // play recusado - segue tentando via seek mesmo assim, o
            // timeout abaixo garante que não trava esperando pra sempre
          }
          // Frame do comecinho, mas não o 0 - muito vídeo abre com um
          // frame preto de fade-in, o que daria uma grade de quadrados
          // pretos. Meio segundo já pegou alguma coisa na maioria deles.
          const target = Math.min(0.5, (probe.duration || 1) / 2);
          let settled = false;
          const grab = () => {
            if (settled) return;
            settled = true;
            settle(probe, w, h);
          };
          probe.onseeked = grab;
          try {
            probe.currentTime = target;
          } catch (e) {
            grab(); // seek recusado: desenha o que estiver decodificado
          }
          // Se o seeked não vier (acontece em alguns codecs no iOS), não
          // fica pendurado até o timeout de 8s levar a dimensão junto.
          setTimeout(grab, 1200);
        };
        probe.onerror = () => finish(null);
        probe.src = url;
      }
    });
  }

  // Miniatura pra grade da aba "Mídia". Maior lado em THUMB_MAX_PX, JPEG -
  // 20-60KB no lugar dos 1-12MB do arquivo original, que é a diferença
  // entre a grade abrir na hora e a grade derrubar a conexão.
  const THUMB_MAX_PX = 400;

  function drawThumb(source, width, height) {
    return new Promise((resolve) => {
      try {
        const scale = Math.min(1, THUMB_MAX_PX / Math.max(width, height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(null);
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        // toBlob é assíncrono e pode chamar de volta com null; o canvas
        // também fica "tainted" (e lança) se a origem não for same-origin,
        // daí o try/catch em volta de tudo.
        canvas.toBlob((blob) => resolve(blob || null), 'image/jpeg', 0.72);
      } catch (e) {
        resolve(null);
      }
    });
  }

  // Miolo comum aos dois inputs de arquivo (galeria via fileInput, câmera
  // via cameraInput) - cada um só decide de onde vêm os File objects e se
  // esse lote é visualização única antes de chamar isto.
  async function uploadFiles(files, wantsEphemeral) {
    if (!files.length) return;
    const sender = myName();
    if (!sender) {
      focusNameInput();
      return;
    }

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

      const meta = await readMediaMeta(file);

      const form = new FormData();
      form.append('file', file);
      form.append('sender', sender);
      if (i === 0 && replyToId) form.append('replyToId', replyToId);
      if (wantsEphemeral) form.append('ephemeral', '1');
      if (meta) {
        form.append('width', String(meta.width));
        form.append('height', String(meta.height));
        // Visualização única não ganha miniatura: uma thumb persistente
        // sobreviveria aos 10s e furaria o sentido inteiro do recurso. O
        // servidor recusa de novo por conta própria, isto aqui só evita
        // mandar os bytes à toa.
        if (meta.thumb && !wantsEphemeral) {
          form.append('thumb', meta.thumb, 'thumb.jpg');
        }
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
  }

  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files || []);
    fileInput.value = '';
    const wantsEphemeral = pendingAttachEphemeral;
    pendingAttachEphemeral = false;
    uploadFiles(files, wantsEphemeral);
  });

  cameraInput.addEventListener('change', () => {
    const files = Array.from(cameraInput.files || []);
    cameraInput.value = '';
    const wantsEphemeral = pendingCameraEphemeral;
    pendingCameraEphemeral = false;
    uploadFiles(files, wantsEphemeral);
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
      if (res.ok) {
        resetMessagesView();
        resetMediaPanel();
      }
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
