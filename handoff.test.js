// End-to-end test of the escalation and hand-off signalling (no Gemini key needed).
// Starts the server, logs in a technician, escalates a caller, accepts, relays SDP/ICE, hangs up,
// and checks the "no technician" and "technician missed" paths.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = 3999;
const base = `http://localhost:${PORT}`;
const srv = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), TECH_PIN: '4321', RING_TIMEOUT_SECONDS: '2', GEMINI_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe']
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else inbox.push(m);
  });
  return {
    ws,
    ready: new Promise((r) => ws.on('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    next(type, extra = () => true, timeout = 4000) {
      const pred = (m) => m.type === type && extra(m);
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeout);
      });
    }
  };
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error('server did not start');
}

let failed = false;
try {
  await waitForServer();

  // static pages and config
  for (const p of ['/', '/tech', '/booth', '/caller.js', '/tech.js', '/common.js', '/style.css']) {
    assert.equal((await fetch(base + p)).status, 200, `GET ${p}`);
  }
  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.ok(cfg.iceServers.length >= 1);
  assert.deepEqual(Object.keys(cfg.languages), ['en', 'hi', 'kn']);
  const sess = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"lang":"kn"}' });
  assert.equal(sess.status, 503, 'session without key returns 503');
  console.log('ok  pages, config, session guard');

  // 1. escalation with no technician online
  const caller = client();
  await caller.ready;
  caller.send({ type: 'caller-hello' });
  await caller.next('hello-ok');
  caller.send({ type: 'escalate', requestId: 'r1', reason: 'los_red_fiber_fault', summary: 'x', lang: 'hi' });
  const r1 = await caller.next('escalate-result');
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'no-technician');
  console.log('ok  no technician online -> unavailable');

  // 2. wrong PIN, then right PIN
  const bad = client();
  await bad.ready;
  bad.send({ type: 'tech-login', pin: '0000', name: 'Evil' });
  await bad.next('tech-denied');
  const tech = client();
  await tech.ready;
  tech.send({ type: 'tech-login', pin: '4321', name: 'Amit' });
  await tech.next('tech-ok');
  console.log('ok  technician PIN check');

  // 3. escalate -> ring -> accept -> signal relay -> connected -> hangup
  caller.send({
    type: 'escalate', requestId: 'r2', reason: 'los_red_fiber_fault', lang: 'kn', urgency: 'high',
    summary: 'LOS red after reseating fibre.', stepsTried: ['Checked lights', 'Reseated fibre'],
    transcript: [{ role: 'user', text: 'LOS is red' }, { role: 'assistant', text: 'Connecting you' }]
  });
  const r2 = await caller.next('escalate-result');
  assert.equal(r2.ok, true);
  const inc = await tech.next('incoming');
  assert.equal(inc.call.id, r2.callId);
  assert.equal(inc.call.urgency, 'high');
  assert.equal(inc.call.transcript.length, 2);
  tech.send({ type: 'accept', callId: r2.callId });
  const acc = await tech.next('accepted');
  assert.equal(acc.call.id, r2.callId);
  const ta = await caller.next('tech-accepted');
  assert.equal(ta.techName, 'Amit');

  caller.send({ type: 'signal', callId: r2.callId, data: { sdp: { type: 'offer', sdp: 'v=0 fake-offer' } } });
  const offer = await tech.next('signal');
  assert.equal(offer.data.sdp.type, 'offer');
  tech.send({ type: 'signal', callId: r2.callId, data: { sdp: { type: 'answer', sdp: 'v=0 fake-answer' } } });
  const answer = await caller.next('signal');
  assert.equal(answer.data.sdp.type, 'answer');
  tech.send({ type: 'signal', callId: r2.callId, data: { candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host' } } });
  assert.ok((await caller.next('signal')).data.candidate);

  caller.send({ type: 'call-connected', callId: r2.callId });
  const st = await tech.next('state', (m) => m.stats.connectedToTech === 1);
  assert.equal(st.stats.escalations, 1);

  // a second caller cannot reach the busy technician
  const caller2 = client();
  await caller2.ready;
  caller2.send({ type: 'caller-hello' });
  await caller2.next('hello-ok');
  caller2.send({ type: 'escalate', requestId: 'r3', reason: 'out_of_scope', summary: 'y' });
  assert.equal((await caller2.next('escalate-result')).ok, false);

  tech.send({ type: 'hangup', callId: r2.callId });
  const ended = await caller.next('call-ended');
  assert.equal(ended.reason, 'technician-hung-up');
  console.log('ok  ring, accept, SDP + ICE relay, busy technician, hang-up');

  // 4. technician does not answer -> missed
  caller2.send({ type: 'escalate', requestId: 'r4', reason: 'troubleshooting_exhausted', summary: 'Slow speeds.' });
  const r4 = await caller2.next('escalate-result');
  assert.equal(r4.ok, true);
  await tech.next('incoming');
  const missed = await caller2.next('tech-missed', () => true, 5000);
  assert.equal(missed.callId, r4.callId);
  await tech.next('call-cancelled', (m) => m.callId === r4.callId);
  console.log('ok  ring timeout -> missed -> caller returns to AI');

  // 5. decline by the only technician -> missed straight away
  caller2.send({ type: 'escalate', requestId: 'r5', reason: 'billing_or_account', summary: 'Bill query.' });
  const r5 = await caller2.next('escalate-result');
  await tech.next('incoming');
  tech.send({ type: 'decline', callId: r5.callId });
  await caller2.next('tech-missed', (m) => m.callId === r5.callId, 1500);
  console.log('ok  decline by every technician -> missed');

  // 6. caller disconnects while ringing -> technician sees cancel
  const caller3 = client();
  await caller3.ready;
  caller3.send({ type: 'caller-hello' });
  await caller3.next('hello-ok');
  caller3.send({ type: 'escalate', requestId: 'r6', reason: 'out_of_scope', summary: 'z' });
  const r6 = await caller3.next('escalate-result');
  await tech.next('incoming', (m) => m.call.id === r6.callId);
  caller3.ws.close();
  await tech.next('call-cancelled', (m) => m.callId === r6.callId);
  console.log('ok  caller leaves while ringing -> cancelled');

  console.log('\nAll hand-off tests passed.');
  for (const c of [caller, caller2, tech, bad]) c.ws.close();
} catch (err) {
  failed = true;
  console.error('FAIL', err);
} finally {
  srv.kill();
  process.exit(failed ? 1 : 0);
}
