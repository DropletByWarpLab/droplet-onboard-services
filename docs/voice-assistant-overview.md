# How the Droplet voice assistant works

Design-facing overview of the always-on voice assistant (WARP-154, `services/voice-io`).
Written for anyone shaping the wizard step, a future settings page, or status
indicators — it describes what exists in code today, what states the UI can
render, and where the confirmed gaps are. Companion surfaces: the setup
wizard's voice step (WARP-1036) and the orchestrator's `/api/voice/*` proxy.

## The pipeline in words

The ReSpeaker XVF3800 4-mic USB array captures the room continuously
(16 kHz mono after channel-0 downmix — the array puts beamformed voice on
channel 0 and the echo-cancellation residual on channel 1). Inside the
voice-io container a single background thread consumes 80 ms frames and runs
a state machine (`services/voice-io/voice/pipeline.py`). Every frame is fed
to the wake-word detector — by default a grammar-constrained Vosk recognizer
that only knows the phrases "droplet" and "hey droplet" plus an unknown-word
bucket (`services/voice-io/voice/wake.py`; it fires on either, and threshold
0.7 is the minimum per-word confidence, so TV and ambient speech rarely
false-fire).

On wake, the next utterance streams to a local Whisper container
(wyoming-faster-whisper, small.en, int8 CPU) with an energy-based
voice-activity detector that ends capture after 1.0 s of trailing silence
(hard cap 5 s). The transcript passes two local gates: an actionability
filter (drops fragments like "uh" from residual false wakes) and an intent
gate (a regex classifier — greetings, "what time is it", "who are you",
"can you hear me" get `tool_choice: "none"` so the LLM answers instantly
from its persona prompt without speculatively calling tools).

The transcript then posts to the orchestrator's `/api/llm/chat` under a
dedicated service-principal bearer token — the same ReAct agent loop and
~50-tool MCP surface the dashboard chat uses, capped at 2 iterations for
snappiness and RBAC-restricted to read-only tools (voice can check cameras,
network and devices but cannot change anything in v1). The reply text goes
to a local Piper TTS container (voice `en_US-ryan-medium`) and plays out the
ReSpeaker's speaker output. A 2 s post-speak cooldown suppresses wake
detection so the box doesn't hear itself.

## User-visible states (from `/voice/status`)

```
idle → loading → listening → wake_detected (2 s pulse) → transcribing
     → transcript_ready (2 s) → [LLM thinking — not a distinct state today]
     → speaking → listening
```

Fault states:

- `error` — latched pipeline error, `error_message` set.
- `no_mic` — no input device; a supervisor retries, and hot-plugging a mic
  recovers with no restart.

Both fault states fail the container healthcheck (503).

Deliberate state:

- `off` — an owner/admin switched the assistant off (WARP-1599). There is no
  pipeline at all: no detector, no worker thread, no open capture stream, and
  the persisted flag means the box boots straight back into it.
  `/voice/status` carries `enabled: false` alongside the state, and `enabled`
  is the field to key a UI on — `state` only reads `off` while the pipeline is
  absent. Unlike the fault states this one keeps `/health` at 200: a box doing
  exactly what it was told must not be restart-looped for it.

Design asks for engineering (missing states, confirmed):

