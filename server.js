// ISP Voice Support server
// - Mints one-use Gemini Live tokens so the browser can talk to the AI directly (the real key stays here)
// - Runs a WebSocket signalling hub that rings the technician and relays WebRTC offers/answers/ICE
// - Keeps the escalation queue and simple live stats in memory
// Only dependency: `ws`. HTTP and static files use Node's built-in modules.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { buildInstructions, FUNCTION_DECLARATIONS, OFFERED_LANGUAGES } from './prompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Web pages live in public/. If they were uploaded next to server.js instead (easy to do with
// GitHub's web uploader), serve them from there, but only the page files listed here.
const HAS_PUBLIC = existsSync(path.join(__dirname, 'public', 'index.html'));
const PUBLIC_DIR = HAS_PUBLIC ? path.join(__dirname, 'public') : __dirname;
const FLAT_ALLOWED = new Set([
  'index.html', 'tech.html', 'booth.html', 'style.css',
  'caller.js', 'tech.js', 'common.js', 'gemini-live.js'
]);
const GEMINI_WS =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
const GEMINI_API = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com'; // overridable for tests

// Load .env when running locally (cloud hosts set real environment variables)
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const cfg = {
  port: Number(process.env.PORT) || 3000,
  geminiKey: process.env.GEMINI_API_KEY || '',
  model: process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live',
  voice: process.env.GEMINI_VOICE || 'Kore',
  ispName: process.env.ISP_NAME || 'NetConnect',
  assistantName: process.env.ASSISTANT_NAME || 'Nova',
  techPin: process.env.TECH_PIN || '',
  maxCallSeconds: Number(process.env.MAX_CALL_SECONDS) || 600,
  ringTimeoutMs: (Number(process.env.RING_TIMEOUT_SECONDS) || 45) * 1000,
  sessionsPerHourPerIp: Number(process.env.SESSIONS_PER_HOUR_PER_IP) || 20,
  turn: {
    urls: process.env.TURN_URLS || '',
    username: process.env.TURN_USERNAME || '',
    credential: process.env.TURN_CREDENTIAL || ''
  }
};

if (!cfg.geminiKey) console.warn('[warn] GEMINI_API_KEY is not set: AI calls will fail until you add it.');
if (!cfg.techPin) console.warn('[warn] TECH_PIN is not set: the technician page will refuse all logins.');

// ---------------------------------------------------------------- HTTP helpers
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function clientIp(req) {
  // Render / Railway sit behind a proxy that sets X-Forwarded-For
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  if (!path.extname(rel)) rel += '.html'; // /tech -> tech.html
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 403, { error: 'forbidden' });
  // flat layout: never serve server code, config or tests, only the page files
  if (!HAS_PUBLIC && (path.dirname(file) !== PUBLIC_DIR || !FLAT_ALLOWED.has(path.basename(file)))) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not file');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Permissions-Policy': 'microphone=(self)'
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

function iceServers() {
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (cfg.turn.urls) {
    servers.push({
      urls: cfg.turn.urls.split(',').map((u) => u.trim()).filter(Boolean),
      username: cfg.turn.username,
      credential: cfg.turn.credential
    });
  }
  return servers;
}

function publicConfig() {
  return {
    ispName: cfg.ispName,
    assistantName: cfg.assistantName,
    maxCallSeconds: cfg.maxCallSeconds,
    ringTimeoutSeconds: cfg.ringTimeoutMs / 1000,
    languages: OFFERED_LANGUAGES,
    iceServers: iceServers(),
    aiReady: Boolean(cfg.geminiKey)
  };
}

// Simple per-IP limiter so a stranger cannot use up your free Gemini limits
const sessionLog = new Map();
function allowSession(ip) {
  const now = Date.now();
  const recent = (sessionLog.get(ip) || []).filter((t) => now - t < 3600_000);
  if (recent.length >= cfg.sessionsPerHourPerIp) return false;
  recent.push(now);
  sessionLog.set(ip, recent);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of sessionLog) if (!list.some((t) => now - t < 3600_000)) sessionLog.delete(ip);
}, 600_000).unref();

const stats = { aiSessions: 0, escalations: 0, connectedToTech: 0, missed: 0, resolvedByAi: 0, startedAt: Date.now() };

