# ISP Voice Support (exhibition booth app)

A browser-based voice help line for an Internet Service Provider. Visitors scan a QR code, pick English, Hindi or Kannada, and talk to an AI assistant that walks them through Level 1 router and Wi-Fi fixes. If the AI can't solve it, the live call is handed to the on-site technician's phone or laptop browser. No app download, no SIM, no phone number, and the AI runs on Google Gemini's free plan.

| Page | Who uses it | What it does |
|---|---|---|
| `/` | Visitors | Language choice, one-tap call, live transcript, mute, "Technician" button, reply-time meter |
| `/tech` | Technician | PIN login, rings on escalation, one-tap answer, AI summary + transcript, mute, end call, booth stats |
| `/booth` | Booth screen or TV | Large QR code that opens the caller page |

---

## 1. Architecture

```
                       ┌────────────────────────────────────────────┐
                       │  Node.js server (server.js)                │
   1. POST /api/session│  • holds the Gemini API key                │
  ┌───────────────────▶│  • mints a one-use Gemini token + setup    │◀──────────────┐
  │   ◀── token, setup │  • WebSocket /ws: rings technician,        │  tech-login,  │
  │                    │    relays WebRTC offer/answer/ICE          │  accept, ...  │
  │   escalate (WS) ──▶│  • call queue, timeouts, stats             │               │
  │                    └────────────────────────────────────────────┘               │
┌─┴──────────────┐  2. WebSocket: 16 kHz mic audio up,  ┌──────────────────────┐ ┌────┴───────────────┐
│ Visitor phone  │     24 kHz voice + transcripts down  │ Gemini Live API      │ │ Technician phone / │
│ or laptop      │◀────────────────────────────────────▶│ (gemini-3.8-live,    │ │ laptop browser     │
│ browser        │     function calls (escalate, end)   │  free plan)          │ │                    │
│                │                                      └──────────────────────┘ │                    │
│                │  3. after hand-off: direct peer-to-peer WebRTC audio           │                    │
│                │◀──────────────────────────────────────────────────────────────▶│                    │
└────────────────┘        (STUN; TURN relay only if a network blocks P2P)         └────────────────────┘
```

**Design choices**

- **One speech-to-speech model.** Gemini Live listens to audio and answers with audio in a single step, without separate speech-to-text, AI and text-to-speech services chained together. That keeps replies fast and natural. Transcripts arrive alongside for the screen and the technician.
- **Browser talks straight to Gemini.** The server only hands out a one-use token that must be used within one minute, plus the setup message (prompt and tools). Audio never passes through your free server, and the real API key never reaches the browser.
- **Browser handles the audio itself.** An AudioWorklet turns the microphone into 16 kHz PCM chunks every 40 ms, and Gemini's 24 kHz voice chunks are queued gap-free with Web Audio. While Asha is talking, quiet sound (her own echo from the speaker) is replaced with silence so she doesn't interrupt herself, but a caller speaking up still interrupts her.
- **Technician leg is free peer-to-peer WebRTC.** Once the technician answers, the caller's browser closes the Gemini session and opens a direct audio link to the technician. The server relays only a few small signalling messages.

### Hand-off sequence

1. The AI decides an escalation trigger is met, says "I'll connect you to our technician now", and calls the function `escalate_to_technician` with a summary, reason and steps tried.
2. The caller's browser sends that (plus the transcript) to the server over WebSocket.
3. No technician online → Gemini is told `unavailable` and suggests the help desk. Technician online → Gemini is told `transferring`, says "please stay on the line", and the technician's console starts ringing.
4. When that sentence finishes playing, the caller hears a soft hold tone.
5. Technician taps **Answer** → caller creates a WebRTC offer → server relays offer, answer and ICE candidates → audio connects. The technician already sees the problem, the router lights and every step tried.
6. Nobody answers within 45 seconds (or every technician declines) → the caller is reconnected to Gemini, which apologises and continues with the earlier context. That context comes from the server's own record, not from the browser, so visitors cannot inject instructions.

The visitor can also press **Technician** at any time to skip the AI.

---

## 2. System prompt and ISP logic

The full prompt is in `prompt.js`. It defines:

- **Persona and voice style:** short turns, one instruction at a time, wait for "done", no lists read aloud.
- **Language rules:** start in the visitor's chosen language, follow them if they switch, keep everyday tech words (router, Wi-Fi, LOS) in English as people in India say them. Gemini detects the spoken language automatically.
- **Safety and privacy:** never ask for passwords, OTPs or payment details; never invent outages or account data; burning smell or sparks → switch off and escalate as urgent; don't look into fibre ends.
- **Triage** into five categories, then four decision trees:

