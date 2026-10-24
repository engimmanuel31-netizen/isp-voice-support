// Caller (visitor) page.
// Flow: mic → Gemini Live over WebSocket (AI agent) → on escalation, close AI leg →
//       WebRTC peer-to-peer to the technician's browser, signalled through our server.
import { Signal, Tones, toast, setLed, addLine, fmtTime, MIC_CONSTRAINTS, makeIceQueue, unlockAudioElement, playStream } from './common.js';
import { GeminiLive } from './gemini-live.js';

const $ = (s) => document.querySelector(s);

const I18N = {
  en: {
    title: 'Internet not working?',
    lede: 'Talk to {assistant}, our voice assistant, in English, Hindi, Kannada or your own language. She walks you through quick fixes, or connects you to our technician.',
    tapToCall: 'Tap to call', connecting: 'Connecting…', listening: 'Listening…', thinking: 'Thinking…',
    speaking: '{assistant} is speaking', waiting: 'Connecting you to a technician…', tech: 'Talking to {tech}',
    ended: 'Call ended. Tap to call again.', mute: 'Mute', unmute: 'Unmute', techBtn: 'Technician', end: 'End call',
    conversation: 'Conversation', empty: 'Your conversation will appear here.',
    micLed: 'Microphone', aiLed: 'Voice assistant', techLed: 'Technician', netLed: 'Connection',
    micDenied: 'Microphone access is blocked. Allow the microphone for this site in your browser settings, then tap call again.',
    noTech: 'No technician is free right now. Keep talking to {assistant}, or visit the help desk at the booth.',
    missed: 'The technician could not answer. Taking you back to {assistant}.',
    techJoined: '{tech} joined the call.', latency: 'Average reply time',
    failed: 'Could not connect. Check your internet and tap call again.', timeLimit: 'Call time limit reached.',
    tapToHear: 'Tap anywhere to hear the call audio.', techLost: 'The connection to the technician dropped.',
    micOff: 'Microphone off. {assistant} can’t hear you.', micOffTech: 'Microphone off. The technician can’t hear you.',
    holdSwitch: 'Noisy room: hold the big button while you talk',
    holdToTalk: 'Hold the button and talk', holdTalking: 'Listening… let go when you finish'
  }
};

// ------------------------------------------------------------- state
let config = { assistantName: 'Nova', ispName: 'NetConnect', maxCallSeconds: 600, iceServers: [] };
const lang = 'en'; // page text language; Nova asks the caller which language to speak
let callerLanguage = ''; // chosen by the caller during the call (set_language)
let phase = 'idle'; // idle | connecting | ai | waiting | tech-connecting | tech | ended
let mic = null;
let ai = null; // GeminiLive session
let tech = null; // { pc, ice }
let callId = null;
let techName = 'Technician';
let transcript = [];
let callStart = 0;
let clock = null;
let limitTimer = null;
let muted = false;
let holdMode = false; // hold-to-talk for very noisy rooms
let holding = false;
try { holdMode = localStorage.getItem('isp-hold') === '1'; } catch {}

// AI turn tracking
let audioCtx = null; // created inside the call tap, reused for every AI session in the call
let modelTurnActive = false;
let turnEndedAt = 0;
const latencies = [];
let userEl = null;
let assistantEl = null;
let transfer = null; // { gotAudio, timer } while handing over to the technician
let hangingUp = false;

const el = {
  key: $('#key'), keyLabel: $('#keyLabel'), mute: $('#muteBtn'), techBtn: $('#techBtn'), end: $('#endBtn'),
  ledMic: $('#ledMic'), ledAi: $('#ledAi'), ledTech: $('#ledTech'), ledNet: $('#ledNet'), ledTime: $('#ledTime'),
  transcript: $('#transcript'), empty: $('#emptyLine'), audio: $('#remote'), latency: $('#latency'), latencyVal: $('#latencyVal'),
  micOff: $('#micOffNote'), hold: $('#holdToggle')
};

const tones = new Tones();

const t = (key, vars = {}) =>
  (I18N[lang][key] || I18N.en[key] || key)
    .replace('{assistant}', config.assistantName)
    .replace('{tech}', vars.tech || techName);

function applyLanguage() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((n) => (n.textContent = t(n.dataset.i18n)));
  el.mute.querySelector('span').textContent = muted ? t('unmute') : t('mute');
  setLabel(currentLabelKey);
}