// The exact setup message the browser sends as its first WebSocket frame to Gemini.
// It is built here so the system prompt and tools stay under the server's control.
function buildLiveSetup(resumeContext) {
  return {
    setup: {
      model: `models/${cfg.model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } } }
      },
      systemInstruction: {
        parts: [{ text: buildInstructions({ ispName: cfg.ispName, assistantName: cfg.assistantName, resumeContext }) }]
      },
      tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
      // transcripts for the screen and for the technician (language is auto-detected)
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: 'START_SENSITIVITY_LOW', // exhibition halls are noisy
          endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH', // reply quickly once the caller stops
          prefixPaddingMs: 200,
          silenceDurationMs: 800 // a short pause mid-sentence doesn't end the caller's turn
        },
        // background noise must not cut Nova off mid-sentence at a busy exhibition
        activityHandling: 'NO_INTERRUPTION'
      }
    }
  };
}

async function createSession(req, res) {
  if (!cfg.geminiKey) return json(res, 503, { error: 'The server has no Gemini API key yet.' });
  let body;
  try { body = await readJson(req); } catch (e) { return json(res, e.status || 400, { error: 'Bad request' }); }
  if (!allowSession(clientIp(req))) return json(res, 429, { error: 'Too many calls from this device. Please try again later.' });


  // A resumed call (technician did not pick up) gets context from OUR records, never from the browser
  let resumeContext = '';
  const resumeId = typeof body?.resumeCallId === 'string' ? body.resumeCallId : '';
  const prev = resumeId && calls.get(resumeId);
  if (prev && prev.status === 'missed') {
    resumeContext =
      `The caller was already helped earlier in this call. Summary: ${prev.summary}. ` +
      'You tried to transfer them to the technician but nobody answered in time. ' +
      `When you receive the note that the caller is back, apologise in one sentence, then offer two options: continue troubleshooting together, or visit the ${cfg.ispName} help desk at the booth. ` +
      'Do not call escalate_to_technician again unless the caller insists.' +
      (prev.lang && prev.lang !== 'Not chosen yet'
        ? ` The caller already chose ${prev.lang}: speak only ${prev.lang} and do not ask for the language again.`
        : ' Ask which language they would like before anything else.');
  }

  try {
    // One-use token: must start a session within 1 minute, expires in 30 minutes.
    const now = Date.now();
    const base = {
      uses: 1,
      expireTime: new Date(now + 30 * 60_000).toISOString(),
      newSessionExpireTime: new Date(now + 60_000).toISOString()
    };
    const requestToken = (body) =>
      fetch(`${GEMINI_API}/v1beta/auth_tokens`, {
        method: 'POST',
        headers: { 'x-goog-api-key': cfg.geminiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(async (r) => ({ r, data: await r.json().catch(() => ({})) }));

    // The token carries the FULL setup (prompt, functions, voice, transcripts, turn detection).
    // Important: a token with a setup inside makes Gemini use that setup and ignore the one the
    // browser sends, so everything Nova needs must be in here, not only the model.
    // If Google rejects the field, fall back to a plain one-use token; then the browser's
    // setup message (identical) is used instead. Either way the session gets the same setup.
    const setup = buildLiveSetup(resumeContext);
    let { r, data } = await requestToken({ ...base, bidiGenerateContentSetup: setup.setup });
    if (r.status === 400) {
      console.warn('[gemini] locked token rejected, using a plain one-use token:', data?.error?.message);
      ({ r, data } = await requestToken(base));
    }
    if (!r.ok || !data.name) {
      console.error('[gemini] auth_tokens failed', r.status, data?.error?.message);
      return json(res, 502, { error: data?.error?.message || `Gemini returned ${r.status}` });
    }
    stats.aiSessions++;
    broadcastState();
    json(res, 200, {
      wsUrl: `${GEMINI_WS}?access_token=${encodeURIComponent(data.name)}`,
      setup,
      resumed: Boolean(resumeContext),
      maxCallSeconds: cfg.maxCallSeconds
    });
  } catch (err) {
    console.error('[gemini] network error', err);
    json(res, 502, { error: 'Could not reach Gemini.' });
  }
}

// ---------------------------------------------------------------- routes
const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/api/config' && req.method === 'GET') return json(res, 200, publicConfig());
    if (pathname === '/api/health') return json(res, 200, { ok: true, uptime: process.uptime() });
    if (pathname === '/api/session' && req.method === 'POST') return await createSession(req, res);
    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, pathname);
    res.writeHead(405).end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'Server error' });
  }
});

// ---------------------------------------------------------------- WebSocket signalling
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

/** @type {Map<string, {ws, name, online, busyCallId}>} */
const techs = new Map();
/** @type {Map<string, object>} */
const calls = new Map();

const send = (ws, msg) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
};

function pinOk(pin) {
  if (!cfg.techPin || typeof pin !== 'string') return false;
  const a = Buffer.from(pin);
  const b = Buffer.from(cfg.techPin);
  return a.length === b.length && timingSafeEqual(a, b);
}

const availableTechs = () => [...techs.values()].filter((t) => t.online && !t.busyCallId && t.ws.readyState === 1);

function publicCall(c) {
  return {
    id: c.id, status: c.status, lang: c.lang, reason: c.reason, summary: c.summary,
    stepsTried: c.stepsTried, customerName: c.customerName, urgency: c.urgency,
    transcript: c.transcript, createdAt: c.createdAt, device: c.device
  };
}

function queueSnapshot() {
  return [...calls.values()].filter((c) => c.status === 'ringing').map(publicCall);
}

function broadcastTechs(msg) {
  for (const t of techs.values()) send(t.ws, msg);
}

function broadcastState() {
  broadcastTechs({
    type: 'state',
    queue: queueSnapshot(),
    stats,
    techsOnline: [...techs.values()].filter((t) => t.online).length
  });
}

function clean(s, max) {
  return typeof s === 'string' ? s.slice(0, max) : '';
}

function endCall(call, by, reason = 'ended') {
  if (!call || call.status === 'ended') return;
  clearTimeout(call.ringTimer);
  const wasStatus = call.status;
  call.status = wasStatus === 'missed' ? 'missed' : 'ended';
  call.endedAt = Date.now();
  if (by !== 'caller') send(call.callerWs, { type: 'call-ended', callId: call.id, reason });
  const tech = call.techId && techs.get(call.techId);
  if (tech) {
    if (by !== 'tech') send(tech.ws, { type: 'call-ended', callId: call.id, reason });
    if (tech.busyCallId === call.id) tech.busyCallId = null;
  }
  if (wasStatus === 'ringing') broadcastTechs({ type: 'call-cancelled', callId: call.id });
  broadcastState();
  // keep the record a few minutes (needed for "resume with AI"), then drop it
  setTimeout(() => calls.delete(call.id), 10 * 60_000).unref();
}

function markMissed(call) {
  if (call.status !== 'ringing') return;
  clearTimeout(call.ringTimer);
  call.status = 'missed';
  stats.missed++;
  send(call.callerWs, { type: 'tech-missed', callId: call.id });
  broadcastTechs({ type: 'call-cancelled', callId: call.id, reason: 'timeout' });
  broadcastState();
  setTimeout(() => calls.delete(call.id), 10 * 60_000).unref();
}

wss.on('connection', (ws, req) => {
  ws.id = randomUUID();
  ws.role = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    handle(ws, msg, req);
  });

  ws.on('close', () => {
    if (ws.role === 'tech') {
      const t = techs.get(ws.id);
      techs.delete(ws.id);
      if (t?.busyCallId) endCall(calls.get(t.busyCallId), 'tech', 'technician-disconnected');
      broadcastState();
    } else if (ws.role === 'caller') {
      for (const c of calls.values()) {
        if (c.callerWs === ws && (c.status === 'ringing' || c.status === 'connecting' || c.status === 'live')) {
          endCall(c, 'caller', 'caller-disconnected');
        }
      }
    }
  });
});

function handle(ws, msg, req) {
  switch (msg.type) {
    case 'ping':
      return send(ws, { type: 'pong' });

    // ---------- technician
    case 'tech-login': {
      if (!pinOk(msg.pin)) return send(ws, { type: 'tech-denied' });
      ws.role = 'tech';
      techs.set(ws.id, { ws, name: clean(msg.name, 40) || 'Technician', online: msg.online !== false, busyCallId: null });
      send(ws, { type: 'tech-ok', techId: ws.id });
      return broadcastState();
    }
    case 'tech-status': {
      const t = techs.get(ws.id);
      if (!t) return;
      t.online = Boolean(msg.online);
      return broadcastState();
    }
    case 'accept': {
      const t = techs.get(ws.id);
      const call = calls.get(msg.callId);
      if (!t || !call) return send(ws, { type: 'accept-failed', callId: msg.callId, reason: 'gone' });
      if (call.status !== 'ringing') return send(ws, { type: 'accept-failed', callId: call.id, reason: 'taken' });
      if (t.busyCallId) return send(ws, { type: 'accept-failed', callId: call.id, reason: 'busy' });
      clearTimeout(call.ringTimer);
      call.status = 'connecting';
      call.techId = ws.id;
      t.busyCallId = call.id;
      send(ws, { type: 'accepted', call: publicCall(call) });
      send(call.callerWs, { type: 'tech-accepted', callId: call.id, techName: t.name });
      broadcastTechs({ type: 'call-taken', callId: call.id });
      return broadcastState();
    }
    case 'decline': {
      const call = calls.get(msg.callId);
      if (!call || call.status !== 'ringing') return;
      call.declinedBy.add(ws.id);
      const stillCanAnswer = availableTechs().some((t) => !call.declinedBy.has(t.ws.id));
      if (!stillCanAnswer) markMissed(call);
      return;
    }

    // ---------- caller
    case 'caller-hello':
      ws.role = 'caller';
      return send(ws, { type: 'hello-ok', callerId: ws.id });

    case 'escalate': {
      if (ws.role !== 'caller') return;
      const free = availableTechs();
      if (free.length === 0) {
        return send(ws, { type: 'escalate-result', requestId: msg.requestId, ok: false, reason: 'no-technician' });
      }
      const call = {
        id: randomUUID(),
        callerWs: ws,
        status: 'ringing',
        lang: clean(msg.lang, 30) || 'Not chosen yet',
        reason: clean(msg.reason, 60) || 'out_of_scope',
        summary: clean(msg.summary, 1500) || 'No summary provided.',
        stepsTried: Array.isArray(msg.stepsTried) ? msg.stepsTried.slice(0, 20).map((s) => clean(s, 200)) : [],
        customerName: clean(msg.customerName, 60),
        urgency: msg.urgency === 'high' ? 'high' : 'normal',
        transcript: Array.isArray(msg.transcript)
          ? msg.transcript.slice(-40).map((l) => ({ role: l?.role === 'assistant' ? 'assistant' : 'user', text: clean(l?.text, 500) }))
          : [],
        device: clean(req.headers['user-agent'], 200),
        createdAt: Date.now(),
        declinedBy: new Set(),
        techId: null
      };
      calls.set(call.id, call);
      stats.escalations++;
      call.ringTimer = setTimeout(() => markMissed(call), cfg.ringTimeoutMs);
      send(ws, { type: 'escalate-result', requestId: msg.requestId, ok: true, callId: call.id });
      for (const t of free) send(t.ws, { type: 'incoming', call: publicCall(call) });
      return broadcastState();
    }

    case 'ai-resolved':
      if (ws.role === 'caller') {
        stats.resolvedByAi++;
        broadcastState();
      }
      return;

    // ---------- both sides
    case 'signal': {
      const call = calls.get(msg.callId);
      if (!call || !msg.data) return;
      const tech = call.techId && techs.get(call.techId);
      if (ws === call.callerWs && tech) send(tech.ws, { type: 'signal', callId: call.id, data: msg.data });
      else if (tech && ws === tech.ws) send(call.callerWs, { type: 'signal', callId: call.id, data: msg.data });
      return;
    }
    case 'call-connected': {
      const call = calls.get(msg.callId);
      if (call && ws === call.callerWs && call.status === 'connecting') {
        call.status = 'live';
        stats.connectedToTech++;
        broadcastState();
      }
      return;
    }
    case 'hangup': {
      const call = calls.get(msg.callId);
      if (!call) return;
      const tech = call.techId && techs.get(call.techId);
      const by = ws === call.callerWs ? 'caller' : tech && ws === tech.ws ? 'tech' : null;
      if (!by) return;
      return endCall(call, by, by === 'caller' ? 'caller-hung-up' : 'technician-hung-up');
    }
  }
}

// keep sockets alive through proxies (Render closes idle connections) and drop dead ones
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(cfg.port, () => {
  console.log(`ISP voice support running on http://localhost:${cfg.port}`);
  if (!HAS_PUBLIC) console.log('  (page files found next to server.js instead of in public/, serving them from there)');
  console.log(`  Caller page:      /`);
  console.log(`  Technician page:  /tech`);
  console.log(`  Booth QR screen:  /booth`);
});

export { server, cfg };
