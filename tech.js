// Technician console: rings on escalations, answers with one tap, receives the caller's WebRTC audio.
import { Signal, Tones, toast, setLed, addLine, fmtTime, MIC_CONSTRAINTS, makeIceQueue } from './common.js';

const $ = (s) => document.querySelector(s);

const REASONS = {
  caller_requested_human: 'Asked for a technician',
  los_red_fiber_fault: 'Fibre signal loss (LOS red)',
  no_power_hardware: 'Device has no power',
  physical_damage_or_safety: 'Damage or safety risk',
  troubleshooting_exhausted: "Basic fixes didn't work",
  billing_or_account: 'Billing or account',
  caller_frustrated: 'Caller is upset',
  out_of_scope: 'Outside basic support'
};
const LANGS = { en: 'English', hi: 'Hindi', kn: 'Kannada' };

let config = { iceServers: [], ispName: 'NetConnect' };
let sig = null;
let me = { name: '', pin: '' };
let mic = null;
let queue = [];
let active = null; // { call, pc, ice, startedAt, timer }
let wakeLock = null;
let muted = false;
const tones = new Tones();

const el = {
  loginView: $('#loginView'), consoleView: $('#consoleView'), loginForm: $('#loginForm'), loginError: $('#loginError'),
  name: $('#nameInput'), pin: $('#pinInput'), online: $('#onlineToggle'), onlineLabel: $('#onlineLabel'),
  ledServer: $('#ledServer'), queue: $('#queue'), techsOnline: $('#techsOnline'),
  ringBanner: $('#ringBanner'), ringText: $('#ringText'), ringAnswer: $('#ringAnswer'),
  liveEmpty: $('#liveEmpty'), liveCall: $('#liveCall'), ledCall: $('#ledCall'), timer: $('#timer'),
  fReason: $('#fReason'), fSummary: $('#fSummary'), fSteps: $('#fSteps'), fLang: $('#fLang'), fName: $('#fName'), fDevice: $('#fDevice'),
  liveTranscript: $('#liveTranscript'), mute: $('#techMute'), end: $('#techEnd'), audio: $('#techAudio'),
  sAi: $('#sAi'), sResolved: $('#sResolved'), sEsc: $('#sEsc'), sMissed: $('#sMissed')
};

// ------------------------------------------------------------- login
try {
  el.name.value = localStorage.getItem('tech-name') || '';
} catch {}

el.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  el.loginError.textContent = '';
  tones.unlock(); // inside the tap, so ringing works later (iOS)
  el.audio.play().catch(() => {});
  me = { name: el.name.value.trim() || 'Technician', pin: el.pin.value };
  try { localStorage.setItem('tech-name', me.name); } catch {}

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    el.loginError.textContent = 'The microphone needs a secure https:// link. Open the https address of this page.';
    return;
  }
  try {
    mic = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    mic.getAudioTracks().forEach((tr) => (tr.enabled = false)); // silent until a call is answered
  } catch {
    el.loginError.textContent = 'Microphone access is blocked. Allow it for this site in your browser settings, then try again.';
    return;
  }
  connect();
});

function connect() {
  sig?.close?.();
  sig = new Signal({
    onOpen: () => {
      setLed(el.ledServer, 'green');
      sig.send({ type: 'tech-login', pin: me.pin, name: me.name, online: el.online.checked });
    },
    onClose: () => setLed(el.ledServer, 'red', true),
    onMessage
  });
}

el.online.addEventListener('change', () => {
  el.onlineLabel.textContent = el.online.checked ? 'Online' : 'Away';
  sig?.send({ type: 'tech-status', online: el.online.checked });
  if (!el.online.checked) stopRinging();
});

$('#logoutBtn').addEventListener('click', () => location.reload());

async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && el.consoleView.hidden === false) keepAwake();
});