let currentLabelKey = 'tapToCall';
function setLabel(key) {
  // in hold-to-talk mode, "Listening…" becomes the instruction to hold the button
  if (key === 'listening' && holdMode && phase === 'ai' && !holding) key = 'holdToTalk';
  currentLabelKey = key;
  el.keyLabel.textContent = t(key);
}

function setKey(state, labelKey) {
  el.key.dataset.state = state;
  if (labelKey) setLabel(labelKey);
  const inCall = !['idle', 'ended'].includes(phase);
  el.key.setAttribute('aria-label', inCall ? t('end') : t('tapToCall'));
}

function setPhase(p) {
  phase = p;
  const inCall = !['idle', 'ended'].includes(p);
  el.mute.disabled = !inCall;
  el.end.disabled = !inCall;
  el.techBtn.disabled = p !== 'ai';
  showMicOff();
}

function line(role, text) {
  el.empty.hidden = true;
  return addLine(el.transcript, role, text);
}

// ------------------------------------------------------------- signalling to our server
const sig = new Signal({
  onOpen: () => {
    sig.send({ type: 'caller-hello' });
    setLed(el.ledNet, 'green');
  },
  onClose: () => setLed(el.ledNet, 'red', true),
  onMessage: onServerMessage
});

// ------------------------------------------------------------- start / end
el.key.addEventListener('click', () => {
  if (phase === 'idle' || phase === 'ended') startCall();
  else if (holdMode && phase === 'ai') return; // in hold-to-talk the big button is the talk button
  else endCall();
});

// hold-to-talk: press and hold the big button while speaking
function startHold(e) {
  if (!holdMode || phase !== 'ai' || !ai) return;
  e?.preventDefault?.();
  if (e?.pointerId !== undefined) { try { el.key.setPointerCapture(e.pointerId); } catch {} }
  holding = true;
  ai.holding = true;
  el.key.dataset.holding = '';
  setLabel('holdTalking');
}
function endHold() {
  if (!holding) return;
  holding = false;
  if (ai) ai.holding = false;
  delete el.key.dataset.holding;
  if (phase === 'ai') setLabel(ai?.playing ? 'speaking' : 'thinking');
  // nothing came back (e.g. only noise was heard): show the hold instruction again
  setTimeout(() => {
    if (!holding && phase === 'ai' && !ai?.playing && currentLabelKey === 'thinking') setLabel('listening');
  }, 4000);
}
el.key.addEventListener('pointerdown', startHold);
el.key.addEventListener('pointerup', endHold);
el.key.addEventListener('pointercancel', endHold);
el.key.addEventListener('lostpointercapture', endHold);
el.key.addEventListener('contextmenu', (e) => { if (holdMode && phase === 'ai') e.preventDefault(); });
el.key.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat && holdMode && phase === 'ai') startHold(e); });
el.key.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') endHold(); });

el.hold.checked = holdMode;
el.hold.addEventListener('change', () => {
  holdMode = el.hold.checked;
  try { localStorage.setItem('isp-hold', holdMode ? '1' : '0'); } catch {}
  if (ai) { ai.holdToTalk = holdMode; ai.holding = false; }
  holding = false;
  delete el.key.dataset.holding;
  if (phase === 'ai') setKey(ai?.playing ? 'speaking' : 'listening', ai?.playing ? 'speaking' : 'listening');
});
el.end.addEventListener('click', () => endCall());
el.mute.addEventListener('click', toggleMute);
el.techBtn.addEventListener('click', () => manualEscalation());

async function startCall() {
  tones.unlock();
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC({ latencyHint: 'interactive' });
  }
  audioCtx.resume?.(); // must happen inside the tap for iPhone Safari
  unlockAudioElement(el.audio, audioCtx); // so the technician's voice can play later on iPhone
  transcript = [];
  callerLanguage = '';
  latencies.length = 0;
  el.latency.hidden = true;
  el.transcript.querySelectorAll('.line:not(#emptyLine)').forEach((n) => n.remove());
  el.empty.hidden = false;
  callId = null;
  muted = false;
  holding = false;
  el.mute.setAttribute('aria-pressed', 'false');
  mic?.getAudioTracks().forEach((tr) => (tr.enabled = true));
  applyLanguage();

  setPhase('connecting');
  setKey('connecting', 'connecting');

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return fail('Microphone needs a secure https:// link. Open the https address of this page.');
  }
  try {
    mic = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  } catch (err) {
    console.error(err);
    return fail(t('micDenied'));
  }
  setLed(el.ledMic, 'green');

  callStart = Date.now();
  clock = setInterval(() => (el.ledTime.textContent = fmtTime((Date.now() - callStart) / 1000)), 1000);
  setLed(el.ledTime, 'green');
  limitTimer = setTimeout(() => {
    toast(t('timeLimit'));
    endCall();
  }, config.maxCallSeconds * 1000);

  try {
    await startAI();
  } catch (err) {
    console.error(err);
    fail(err.userMessage || t('failed'));
  }
}

