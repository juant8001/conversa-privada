'use strict';

// Presença de verdade (v54).
//
// Antes, "online" era "tem um SSE aberto". Só que um SSE fica aberto com a
// aba em segundo plano, com o Mac de tela bloqueada ou com o celular no
// bolso - e, passando pelo túnel do Cloudflare, às vezes nem fecha quando a
// pessoa vai embora (a conexão "fantasma" só morre minutos depois). Daí o
// "fulano está online" sem fulano estar.
//
// Agora cada aba aberta (cid) manda batidas pro servidor dizendo em que
// estado está, e só conta o que está batendo:
//   active - aba visível e a pessoa mexendo nela         -> online
//   idle   - aba visível, mas sem ninguém mexer há um tempo -> ausente
//   hidden - aba em segundo plano / tela bloqueada        -> não conta
// Aba que para de bater (fechou, perdeu rede, celular dormiu) cai sozinha
// depois de staleMs, haja SSE aberto ou não.
//
// Tudo em memória, como as sessões. O "visto por último" de cada pessoa é a
// exceção: o servidor grava num campo cifrado do store quando alguém sai do
// online (ver onWentOffline em server.js), pra sobreviver a um restart.

const STATES = ['active', 'idle', 'hidden'];
const PERSON_RANK = { online: 3, away: 2, offline: 1 };
const GC_MS = 10 * 60 * 1000;

function nameKey(n) {
  return String(n || '').trim().toLowerCase();
}

function cleanDevice(d) {
  return String(d || '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 24) || 'navegador';
}

class Presence {
  constructor(opts = {}) {
    this.staleMs = opts.staleMs || 50000;
    this.onChange = opts.onChange || (() => {});
    this.onWentOffline = opts.onWentOffline || (() => {});
    this.conns = new Map(); // cid -> { name, device, state, lastBeat, lastActive, streams, key }
    this.lastSeen = new Map(); // nameKey -> { name, ts }
    this.lastKey = null;
    this.lastSig = '';
    this.lastOnline = new Set();
    this.current = { online: [], people: [] };
  }

  _update(cid, info, now) {
    let c = this.conns.get(cid);
    if (!c) {
      c = { streams: new Set(), lastActive: 0, state: null, lastBeat: now };
      this.conns.set(cid, c);
    }
    const name = String(info.name || '').trim().slice(0, 60);
    if (name) c.name = name;
    if (info.device) c.device = cleanDevice(info.device);
    const state = STATES.includes(info.state) ? info.state : (c.state || 'active');
    // Estava ou está ativa: o "visto por último" dela é agora.
    if (c.state === 'active' || state === 'active') c.lastActive = now;
    c.state = state;
    c.lastBeat = now;
    if (info.key) {
      c.key = info.key;
      this.lastKey = info.key;
    }
    return c;
  }

  _remember(c) {
    if (!c.name || !c.lastActive) return;
    const k = nameKey(c.name);
    const prev = this.lastSeen.get(k);
    if (!prev || prev.ts < c.lastActive) this.lastSeen.set(k, { name: c.name, ts: c.lastActive });
  }

  // Um SSE abriu pra essa aba.
  attach(cid, streamId, info, now = Date.now()) {
    if (!cid) return;
    const c = this._update(cid, info || {}, now);
    c.streams.add(streamId);
    this.recompute(now);
  }

  // O SSE fechou. Sem nenhum outro SSE dessa aba, ela saiu de vez.
  detach(cid, streamId, now = Date.now()) {
    const c = this.conns.get(cid);
    if (!c) return;
    c.streams.delete(streamId);
    if (!c.streams.size) {
      if (c.state === 'active') c.lastActive = now;
      this._remember(c);
      this.conns.delete(cid);
    }
    this.recompute(now);
  }

  // Batida da aba (POST /api/presence).
  beat(cid, info, now = Date.now()) {
    if (!cid) return;
    this._update(cid, info || {}, now);
    this.recompute(now);
  }

  sweep(now = Date.now()) {
    for (const [cid, c] of this.conns) {
      const age = now - c.lastBeat;
      // Sem SSE e sem bater: lixo. Com SSE "fantasma": some do online já em
      // staleMs (snapshot ignora), e da memória depois de GC_MS.
      if ((age > this.staleMs && !c.streams.size) || age > GC_MS) {
        this._remember(c);
        this.conns.delete(cid);
      }
    }
    this.recompute(now);
  }

  loadLastSeen(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (!v || typeof v.ts !== 'number' || !v.name) continue;
      const key = nameKey(k.replace(/^u:/, ''));
      const prev = this.lastSeen.get(key);
      if (!prev || prev.ts < v.ts) this.lastSeen.set(key, { name: String(v.name).slice(0, 60), ts: v.ts });
    }
    this.recompute(Date.now());
  }

  lastSeenObject() {
    const out = {};
    // Prefixo "u:" pelo mesmo motivo do prefsKey: nome "__proto__" não pode
    // virar propriedade do objeto.
    for (const [k, v] of this.lastSeen) out[`u:${k}`] = { name: v.name, ts: v.ts };
    return out;
  }

  snapshot(now = Date.now()) {
    const people = new Map();
    for (const [cid, c] of this.conns) {
      if (!c.name) continue;
      this._remember(c);
      if (now - c.lastBeat > this.staleMs) continue;
      const k = nameKey(c.name);
      const p = people.get(k) || { name: c.name, state: 'offline', devices: [] };
      const dev = c.state === 'active' ? 'online' : c.state === 'idle' ? 'away' : 'hidden';
      p.devices.push({ id: cid, device: c.device || 'navegador', state: dev });
      const personState = dev === 'hidden' ? 'offline' : dev;
      if (PERSON_RANK[personState] > PERSON_RANK[p.state]) p.state = personState;
      people.set(k, p);
    }
    for (const [k, ls] of this.lastSeen) {
      if (!people.has(k)) people.set(k, { name: ls.name, state: 'offline', devices: [] });
    }
    const list = [];
    for (const [k, p] of people) {
      const ls = this.lastSeen.get(k);
      // Online não leva horário (senão a assinatura mudaria a cada batida e
      // o servidor transmitiria presença sem parar).
      p.lastSeen = p.state === 'online' ? null : (ls ? ls.ts : null);
      p.devices.sort((a, b) => (a.id < b.id ? -1 : 1));
      list.push(p);
    }
    list.sort((a, b) => nameKey(a.name).localeCompare(nameKey(b.name)));
    return { online: list.filter((p) => p.state === 'online').map((p) => p.name), people: list };
  }

  recompute(now = Date.now()) {
    const snap = this.snapshot(now);
    this.current = snap;
    const onlineKeys = new Set(snap.online.map(nameKey));
    let wentOffline = false;
    for (const k of this.lastOnline) if (!onlineKeys.has(k)) wentOffline = true;
    this.lastOnline = onlineKeys;
    const sig = JSON.stringify(snap);
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.onChange(snap);
    }
    if (wentOffline && this.lastKey) this.onWentOffline(this.lastKey);
    return snap;
  }
}

module.exports = { Presence, nameKey };
