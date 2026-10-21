// Caller (visitor) page.
// Flow: mic → Gemini Live over WebSocket (AI agent) → on escalation, close AI leg →
//       WebRTC peer-to-peer to the technician's browser, signalled through our server.
import { Signal, Tones, toast, setLed, addLine, fmtTime, MIC_CONSTRAINTS, makeIceQueue } from './common.js';
import { GeminiLive } from './gemini-live.js';

const $ = (s) => document.querySelector(s);

const I18N = {
  en: {
    title: 'Internet not working?',
    lede: 'Talk to {assistant}, our voice assistant. She walks you through quick fixes, or connects you to our technician.',
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
    tapToHear: 'Tap anywhere to hear the call audio.', techLost: 'The connection to the technician dropped.'
  },
  hi: {
    title: 'इंटरनेट नहीं चल रहा?',
    lede: 'हमारी वॉइस असिस्टेंट {assistant} से बात करें। वो आसान उपाय बताएगी, या टेक्नीशियन से जोड़ देगी।',
    tapToCall: 'कॉल करने के लिए दबाएँ', connecting: 'कनेक्ट हो रहा है…', listening: 'सुन रही है…', thinking: 'सोच रही है…',
    speaking: '{assistant} बोल रही है', waiting: 'आपको टेक्नीशियन से जोड़ रहे हैं…', tech: '{tech} से बात हो रही है',
    ended: 'कॉल खत्म हुई। फिर से कॉल करने के लिए दबाएँ।', mute: 'म्यूट', unmute: 'अनम्यूट', techBtn: 'टेक्नीशियन', end: 'कॉल खत्म करें',
    conversation: 'बातचीत', empty: 'आपकी बातचीत यहाँ दिखेगी।',
    micLed: 'माइक', aiLed: 'वॉइस असिस्टेंट', techLed: 'टेक्नीशियन', netLed: 'कनेक्शन',
    micDenied: 'माइक की अनुमति नहीं मिली। ब्राउज़र सेटिंग में इस साइट के लिए माइक चालू करें और फिर से कॉल करें।',
    noTech: 'अभी कोई टेक्नीशियन खाली नहीं है। {assistant} से बात जारी रखें, या बूथ के हेल्प डेस्क पर आएँ।',
    missed: 'टेक्नीशियन ने कॉल नहीं उठाई। आपको वापस {assistant} से जोड़ रहे हैं।',
    techJoined: '{tech} कॉल से जुड़ गए।', latency: 'औसत जवाब समय',
    failed: 'कनेक्ट नहीं हो पाया। इंटरनेट जाँचें और फिर से कॉल करें।', timeLimit: 'कॉल का समय पूरा हुआ।',
    tapToHear: 'आवाज़ सुनने के लिए स्क्रीन पर कहीं भी दबाएँ।', techLost: 'टेक्नीशियन से कनेक्शन टूट गया।'
  },
  kn: {
    title: 'ಇಂಟರ್ನೆಟ್ ಕೆಲಸ ಮಾಡ್ತಿಲ್ವಾ?',
    lede: 'ನಮ್ಮ ವಾಯ್ಸ್ ಅಸಿಸ್ಟೆಂಟ್ {assistant} ಜೊತೆ ಮಾತಾಡಿ. ಸುಲಭ ಪರಿಹಾರ ಹೇಳ್ತಾರೆ, ಬೇಕಾದರೆ ಟೆಕ್ನಿಷಿಯನ್‌ಗೆ ಕನೆಕ್ಟ್ ಮಾಡ್ತಾರೆ.',
    tapToCall: 'ಕರೆ ಮಾಡಲು ಒತ್ತಿ', connecting: 'ಕನೆಕ್ಟ್ ಆಗ್ತಿದೆ…', listening: 'ಕೇಳುತ್ತಿದೆ…', thinking: 'ಯೋಚಿಸುತ್ತಿದೆ…',
    speaking: '{assistant} ಮಾತಾಡ್ತಿದ್ದಾರೆ', waiting: 'ಟೆಕ್ನಿಷಿಯನ್‌ಗೆ ಕನೆಕ್ಟ್ ಮಾಡ್ತಿದ್ದೀವಿ…', tech: '{tech} ಜೊತೆ ಮಾತಾಡ್ತಿದ್ದೀರಿ',
    ended: 'ಕರೆ ಮುಗಿಯಿತು. ಮತ್ತೆ ಕರೆ ಮಾಡಲು ಒತ್ತಿ.', mute: 'ಮ್ಯೂಟ್', unmute: 'ಅನ್‌ಮ್ಯೂಟ್', techBtn: 'ಟೆಕ್ನಿಷಿಯನ್', end: 'ಕರೆ ಮುಗಿಸಿ',
    conversation: 'ಸಂಭಾಷಣೆ', empty: 'ನಿಮ್ಮ ಸಂಭಾಷಣೆ ಇಲ್ಲಿ ಕಾಣಿಸುತ್ತದೆ.',
    micLed: 'ಮೈಕ್', aiLed: 'ವಾಯ್ಸ್ ಅಸಿಸ್ಟೆಂಟ್', techLed: 'ಟೆಕ್ನಿಷಿಯನ್', netLed: 'ಕನೆಕ್ಷನ್',
    micDenied: 'ಮೈಕ್ ಅನುಮತಿ ಸಿಗಲಿಲ್ಲ. ಬ್ರೌಸರ್ ಸೆಟ್ಟಿಂಗ್ಸ್‌ನಲ್ಲಿ ಈ ಸೈಟ್‌ಗೆ ಮೈಕ್ ಅನುಮತಿಸಿ, ಮತ್ತೆ ಕರೆ ಮಾಡಿ.',
    noTech: 'ಈಗ ಯಾವ ಟೆಕ್ನಿಷಿಯನ್ ಕೂಡ ಫ್ರೀ ಇಲ್ಲ. {assistant} ಜೊತೆ ಮುಂದುವರಿಸಿ, ಅಥವಾ ಬೂತ್‌ನ ಹೆಲ್ಪ್ ಡೆಸ್ಕ್‌ಗೆ ಬನ್ನಿ.',
    missed: 'ಟೆಕ್ನಿಷಿಯನ್ ಕರೆ ತೆಗೆಯಲಿಲ್ಲ. ಮತ್ತೆ {assistant} ಜೊತೆ ಕನೆಕ್ಟ್ ಮಾಡ್ತಿದ್ದೀವಿ.',
    techJoined: '{tech} ಕರೆಗೆ ಸೇರಿದರು.', latency: 'ಸರಾಸರಿ ಉತ್ತರ ಸಮಯ',
    failed: 'ಕನೆಕ್ಟ್ ಆಗಲಿಲ್ಲ. ಇಂಟರ್ನೆಟ್ ಪರಿಶೀಲಿಸಿ, ಮತ್ತೆ ಕರೆ ಮಾಡಿ.', timeLimit: 'ಕರೆಯ ಸಮಯ ಮುಗಿಯಿತು.',
    tapToHear: 'ಧ್ವನಿ ಕೇಳಲು ಸ್ಕ್ರೀನ್ ಮೇಲೆ ಎಲ್ಲಾದರೂ ಒತ್ತಿ.', techLost: 'ಟೆಕ್ನಿಷಿಯನ್ ಜೊತೆ ಕನೆಕ್ಷನ್ ಕಡಿತಗೊಂಡಿತು.'
  }
};