function fail(message) {
  toast(message, 7000);
  line('system', message);
  teardown();
  setKey('error', 'tapToCall');
  setTimeout(() => { if (phase === 'ended') setKey('idle'); }, 2500);
}

function endCall() {
  if (callId && ['waiting', 'tech-connecting', 'tech'].includes(phase)) sig.send({ type: 'hangup', callId });
  teardown();
  setKey('idle', 'ended');
}

function teardown() {
  stopAI();
  stopTech();
  tones.stop();
  clearInterval(clock);
  clearTimeout(limitTimer);
  clearTimeout(transfer?.timer);
  transfer = null;
  hangingUp = false;
  mic?.getTracks().forEach((tr) => tr.stop());
  mic = null;
  callId = null;
  el.audio.srcObject = null;
  ['ledMic', 'ledAi', 'ledTech', 'ledTime'].forEach((k) => setLed(el[k], 'off'));
  setPhase('ended');
}

function toggleMute() {
  muted = !muted;
  mic?.getAudioTracks().forEach((tr) => (tr.enabled = !muted));
  if (ai) ai.muted = muted;
  el.mute.setAttribute('aria-pressed', String(muted));
  el.mute.querySelector('span').textContent = muted ? t('unmute') : t('mute');
  setLed(el.ledMic, muted ? 'red' : 'green');
  showMicOff();
}

function showMicOff() {
  el.micOff.hidden = !muted || ['idle', 'ended'].includes(phase);
  el.micOff.textContent = ['tech', 'tech-connecting', 'waiting'].includes(phase) ? t('micOffTech') : t('micOff');
}

function playRemote(stream) {
  playStream(el.audio, stream, () => toast(t('tapToHear'), 8000));
}

// ------------------------------------------------------------- AI leg (Gemini Live over WebSocket)
async function startAI(resumeCallId = null) {
  setLed(el.ledAi, 'amber', true);
  const r = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resumeCallId })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error || 'session failed');
    e.userMessage = data.error ? `${t('failed')} (${data.error})` : t('failed');
    throw e;
  }

  const session = new GeminiLive(onAIEvent, audioCtx);
  ai = session;
  session.muted = muted;
  session.holdToTalk = holdMode;
  await session.start({ wsUrl: data.wsUrl, setup: data.setup, micStream: mic });
  if (ai !== session) return session.close(); // call ended while connecting

  // Gemini waits for input; this note makes Nova greet the caller first (see prompt.js "Opening")
  session.sendText(data.resumed ? 'The caller is back on the line.' : 'The caller has just joined the call.');
  turnEndedAt = performance.now();

  setPhase('ai');
  setKey('listening', 'listening');
  setLed(el.ledAi, 'green');
}

function stopAI() {
  if (!ai) return;
  ai.close();
  ai = null;
  modelTurnActive = false;
  finalizeUser();
  finalizeAssistant();
  if (phase === 'ai') setLed(el.ledAi, 'off');
}

function finalizeUser() {
  if (!userEl) return;
  const text = (userEl.dataset.text || '').trim();
  if (text) {
    userEl.textContent = text;
    userEl.classList.remove('partial');
    transcript.push({ role: 'user', text });
  } else userEl.remove();
  userEl = null;
}

function finalizeAssistant() {
  if (!assistantEl) return;
  const text = (assistantEl.dataset.text || '').trim();
  if (text) {
    assistantEl.textContent = text;
    assistantEl.classList.remove('partial');
    transcript.push({ role: 'assistant', text });
  } else assistantEl.remove();
  assistantEl = null;
}