// ------------------------------------------------------------- server messages
function onMessage(msg) {
  switch (msg.type) {
    case 'tech-denied':
      sig.closedByUser = true;
      sig.ws.close();
      el.consoleView.hidden = true;
      el.loginView.hidden = false;
      el.loginError.textContent = 'That PIN is not correct.';
      mic?.getTracks().forEach((t) => t.stop());
      break;

    case 'tech-ok':
      el.loginView.hidden = true;
      el.consoleView.hidden = false;
      $('#consoleTitle').textContent = `${config.ispName} technician: ${me.name}`;
      keepAwake();
      break;

    case 'state':
      queue = msg.queue || [];
      renderQueue();
      renderStats(msg.stats || {});
      el.techsOnline.textContent = `${msg.techsOnline || 0} technician${msg.techsOnline === 1 ? '' : 's'} online`;
      updateRinging();
      break;

    case 'incoming':
      if (!queue.find((c) => c.id === msg.call.id)) queue.push(msg.call);
      renderQueue();
      updateRinging();
      notify(msg.call);
      break;

    case 'call-cancelled':
    case 'call-taken':
      queue = queue.filter((c) => c.id !== msg.callId);
      renderQueue();
      updateRinging();
      break;

    case 'accepted':
      beginCall(msg.call);
      break;

    case 'accept-failed':
      toast(msg.reason === 'taken' ? 'Another technician answered that call.' : 'That caller is no longer waiting.');
      queue = queue.filter((c) => c.id !== msg.callId);
      renderQueue();
      updateRinging();
      break;

    case 'signal':
      if (active && msg.callId === active.call.id) onSignal(msg.data);
      break;

    case 'call-ended':
      if (active && msg.callId === active.call.id) {
        toast(msg.reason === 'caller-hung-up' ? 'The caller hung up.' : 'The call ended.');
        finishCall(false);
      }
      break;
  }
}

function renderStats(s) {
  el.sAi.textContent = s.aiSessions ?? 0;
  el.sResolved.textContent = s.resolvedByAi ?? 0;
  el.sEsc.textContent = s.escalations ?? 0;
  el.sMissed.textContent = s.missed ?? 0;
}

function waitingFor(call) {
  return fmtTime((Date.now() - call.createdAt) / 1000);
}

function renderQueue() {
  el.queue.replaceChildren();
  if (!queue.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = "Nobody is waiting. When the voice assistant can't solve a problem, the caller rings here.";
    el.queue.append(p);
    return;
  }
  for (const call of queue) {
    const item = document.createElement('article');
    item.className = `qitem${call.urgency === 'high' ? ' high' : ''}`;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = '<span class="who"></span><span class="wait"></span>';
    meta.querySelector('.who').textContent = `${call.customerName || 'Visitor'}, ${LANGS[call.lang] || call.lang}`;
    meta.querySelector('.wait').textContent = `waiting ${waitingFor(call)}`;
    meta.querySelector('.wait').dataset.since = call.createdAt;

    const reason = document.createElement('div');
    reason.className = 'reason';
    reason.textContent = (call.urgency === 'high' ? 'Urgent: ' : '') + (REASONS[call.reason] || call.reason);

    const summary = document.createElement('div');
    summary.className = 'small';
    summary.textContent = call.summary;

    const actions = document.createElement('div');
    actions.className = 'actions';
    const answer = document.createElement('button');
    answer.className = 'btn btn-go';
    answer.textContent = 'Answer';
    answer.disabled = Boolean(active);
    answer.onclick = () => accept(call.id);
    const decline = document.createElement('button');
    decline.className = 'btn';
    decline.textContent = 'Decline';
    decline.onclick = () => {
      sig.send({ type: 'decline', callId: call.id });
      queue = queue.filter((c) => c.id !== call.id);
      renderQueue();
      updateRinging();
    };
    actions.append(answer, decline);

    item.append(meta, reason, summary, actions);
    el.queue.append(item);
  }
}
setInterval(() => {
  document.querySelectorAll('.wait[data-since]').forEach((n) => (n.textContent = `waiting ${fmtTime((Date.now() - Number(n.dataset.since)) / 1000)}`));
}, 1000);

function updateRinging() {
  const ringing = !active && el.online.checked && queue.length > 0;
  el.ringBanner.hidden = !ringing;
  if (ringing) {
    const c = queue[0];
    el.ringText.textContent = `Incoming call: ${REASONS[c.reason] || c.reason}`;
    el.ringAnswer.onclick = () => accept(c.id);
    if (!tones.timer) tones.ring();
  } else stopRinging();
}

function stopRinging() {
  tones.stop();
  el.ringBanner.hidden = true;
}