| Tree | Main path | Escalate when |
|---|---|---|
| A. No internet | Read router/ONT lights → Power off: check adapter and socket → LOS red: check and reseat fibre → PON blinking: one restart → otherwise power-cycle (30 s off, 2–3 min wait) → ONT before router → test another device | Power stays off, LOS stays red, PON still blinking, or no internet after all steps |
| B. Slow | All devices or one? → speed test near router → restart → distance, 2.4 vs 5 GHz, pause downloads | Under about half the plan speed near the router after restart, or frequent drops |
| C. Wi-Fi | Name visible? → Wi-Fi light/button, restart → password from sticker, forget and rejoin → airplane mode toggle | Network never appears, forgotten custom password, router settings changes |
| D. One device | Restart device → toggle Wi-Fi → forget and rejoin → VPN off, auto date and time | Other devices work but the caller still wants help |

- **Escalation triggers:** caller asks for a human (any language), LOS red or no power after checks, damage or safety, tree finished without a fix, billing or account questions, frustrated or confused caller, anything outside Level 1.
- **Functions:** `escalate_to_technician(reason, summary, steps_tried, customer_name, urgency)` and `end_call(resolved, summary)`.

To change the brand, set `ISP_NAME` and `ASSISTANT_NAME`. To change the troubleshooting, edit the trees in `prompt.js`; no other code needs to change.

---

## 3. Code map

```
server.js            HTTP server, Gemini token + setup, WebSocket signalling, queue, ring timeout, rate limit
prompt.js            System prompt, decision trees, function declarations, greetings in 3 languages
public/index.html    Caller page
public/caller.js     Call flow: Gemini session, transcripts, function calls, hold, technician WebRTC leg
public/gemini-live.js Gemini Live browser client: mic capture (AudioWorklet), voice playback, events
public/tech.html     Technician console
public/tech.js       Login, ringing, answer, WebRTC answerer, call details
public/booth.html    QR code screen
public/common.js     WebSocket client with reconnect, tones, ICE queue, helpers
public/style.css     Shared styles (light and dark)
test/handoff.test.js Automated test of escalation and hand-off signalling
```

Only one npm package is used: `ws`. Everything else is built into Node.js 20.12 or newer.

---

## 4. Get a free Gemini API key

1. Go to https://aistudio.google.com and sign in with any Google account.
2. Click **Get API key** → **Create API key**. Copy it.
3. That's it: no card needed for the free plan.

**About the free plan:** Google's pricing page lists the Gemini Live models as free of charge on the free tier, with usage limits. For one demo call at a time this is plenty. Google may use free-plan conversations to improve its products, so treat the demo as public: the assistant is already told never to ask for passwords, OTPs or payment details.

---

## 5. Run it on your laptop

1. Install Node.js 20.12+ (22 LTS recommended).
2. In this folder:
   ```
   npm install
   cp .env.example .env      (Windows: copy .env.example .env)
   ```
3. Edit `.env`: paste your `GEMINI_API_KEY` and choose a `TECH_PIN`.
4. `npm start`, then open http://localhost:3000 (caller) and http://localhost:3000/tech (technician) in two tabs. Laptop browsers allow the microphone on `localhost`.
5. `npm test` runs the hand-off test (no API key needed).

Phones need **HTTPS** for the microphone, so `http://<laptop-ip>:3000` will not work on a phone. For phone testing, deploy (next section) or run a free tunnel such as `npx cloudflared tunnel --url http://localhost:3000` and open the https link it prints.

---

## 6. Deploy free on Render (gives HTTPS automatically)

1. Put this folder in a GitHub repository (the `.gitignore` keeps `.env` out).
2. On render.com: **New → Blueprint**, pick the repository. Render reads `render.yaml`.
3. When asked, enter `GEMINI_API_KEY` and `TECH_PIN`. Leave the TURN values empty for now.
4. After the deploy, you get `https://isp-voice-support-xxxx.onrender.com`.
   - Caller: `/`  Technician: `/tech`  Booth screen: `/booth`

**Free-plan note:** Render's free service sleeps after about 15 minutes with no visitors and takes up to a minute to wake. On exhibition day, open the site a few minutes before the doors open and keep the `/tech` page open; it pings the server every few minutes so it stays awake.

