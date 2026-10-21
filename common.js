// Shared helpers for caller and technician pages.

/** WebSocket client with auto-reconnect and a promise-based request helper. */
export class Signal {
  constructor({ onMessage, onOpen, onClose } = {}) {
    this.onMessage = onMessage || (() => {});
    this.onOpen = onOpen || (() => {});
    this.onClose = onClose || (() => {});
    this.pending = new Map();
    this.retry = 0;
    this.closedByUser = false;
    this.connect();
  }
  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onopen = () => {
      this.retry = 0;
      this.onOpen();
    };
    this.ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.requestId && this.pending.has(msg.requestId)) {
        this.pending.get(msg.requestId)(msg);
        this.pending.delete(msg.requestId);
      }
      this.onMessage(msg);
    };
    this.ws.onclose = () => {
      this.onClose();
      if (this.closedByUser) return;
      const wait = Math.min(1000 * 2 ** this.retry++, 8000);
      setTimeout(() => this.connect(), wait);
    };
  }
  get open() { return this.ws && this.ws.readyState === WebSocket.OPEN; }
  send(msg) {
    if (this.open) { this.ws.send(JSON.stringify(msg)); return true; }
    return false;
  }
  request(msg, timeoutMs = 6000) {
    const requestId = Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.pending.delete(requestId); resolve({ ok: false, reason: 'timeout' }); }, timeoutMs);
      this.pending.set(requestId, (m) => { clearTimeout(t); resolve(m); });
      if (!this.send({ ...msg, requestId })) { clearTimeout(t); this.pending.delete(requestId); resolve({ ok: false, reason: 'offline' }); }
    });
  }
}

/** Small tone generator: hold music for callers, ring for the technician. Must be unlocked by a tap. */
export class Tones {
  constructor() { this.ctx = null; this.timer = null; }
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    this.ctx?.resume?.();
  }
  beep(freq, dur, when = 0, vol = 0.12) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.02);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  hold() { // soft two-note pattern every 3 s
    this.stop();
    const play = () => { this.beep(523, 0.25, 0, 0.06); this.beep(659, 0.35, 0.3, 0.06); };
    play();
    this.timer = setInterval(play, 3000);
  }
  ring() { // phone-like double ring every 2.5 s
    this.stop();
    const play = () => {
      for (let i = 0; i < 2; i++) { this.beep(880, 0.35, i * 0.5, 0.2); this.beep(1100, 0.35, i * 0.5 + 0.02, 0.12); }
      navigator.vibrate?.([300, 200, 300]);
    };
    play();
    this.timer = setInterval(play, 2500);
  }
}

export function toast(text, ms = 4000) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = text;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.hidden = true), ms);
}

export function setLed(el, color, blink = false) {
  if (!el) return;
  el.dataset.c = color;
  if (blink) el.dataset.blink = ''; else delete el.dataset.blink;
}

export function addLine(container, role, text, { partial = false, replace = null } = {}) {
  const el = replace || document.createElement('div');
  el.className = `line ${role}${partial ? ' partial' : ''}`;
  el.textContent = text;
  if (!replace) container.append(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

export function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const MIC_CONSTRAINTS = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
};

/** Collects ICE candidates that arrive before the remote description is set. */
export function makeIceQueue(pc) {
  const queue = [];
  return {
    async add(candidate) {
      if (pc.remoteDescription && pc.remoteDescription.type) {
        try { await pc.addIceCandidate(candidate); } catch (e) { console.warn('ICE add failed', e); }
      } else queue.push(candidate);
    },
    async flush() {
      while (queue.length) {
        try { await pc.addIceCandidate(queue.shift()); } catch (e) { console.warn('ICE add failed', e); }
      }
    }
  };
}
