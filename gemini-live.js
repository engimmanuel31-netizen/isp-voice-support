// Browser client for the Gemini Live API (speech-to-speech over WebSocket).
// - Microphone: captured with an AudioWorklet, resampled to 16 kHz 16-bit PCM, sent every 40 ms
// - Voice: 24 kHz PCM chunks from Gemini, scheduled gap-free with Web Audio
// - Events are passed to onEvent(type, data) so the page decides what to show

const WORKLET = `
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = Math.max(1, sampleRate / 16000);
    this.pos = 0; this.acc = 0; this.n = 0;
    this.out = new Int16Array(640); this.len = 0; this.sq = 0; this.cnt = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = ch[i];
      this.sq += s * s; this.cnt++;
      this.acc += s; this.n++; this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.n));
        this.acc = 0; this.n = 0;
        this.out[this.len++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.len === this.out.length) {
          const rms = Math.sqrt(this.sq / this.cnt);
          this.port.postMessage({ pcm: this.out.buffer, rms }, [this.out.buffer]);
          this.out = new Int16Array(640); this.len = 0; this.sq = 0; this.cnt = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('mic-processor', MicProcessor);
`;

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64Pcm16(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  const f = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 0x8000;
  return f;
}

export class GeminiLive {
  /** ctx: an AudioContext created inside the user's tap (shared across AI sessions in one call). */
  constructor(onEvent, ctx = null) {
    this.onEvent = onEvent || (() => {});
    this.ctx = ctx;
    this.ws = null;
    this.sources = new Set();
    this.nextTime = 0;
    this.muted = false;
    this.closed = false;
    this.ready = false;
    this.lastVoiceAt = 0;
    // While the assistant talks (and for a moment after), quieter sound is treated as its own
    // echo from the speaker and replaced with silence. Speaking up close to the mic still gets through.
    this.echoGuard = 0.09;
    this.echoTailMs = 600;
    this.lastPlaybackEnd = 0;
  }

  /** Call synchronously inside the user's tap so iOS allows audio. */
  prepareAudio() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
    }
    this.ctx.resume?.();
  }

  get playing() {
    return this.sources.size > 0;
  }

  async start({ wsUrl, setup, micStream }) {
    this.prepareAudio();
    if (!this.ctx.__micWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      this.ctx.__micWorklet = this.ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    }
    await this.ctx.__micWorklet;

    this.micSource = this.ctx.createMediaStreamSource(micStream);
    this.node = new AudioWorkletNode(this.ctx, 'mic-processor');
    this.silent = this.ctx.createGain();
    this.silent.gain.value = 0; // keeps the worklet running without playing the mic back
    this.micSource.connect(this.node).connect(this.silent).connect(this.ctx.destination);
    this.node.port.onmessage = (e) => this.onMic(e.data);

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('Gemini did not respond in time')), 10000);
      ws.onopen = () => ws.send(JSON.stringify(setup));
      ws.onmessage = async (e) => {
        const text = typeof e.data === 'string' ? e.data : await e.data.text();
        let msg;
        try { msg = JSON.parse(text); } catch { return; }
        if (msg.setupComplete !== undefined && !this.ready) {
          this.ready = true;
          clearTimeout(timer);
          resolve();
        }
        this.onServer(msg);
      };
      ws.onerror = () => {};
      ws.onclose = (e) => {
        clearTimeout(timer);
        if (!this.ready) reject(new Error(e.reason || `Gemini closed the connection (${e.code})`));
        else if (!this.closed) this.onEvent('closed', { code: e.code, reason: e.reason });
      };
    });
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  onMic({ pcm, rms }) {
    if (!this.ready || this.closed) return;
    const now = performance.now();
    const echoWindow = this.playing || now - this.lastPlaybackEnd < this.echoTailMs;
    if (rms > 0.02 && !echoWindow) this.lastVoiceAt = now;
    let data = pcm;
    // mute, or likely echo of the assistant's own voice: send silence so timing stays smooth
    if (this.muted || (echoWindow && rms < this.echoGuard)) data = new Int16Array(pcm.byteLength / 2).buffer;
    this.onEvent('mic', { rms, sent: data === pcm });
    this.send({ realtimeInput: { audio: { data: toBase64(data), mimeType: 'audio/pcm;rate=16000' } } });
  }

  sendText(text) {
    this.send({ realtimeInput: { text } });
  }

  sendToolResponse(functionResponses) {
    this.send({ toolResponse: { functionResponses } });
  }

  play(b64) {
    const samples = fromBase64Pcm16(b64);
    if (!samples.length) return;
    const buf = this.ctx.createBuffer(1, samples.length, 24000);
    buf.copyToChannel(samples, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const startAt = Math.max(this.ctx.currentTime + 0.02, this.nextTime);
    src.start(startAt);
    this.nextTime = startAt + buf.duration;
    const wasPlaying = this.playing;
    this.sources.add(src);
    if (!wasPlaying) this.onEvent('speaking-started');
    src.onended = () => {
      this.sources.delete(src);
      if (!this.playing) {
        this.lastPlaybackEnd = performance.now();
        this.onEvent('speaking-stopped');
      }
    };
  }

  stopPlayback() {
    for (const s of this.sources) {
      s.onended = null;
      try { s.stop(); } catch {}
    }
    const was = this.playing;
    this.sources.clear();
    if (was) this.lastPlaybackEnd = performance.now();
    this.nextTime = 0;
    if (was) this.onEvent('speaking-stopped');
  }

  /** Resolves when everything queued so far has finished playing (or after maxMs). */
  whenDrained(maxMs = 8000) {
    return new Promise((resolve) => {
      const started = performance.now();
      const check = () => {
        if (!this.playing || performance.now() - started > maxMs) resolve();
        else setTimeout(check, 100);
      };
      check();
    });
  }

  onServer(msg) {
    if (msg.toolCall?.functionCalls?.length) {
      this.onEvent('tool-call', msg.toolCall.functionCalls);
    }
    if (msg.toolCallCancellation) this.onEvent('tool-cancel', msg.toolCallCancellation.ids || []);
    if (msg.goAway) this.onEvent('go-away', msg.goAway);

    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.interrupted) {
      this.stopPlayback();
      this.onEvent('interrupted');
    }
    if (sc.inputTranscription?.text) this.onEvent('user-text', sc.inputTranscription.text);
    if (sc.outputTranscription?.text) this.onEvent('assistant-text', sc.outputTranscription.text);
    for (const part of sc.modelTurn?.parts || []) {
      const d = part.inlineData;
      if (d?.data && (d.mimeType || '').startsWith('audio/')) {
        this.onEvent('audio-chunk');
        this.play(d.data);
      }
    }
    if (sc.turnComplete) this.onEvent('turn-complete');
  }

  close() {
    this.closed = true;
    this.stopPlayback();
    try { this.ws?.close(); } catch {}
    try { this.node?.disconnect(); this.micSource?.disconnect(); this.silent?.disconnect(); } catch {}
    this.ws = null;
    this.ready = false;
  }
}