function notify(call) {
  if (document.visibilityState === 'visible' || !('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    try { new Notification('Incoming support call', { body: REASONS[call.reason] || call.summary }); } catch {}
  }
}

// ------------------------------------------------------------- answering
function accept(callId) {
  if (active) return;
  tones.unlock();
  el.audio.play().catch(() => {});
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  sig.send({ type: 'accept', callId });
}

async function ensureMic() {
  const live = mic?.getAudioTracks().some((t) => t.readyState === 'live');
  if (!live) mic = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  mic.getAudioTracks().forEach((t) => (t.enabled = !muted));
  return mic;
}

async function beginCall(call) {
  stopRinging();
  queue = queue.filter((c) => c.id !== call.id);
  renderQueue();

  const pc = new RTCPeerConnection({ iceServers: config.iceServers });
  active = { call, pc, ice: makeIceQueue(pc), startedAt: 0, timer: null };

  try {
    const stream = await ensureMic();
    stream.getAudioTracks().forEach((t) => pc.addTrack(t, stream));
  } catch {
    toast('Microphone unavailable. Allow it and answer again.');
    sig.send({ type: 'hangup', callId: call.id });
    return finishCall(false);
  }

  pc.ontrack = (e) => {
    el.audio.srcObject = e.streams[0];
    el.audio.play().catch(() => toast('Tap anywhere to hear the caller.'));
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) sig.send({ type: 'signal', callId: call.id, data: { candidate: e.candidate.toJSON() } });
  };
  pc.onconnectionstatechange = () => {
    if (active?.pc !== pc) return;
    if (pc.connectionState === 'connected' && !active.startedAt) {
      active.startedAt = Date.now();
      setLed(el.ledCall, 'green');
      el.ledCall.textContent = 'Connected to caller';
      active.timer = setInterval(() => (el.timer.textContent = fmtTime((Date.now() - active.startedAt) / 1000)), 1000);
    } else if (pc.connectionState === 'failed') {
      toast('Audio connection failed. If this keeps happening, add a TURN server (see README).', 7000);
      sig.send({ type: 'hangup', callId: call.id });
      finishCall(false);
    }
  };

  showCall(call);
}

async function onSignal(data) {
  const { pc, ice } = active;
  try {
    if (data.sdp && data.sdp.type === 'offer') {
      await pc.setRemoteDescription(data.sdp);
      await ice.flush();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sig.send({ type: 'signal', callId: active.call.id, data: { sdp: pc.localDescription.toJSON() } });
    } else if (data.candidate) {
      await ice.add(data.candidate);
    }
  } catch (err) {
    console.error('signal error', err);
  }
}

function showCall(call) {
  el.liveEmpty.hidden = true;
  el.liveCall.hidden = false;
  setLed(el.ledCall, 'amber', true);
  el.ledCall.textContent = 'Connecting audio…';
  el.timer.textContent = '0:00';
  el.fReason.textContent = (call.urgency === 'high' ? 'Urgent: ' : '') + (REASONS[call.reason] || call.reason);
  el.fSummary.textContent = call.summary;
  el.fSteps.replaceChildren();
  if (call.stepsTried?.length) {
    const ul = document.createElement('ul');
    ul.className = 'steps';
    call.stepsTried.forEach((s) => { const li = document.createElement('li'); li.textContent = s; ul.append(li); });
    el.fSteps.append(ul);
  } else el.fSteps.textContent = 'Not recorded';
  el.fLang.textContent = LANGS[call.lang] || call.lang;
  el.fName.textContent = call.customerName || 'Not given';
  el.fDevice.textContent = describeDevice(call.device);
  el.liveTranscript.replaceChildren();
  for (const l of call.transcript || []) addLine(el.liveTranscript, l.role === 'assistant' ? 'assistant' : 'user', l.text);
  if (!call.transcript?.length) addLine(el.liveTranscript, 'system', 'No transcript from the assistant.');
  muted = false;
  el.mute.setAttribute('aria-pressed', 'false');
  el.mute.textContent = 'Mute';
}

function describeDevice(ua = '') {
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Other';
  const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os}, ${br}`;
}

el.mute.addEventListener('click', () => {
  muted = !muted;
  mic?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  el.mute.setAttribute('aria-pressed', String(muted));
  el.mute.textContent = muted ? 'Unmute' : 'Mute';
});

el.end.addEventListener('click', () => {
  if (active) sig.send({ type: 'hangup', callId: active.call.id });
  finishCall(true);
});

function finishCall() {
  if (active) {
    clearInterval(active.timer);
    try { active.pc.close(); } catch {}
  }
  active = null;
  el.audio.srcObject = null;
  mic?.getAudioTracks().forEach((t) => (t.enabled = false));
  el.liveCall.hidden = true;
  el.liveEmpty.hidden = false;
  renderQueue();
  updateRinging();
}

// Light HTTP ping so free hosting plans don't put the server to sleep while the technician is on duty
setInterval(() => {
  if (!el.consoleView.hidden) fetch('/api/health', { cache: 'no-store' }).catch(() => {});
}, 4 * 60_000);

// ------------------------------------------------------------- boot
(async () => {
  try { config = { ...config, ...(await (await fetch('/api/config')).json()) }; } catch {}
  document.title = `${config.ispName} Technician Console`;
})();