function appendTo(current, role, chunk) {
  const n = current || line(role, '');
  n.dataset.text = (n.dataset.text || '') + chunk;
  n.textContent = n.dataset.text;
  n.classList.add('partial');
  el.transcript.scrollTop = el.transcript.scrollHeight;
  return n;
}

function onAIEvent(type, data) {
  switch (type) {
    case 'user-text':
      if (assistantEl && !modelTurnActive) finalizeAssistant();
      userEl = appendTo(userEl, 'user', data);
      if (phase === 'ai' && !ai?.playing) setKey('listening', 'thinking');
      break;

    case 'assistant-text':
      finalizeUser();
      assistantEl = appendTo(assistantEl, 'assistant', data);
      break;

    case 'audio-chunk':
      if (transfer) transfer.gotAudio = true;
      if (!modelTurnActive) {
        modelTurnActive = true;
        finalizeUser();
        // reply time = caller stopped talking -> first sound of the answer
        const since = ai ? performance.now() - ai.lastVoiceAt : 0;
        if (ai && ai.lastVoiceAt > turnEndedAt && since < 6000) {
          latencies.push(since);
          const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length / 1000;
          el.latencyVal.textContent = `${avg.toFixed(2)} s`;
          el.latency.hidden = false;
        }
      }
      break;

    case 'speaking-started':
      if (phase === 'ai') setKey('speaking', 'speaking');
      setLed(el.ledAi, 'blue');
      break;

    case 'speaking-stopped':
      if (phase === 'ai') setKey('listening', 'listening');
      setLed(el.ledAi, phase === 'ai' ? 'green' : 'off');
      break;

    case 'interrupted':
      modelTurnActive = false;
      finalizeAssistant();
      turnEndedAt = performance.now();
      break;

    case 'turn-complete':
      modelTurnActive = false;
      finalizeUser();
      finalizeAssistant();
      turnEndedAt = performance.now();
      if (transfer?.gotAudio) ai?.whenDrained().then(goToWaiting);
      break;

    case 'tool-call':
      for (const fc of data) handleToolCall(fc);
      break;

    case 'closed':
      if (phase === 'ai' && !transfer && !hangingUp) fail(t('failed'));
      break;
  }
}

async function handleToolCall(fc) {
  const args = fc.args || {};
  const reply = (response) => ai?.sendToolResponse([{ id: fc.id, name: fc.name, response }]);

  if (fc.name === 'set_language') {
    const chosen = String(args.language || '').trim().slice(0, 30);
    if (chosen && chosen !== callerLanguage) {
      callerLanguage = chosen;
      line('system', `Language: ${chosen}`);
    }
    reply({ status: 'ok', language: chosen });
  } else if (fc.name === 'escalate_to_technician') {
    setLed(el.ledTech, 'amber', true);
    finalizeUser();
    const res = await requestEscalation(args);
    if (res.ok) {
      callId = res.callId;
      transfer = { gotAudio: false, timer: setTimeout(goToWaiting, 10000) };
      reply({ status: 'transferring', note: 'Technician is being rung. Say one short line asking the caller to stay on the line, then stop.' });
    } else {
      setLed(el.ledTech, 'red');
      setTimeout(() => setLed(el.ledTech, 'off'), 4000);
      reply({ status: 'unavailable', note: 'No technician is free. Apologise and suggest the help desk at the booth; offer to keep helping.' });
    }
  } else if (fc.name === 'end_call') {
    if (args.resolved) sig.send({ type: 'ai-resolved' });
    hangingUp = true;
    reply({ status: 'ok' });
    // let the goodbye finish playing, then hang up
    setTimeout(async () => {
      await ai?.whenDrained(5000);
      finishResolved();
    }, 1500);
  } else {
    reply({ error: `unknown function ${fc.name}` });
  }
}

function finishResolved() {
  hangingUp = false;
  if (phase !== 'ai') return;
  teardown();
  setKey('idle', 'ended');
}

function lastLinesSummary() {
  return transcript.slice(-6).map((l) => `${l.role === 'user' ? 'Caller' : 'AI'}: ${l.text}`).join(' | ');
}

function requestEscalation(args) {
  return sig.request(
    {
      type: 'escalate',
      lang: callerLanguage || 'Not chosen yet',
      reason: args.reason,
      summary: args.summary,
      stepsTried: args.steps_tried,
      customerName: args.customer_name,
      urgency: args.urgency,
      transcript
    },
    6000
  );
}