### Optional: TURN relay

Peer-to-peer audio works on the same Wi-Fi and on most home networks. Some mobile-data and corporate networks block it; then the technician leg shows "Audio connection failed". Fix: create a free TURN account (metered.ca "Open Relay" or Cloudflare TURN), then set `TURN_URLS`, `TURN_USERNAME` and `TURN_CREDENTIAL` in Render. The Gemini leg never needs TURN.

---

## 7. Exhibition-day checklist

- [ ] Open `/booth` full-screen on the booth TV or a tablet.
- [ ] On your phone, open `/tech`, log in, keep it in the foreground, screen on. Turn on **Online**.
- [ ] Make one test call yourself in each language and test one transfer.
- [ ] For the demo phone, use earphones or keep the volume moderate, so the booth noise and Asha's own voice don't confuse her.
- [ ] Use a headset at the technician end too.

---

## 8. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "Microphone needs a secure https link" | You opened `http://` on a phone. Use the Render https address or a tunnel. |
| "Microphone access is blocked" | iPhone: Settings → Safari → Microphone → Ask/Allow. Android Chrome: tap the lock icon → Permissions → Microphone. |
| Call fails right away with a Gemini message | Wrong or empty API key, free-plan limit reached for the minute or day, or the model name changed. Check `GEMINI_API_KEY` and `GEMINI_LIVE_MODEL` (see the model list in Google AI Studio). |
| Asha keeps interrupting herself | The phone speaker is too loud in a noisy hall. Use earphones or lower the volume. |
| No sound on iPhone | Turn off silent mode and raise the volume. |
| Technician never rings | `/tech` page closed, phone locked, or Online switched off. The console must stay open in the foreground on iPhone. |
| "Audio connection failed" on transfer | A network blocked peer-to-peer audio. Add TURN (section 6). |
| Kannada sounds less natural | Gemini supports Kannada, but English and Hindi usually sound most natural. Mention this in your presentation. |

---

## 9. Rubric self-assessment

| Criterion | How the app meets it | Evidence |
|---|---|---|
| Device compatibility (5/5) | Standard `getUserMedia`, AudioWorklet, WebSocket and WebRTC APIs supported by Safari on iOS 15+, Chrome on Android, and desktop Chrome, Edge, Firefox and Safari. Mobile-first layout, large touch targets, audio unlocked on the first tap for iPhone, `playsinline` audio, screen wake lock for the technician. | Tested with a phone-sized caller and a laptop-sized technician in an automated browser run (section 10). |
| Cost and simplicity (5/5) | Zero running cost: Gemini Live free plan for the AI, internet WebRTC for the technician call (no phone numbers, SIMs or telephony plans), free Render hosting, free public STUN, optional free-tier TURN. One npm dependency. | No paid service anywhere in the setup. |
| Latency and naturalness (5/5) | Speech-to-speech model (no separate STT/TTS hops), 500 ms end-of-speech detection, low start sensitivity for noisy halls, barge-in allowed, echo guard, prompt forces short spoken turns. | The caller page shows a live "Average reply time", measured from when the caller stops talking to Asha's first sound. |
| Escalation hand-off (5/5) | Function call → technician rings → one-tap answer → direct audio. Technician gets reason, summary, steps tried and transcript. Handles no technician online, busy technician, decline, 45-second timeout (back to AI with context), caller hang-up while ringing, and technician disconnect. | `npm test` covers each of these paths. |

---

## 10. How it was tested

- `npm test`: starts the server and checks pages, config, PIN rejection, escalation with no technician, ring → accept → offer/answer/ICE relay → connected → hang-up, busy technician, ring timeout, decline, and caller leaving while ringing.
- Automated browser run (Chromium with simulated microphones) against a stand-in for the Gemini service: the server requested a single-use token with the API key kept server-side, the browser connected with only that token, sent the setup (prompt, both functions, audio replies) and streamed the microphone as 16 kHz PCM; the greeting played and showed in the transcript; an `escalate_to_technician` call rang the technician, Gemini received the `transferring` response, the caller went on hold after "please stay on the line", the technician answered, and real microphone audio was measured arriving at the technician's browser. A second call checked that `end_call` hangs up after the goodbye and counts as solved by the assistant.
- Not tested here: a live call against Google's Gemini service (it needs your API key) and physical iPhones. Do one test call per language on your own phone before the exhibition.