// ------------------------------------------------------------- state
let config = { assistantName: 'Asha', ispName: 'NetConnect', maxCallSeconds: 600, iceServers: [] };
let lang = 'en';
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
  transcript: $('#transcript'), empty: $('#emptyLine'), audio: $('#remote'), latency: $('#latency'), latencyVal: $('#latencyVal')
};

const tones = new Tones();

const t = (key, vars = {}) =>
  (I18N[lang][key] || I18N.en[key] || key)
    .replace('{assistant}', config.assistantName)
    .replace('{tech}', vars.tech || techName);

function applyLanguage() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((n) => (n.textContent = t(n.dataset.i18n)));
  document.querySelectorAll('.lang button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  el.mute.querySelector('span').textContent = muted ? t('unmute') : t('mute');
  setLabel(currentLabelKey);
}

let currentLabelKey = 'tapToCall';
function setLabel(key) {
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
  document.querySelectorAll('.lang button').forEach((b) => (b.disabled = inCall));
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
  else endCall();
});
el.end.addEventListener('click', () => endCall());
el.mute.addEventListener('click', toggleMute);
el.techBtn.addEventListener('click', () => manualEscalation());
document.querySelectorAll('.lang button').forEach((b) =>
  b.addEventListener('click', () => {
    lang = b.dataset.lang;
    try { localStorage.setItem('isp-lang', lang); } catch {}
    applyLanguage();
  })
);

async function startCall() {
  tones.unlock();
  el.audio.play().catch(() => {}); // unlock autoplay inside the tap (iOS)
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC({ latencyHint: 'interactive' });
  }
  audioCtx.resume?.(); // must happen inside the tap for iPhone Safari
  transcript = [];
  latencies.length = 0;
  el.latency.hidden = true;
  el.transcript.querySelectorAll('.line:not(#emptyLine)').forEach((n) => n.remove());
  el.empty.hidden = false;
  callId = null;
  muted = false;
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
}

function playRemote(stream) {
  el.audio.srcObject = stream;
  el.audio.play().catch(() => {
    toast(t('tapToHear'), 8000);
    document.addEventListener('pointerdown', () => el.audio.play().catch(() => {}), { once: true });
  });
}

// ------------------------------------------------------------- AI leg (Gemini Live over WebSocket)
async function startAI(resumeCallId = null) {
  setLed(el.ledAi, 'amber', true);
  const r = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lang, resumeCallId })
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
  await session.start({ wsUrl: data.wsUrl, setup: data.setup, micStream: mic });
  if (ai !== session) return session.close(); // call ended while connecting

  // Gemini waits for input; this note makes Asha greet the caller first (see prompt.js "Opening")
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

  if (fc.name === 'escalate_to_technician') {
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
      lang,
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
  try { lang = localStorage.getItem('isp-lang') || 'en'; } catch {}
  if (!I18N[lang]) lang = 'en';
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