async function manualEscalation() {
  if (phase !== 'ai') return;
  el.techBtn.disabled = true;
  setLed(el.ledTech, 'amber', true);
  const res = await requestEscalation({
    reason: 'caller_requested_human',
    summary: `Caller pressed the Technician button. Recent conversation: ${lastLinesSummary() || 'none yet'}`
  });
  if (!res.ok) {
    setLed(el.ledTech, 'off');
    el.techBtn.disabled = phase !== 'ai';
    toast(t('noTech'), 6000);
    return;
  }
  callId = res.callId;
  goToWaiting();
}

// ------------------------------------------------------------- hand-off to technician
function goToWaiting() {
  if (!callId || !['ai', 'connecting'].includes(phase)) return;
  clearTimeout(transfer?.timer);
  transfer = null;
  stopAI();
  setLed(el.ledAi, 'off');
  setLed(el.ledTech, 'amber', true);
  setPhase('waiting');
  setKey('waiting', 'waiting');
  line('system', t('waiting'));
  tones.hold();
}

function onServerMessage(msg) {
  switch (msg.type) {
    case 'tech-accepted':
      if (msg.callId !== callId) return;
      techName = msg.techName || 'Technician';
      // the technician may answer while the AI is still saying "please hold"
      if (phase === 'ai') {
        clearTimeout(transfer?.timer);
        transfer = null;
        stopAI();
      }
      startTechCall();
      break;

    case 'tech-missed':
      if (msg.callId !== callId) return;
      handleMissed(msg.callId);
      break;

    case 'signal':
      if (msg.callId === callId && tech) onTechSignal(msg.data);
      break;

    case 'call-ended':
      if (msg.callId !== callId) return;
      if (msg.reason === 'technician-disconnected' && phase !== 'tech') return handleMissed(msg.callId);
      line('system', msg.reason === 'technician-hung-up' ? t('ended') : t('techLost'));
      teardown();
      setKey('idle', 'ended');
      break;
  }
}

async function handleMissed(missedId) {
  tones.stop();
  stopTech();
  stopAI();
  clearTimeout(transfer?.timer);
  transfer = null;
  setLed(el.ledTech, 'red');
  line('system', t('missed'));
  callId = null;
  if (!mic) return;
  setPhase('connecting');
  setKey('connecting', 'connecting');
  try {
    await startAI(missedId);
  } catch (err) {
    console.error(err);
    fail(t('failed'));
  }
}

async function startTechCall() {
  tones.stop();
  setPhase('tech-connecting');
  setKey('connecting', 'connecting');

  const pc = new RTCPeerConnection({ iceServers: config.iceServers });
  const ice = makeIceQueue(pc);
  tech = { pc, ice };

  mic.getAudioTracks().forEach((tr) => pc.addTrack(tr, mic));
  pc.ontrack = (e) => playRemote(e.streams[0]);
  pc.onicecandidate = (e) => {
    if (e.candidate) sig.send({ type: 'signal', callId, data: { candidate: e.candidate.toJSON() } });
  };
  pc.onconnectionstatechange = () => {
    if (tech?.pc !== pc) return;
    const s = pc.connectionState;
    if (s === 'connected' && phase !== 'tech') {
      setPhase('tech');
      setKey('tech', 'tech');
      setLed(el.ledTech, 'green');
      line('system', t('techJoined'));
      sig.send({ type: 'call-connected', callId });
    } else if (s === 'failed') {
      line('system', t('techLost'));
      sig.send({ type: 'hangup', callId });
      teardown();
      setKey('error', 'ended');
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sig.send({ type: 'signal', callId, data: { sdp: pc.localDescription.toJSON() } });
}

async function onTechSignal(data) {
  const { pc, ice } = tech;
  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    await ice.flush();
  } else if (data.candidate) {
    await ice.add(data.candidate);
  }
}

function stopTech() {
  if (!tech) return;
  try { tech.pc.close(); } catch {}
  tech = null;
}

// ------------------------------------------------------------- boot
(async function boot() {
  try {
    config = { ...config, ...(await (await fetch('/api/config')).json()) };
  } catch (e) {
    console.warn('config failed', e);
  }
  document.getElementById('ispName').textContent = config.ispName;
  document.title = `${config.ispName} Help Line`;
  setPhase('idle');
  applyLanguage();
})();