- The switch is all-or-nothing. There is no temporary mute (a "be quiet for
  an hour" window that expires on its own) and no hardware mute button — off
  is a persistent admin decision that stays until someone reverses it (see
  limitations below).
- "Thinking" deserves a first-class state: today the LLM round trip happens
  invisibly inside the reply call, which is the longest silent gap in the
  interaction.

## Indicators

None today. No OLED integration, no LED ring driving, no dashboard widget —
`/voice/status` is polled by nothing user-facing except the new wizard step
(the operator ops-console pings `/health` only). This invisibility is the
single biggest reason the assistant "seems off": nothing ever tells the
customer the wake word exists. The status payload is already rich enough to
drive a full UI: state, wake model and fallback flag, threshold, last wake
time and score, last transcript, last spoken reply, per-stage loaded flags.

## The wake word

"Droplet" **or** "Hey Droplet" — both recognized out of the box by the
grammar-constrained Vosk engine (no per-phrase model training, no licensing).
`WAKE_WORD` is a comma-separated list of phrases (default `droplet,hey
droplet`) and the box wakes on ANY of them; each fires scored on its own
window, so the shorter "droplet" and the two-word "hey droplet" both carry
real per-word confidence evidence (WARP-1431). "Hey Droplet" remains the
primary spoken form in the UI copy. Engine fallback: if the Vosk model is
missing, openWakeWord takes over (single-model) with "hey jarvis" as the
closest bundled phonetic shape, and `/voice/status` exposes
`using_wake_fallback` so a UI can say "configured: droplet/hey droplet
(currently answering to hey jarvis)".

## Latency character

- Wake: near-instant (sub-second, per-frame scoring).
- Capture: your utterance plus a 1.0 s silence tail (max 5 s).
- STT: about 1 s (small.en int8).
- LLM: the dominant cost — each agent iteration is a full local-model round
  trip (roughly 2–4 s on the box), max 2 iterations; intent-gated small talk
  skips tools entirely and is fastest.
- TTS and playback: roughly 1–2 s synthesis, then real-time speech.

Typical end to end: about 4–6 s for "what time is it", about 8–15 s for a
tool question ("is the front camera online?"). Known improvement path:
WARP-626 — voice calls the LLM with `stream: false`, so speech cannot start
until the whole reply is done; streaming plus sentence-chunked TTS would
roughly halve perceived latency.

## Privacy story

Wake detection, speech to text (Whisper), the LLM (Ollama on-box) and TTS
(Piper) all run locally in containers. Audio never leaves the appliance and
is never written to disk — frames live in memory only, and only the latest
transcript and reply strings are held for status display. Voice
authenticates to the control plane with a dedicated service token and is
read-only by RBAC.

One caveat any copy must carry: at startup voice-io makes a single outbound
internet call to ipapi.co to geolocate (city and timezone, used for
"what time is it" answers). Operators can pin `DROPLET_LOCATION` / `TZ` in
`.env` to make the service fully egress-free. Do not claim "zero network
egress" without this footnote.

An owner/admin can switch the assistant off from the /voice page
(WARP-1599). Be precise about what that is: a **software** kill switch, not
a hardware or electrical mute. The microphone stays powered whenever the box
is on, and there is no physical switch or indicator LED a customer can check
it against. What it does do is real and it is enforced on the box, not in the
dashboard: the flag persists to disk, the wake pipeline is stopped and
dropped (which closes the exclusive capture stream), the box boots back into
the off state, and voice-io refuses with 409 every other endpoint that opens
the mic — the calibration measurements and the voiceprint-enrollment
captures. So nothing running on this Droplet reads audio while voice is off.
The supportable claim is "no software on the box is capturing audio", not
"the microphone is disconnected".

One timing caveat on that claim (WARP-1619). A turn runs to completion on the
capture thread — LLM reply, then TTS, then blocking playback — and the loop
only re-checks the shutdown flag between frames. Switch voice off mid-reply and
the box stops reading new audio immediately, but finishes the sentence aloud
and holds the mic device until it does. The disable response reports this as
`mic_released: false`; while it is outstanding, turning voice back on waits for
the device rather than opening a second stream on it.

## Current limitations (all confirmed in code)

1. Disable is software-only (WARP-1599) — POST `/voice/enabled` persists an
   on-box flag, drops the pipeline and refuses every mic-opening endpoint,
   and the /voice page carries the owner/admin switch. Still missing: any
   hardware mute-switch integration, a self-expiring "be quiet for an hour"
   pause, and a `mute_mic` tool the assistant could call on request
   (WARP-627, unbuilt).
2. Non-streaming replies (WARP-626) — TTS waits for the full agent reply.
3. Read-only tools — voice cannot control devices in v1.
4. Almost no user-facing surface: the wizard step (WARP-1036) is the first;
   there is still no settings page and no status indicator.
5. English-only defaults (small.en STT, English wake grammar).
6. Single wake phrase, env-configured only.
7. Stateless turns — each wake is a fresh anonymous conversation; no
   follow-up context.
8. Known hardware failure mode: the XVF3800 DSP can wedge (continuous USB
   buffer overruns; the box keeps reporting "listening" while effectively
   deaf). Currently invisible to health checks; the fix is a DSP reboot via
   the vendor `xvf_host` tool. Wedge observability is separate follow-up
   work, not part of WARP-1036.

## Settings that exist today (all env-only, `.env` / compose)

| Setting | What it does |
| --- | --- |
| `WAKE_ENGINE` | `vosk` (default) or `openwakeword` |
| `WAKE_WORD` | comma-separated wake phrases (default `droplet,hey droplet`); any English phrase(s) under vosk, wakes on any |
| `WAKE_THRESHOLD` | default 0.7 (vosk) / 0.3 (openwakeword) |
| `WAKE_DEBOUNCE_S` | wake re-trigger suppression window |
| `VOICE_INPUT_DEVICE` / `VOICE_OUTPUT_DEVICE` | pin specific hardware |
| `VOICE_INPUT_DOWNMIX` | `first` or `mean` channel downmix |
| `VOICE_INPUT_GAIN` | software input gain |
| `STT_URL` / `STT_LANGUAGE` / `STT_MAX_RECORD_S` | Whisper sidecar (5.0 s cap via compose) |
| `TTS_URL` / `TTS_VOICE` | Piper sidecar; `en_US-ryan-medium` default, other voices download on demand |
| `LLM_MODEL` | model the reply call requests |
| `DROPLET_LOCATION` / `TZ` | pin geo/timezone; removes the ipapi.co startup lookup |
| `DEVICE_RESCAN_INTERVAL` | hot-plug rescan cadence |

Deployment: compose profile `linux` — enabled on every real box (the setup
scripts write `COMPOSE_PROFILES=linux,display,eval` on Linux; single-box
merges profiles on top). macOS dev installs skip the whole voice stack (no
`/dev/snd`), which is why the orchestrator proxy answers 503
`voice_unavailable` there and the wizard step auto-skips.

## Hardware

Any ALSA microphone works; the ReSpeaker XVF3800 4-mic array (USB
`2886:001a`) is the intended configuration — hardware beamforming and echo
cancellation, and it doubles as the speaker. Device scoring auto-prefers USB
mics (+200 USB, +100 respeaker/headset name match, −100 HDMI). With no mic
at all the service boots into `no_mic`, keeps `/audio/devices` alive so a UI
can prompt "plug in a mic", and hot-plug recovery arms voice with no
restart.
