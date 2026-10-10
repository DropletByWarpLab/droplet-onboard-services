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
that only knows the phrase "hey droplet" plus an unknown-word bucket
(`services/voice-io/voice/wake.py`; threshold 0.85 is the minimum per-word
confidence, so TV and ambient speech rarely false-fire). The bare one-word
"droplet" is off by default: ambient speech gets forced into it at full
confidence (WARP-3128).

On wake, the next utterance streams to the local Qwen3-ASR sidecar
(`qwen-stt`, CPU only) with an energy-based voice-activity detector that
ends the capture after 0.48 s of trailing silence following a short command
and 0.6 s after a longer one or a mid-sentence pause (hard cap 30 s); a
capture with no speech in it ends after 6 s and is not transcribed
(WARP-3729). The transcript passes two local gates: an actionability
filter (drops fragments like "uh" from residual false wakes) and an intent
gate (a regex classifier — greetings, "what time is it", "who are you",
"can you hear me" get `tool_choice: "none"` so the LLM answers instantly
from its persona prompt without speculatively calling tools). Between the
two, spoken speaker-volume commands ("turn it up", "volume 40 percent",
"mute", "what's the volume") are recognised by a second regex classifier
and handled entirely on the box, with no LLM call — see Speaker volume below.

The transcript then posts to the orchestrator's `/api/llm/chat` under a
dedicated service-principal bearer token — the same ReAct agent loop and
~50-tool MCP surface the dashboard chat uses, capped at 2 iterations for
snappiness and RBAC-restricted to read-only tools (voice can check cameras,
network and devices but cannot change anything in v1 through the agent loop;
its own speaker volume is changed locally, see below). The reply text goes
to the local Kokoro TTS container (default voice `af_heart`) and plays out
the ReSpeaker's speaker output at the persisted speaker volume. A 2 s
post-speak cooldown suppresses wake detection so the box doesn't hear itself.

## Speaker volume

One level (0-100) plus a mute flag, persisted on the box
(`/data/voice-volume.json`) and applied as software gain to everything the
assistant says, including the spoken cues. 100 is the loudness every box had
before volume existed; there is no boost above it. Mute plays nothing and
keeps the level for unmute. An unreadable volume file falls back to 100,
unmuted, and reports the fault on `/voice/status` (`output_fault`) — a
storage fault never silences the box on its own.

Two ways to change it:

- **By voice**, locally: "volume 40 percent", "volume 5" (0-10 scale),
  "turn it up/down", "louder", "quieter", "max volume", "minimum volume"
  (10), "mute", "unmute", "what's the volume". Answered in a few words at the
  new level ("Volume 40."), mute is silent. Works with the LLM down. Only
  whole, object-less utterances match: "turn up the thermostat" still goes to
  the agent loop, and "stop" / "quiet" / "shut up" are never mute.
- **Over the API**: `GET/POST /api/voice/volume` (owner/admin), audited as a
  `voice` activity row. There is no dashboard control on top of it yet.

The assistant has no `set_volume` tool, so a phrasing the classifier doesn't
recognise goes to the LLM, which cannot change the volume. Adding that tool
widens voice's write set beyond `control_device` and needs an ADR-004
amendment first. `/voice/status` carries `output_level` and `output_muted`
for a future indicator.

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

"Hey Droplet", recognized out of the box by the grammar-constrained Vosk
engine (no per-phrase model training, no licensing). `WAKE_WORD` is a
comma-separated list of phrases (default `hey droplet`) and the box wakes on
ANY of them, each scored on its own window (WARP-1431). The bare one-word
"droplet" is off by default: grammar-forced decoding squeezes ambient speech
into a lone "droplet" at confidence up to 1.00, so no threshold can filter it
(~23 false wakes/hour on the bench, WARP-3128). Operators can opt back in with
`WAKE_WORD=droplet,hey droplet`. "Hey Droplet" is also the spoken form in the
UI copy. Engine fallback: if the Vosk model is
missing, openWakeWord takes over (single-model) with "hey jarvis" as the
closest bundled phonetic shape, and `/voice/status` exposes
`using_wake_fallback` so a UI can say "configured: hey droplet
(currently answering to hey jarvis)".

## Latency character

- Wake: near-instant (sub-second, per-frame scoring).
- Capture: your utterance plus a 0.48 s silence tail after a short command
  (`VAD_SILENCE_SHORT_S`) or 0.6 s after a longer one or a mid-sentence pause
  (`VAD_SILENCE_S`), max 30 s; a capture with no speech ends after 6 s
  (`VAD_NO_SPEECH_S`) without transcription.
- STT: about 1–2 s for a short command (Qwen3-ASR 0.6B, CPU).
- LLM: the dominant cost — each agent iteration is a full local-model round
  trip (roughly 2–4 s on the box), max 2 iterations; intent-gated small talk
  skips tools entirely and is fastest. The reply streams (WARP-626): speech
  starts once the first sentence has arrived, not after the whole reply —
  or once its first clause has, when that clause is at least 24 characters
  long (WARP-3729), so a one-sentence answer with a comma starts sooner.
- TTS and playback: each sentence is synthesized as it completes, and the
  next one is synthesized while the current one plays (synth-ahead,
  WARP-3124), so there's no synthesis gap between sentences.

Typical end to end, as last measured: about 4–6 s for "what time is it" and
about 8–15 s for a tool question ("is the front camera online?"). With
streaming, the first words arrive well before the end. A tool question is two
model round trips plus the tool call, and the orchestrator holds back the
first round's text until it knows a tool fired (WARP-1602). So the box says a
short cue, "Let me check.", the moment the tool call starts instead of sitting
silent. If the model has to load first, the cue is "One moment." There is at
most one cue per turn, never once the answer has begun. A cue is ordinary
speech, so `/voice/status` reads `speaking` from the cue to the end of the
answer, including the quiet stretch while the tool runs (there is still no
separate thinking state).

To see where a turn's time goes, every turn logs one `voice_turn_timing` line
(wake to capture, capture, STT, first reply text, first audio, first answer
audio and total, in ms, plus the cue, the chunk count — `sentences`, which
counts a split-off first clause too since WARP-3729 — the first chunk's
length in characters and the error kind).
`/voice/status` carries the same fields for the last turn as
`last_turn_timing`. The plan and history are in
`services/voice-io/docs/voice-latency-plan.md`.

## Privacy story

Wake detection, speech to text (Qwen3-ASR), the LLM (Ollama on-box) and TTS
(Kokoro) all run locally in containers. Audio never leaves the appliance and
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
   (unbuilt). The spoken "mute" that WARP-627 added silences the
   **speaker** only; the microphone keeps listening (see Speaker volume).
2. Tool questions are still slow — two model round trips plus the tool call
   (about 8–15 s). The spoken cue fills the silence but doesn't shorten it.
3. Read-only tools — voice cannot control devices in v1.
4. Almost no user-facing surface: the wizard step (WARP-1036) is the first;
   there is still no settings page and no status indicator.
5. English-only defaults (Qwen3-ASR forced to English, English wake grammar).
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
| `WAKE_WORD` | comma-separated wake phrases (default `hey droplet`; the bare one-word `droplet` is left out because it false-wakes on ambient speech, WARP-3128); any English phrase(s) under vosk, wakes on any |
| `WAKE_THRESHOLD` | default 0.85 (vosk) / 0.3 (openwakeword) |
| `WAKE_DEBOUNCE_S` | wake re-trigger suppression window |
| `VOICE_INPUT_DEVICE` / `VOICE_OUTPUT_DEVICE` | pin specific hardware |
| `VOICE_INPUT_DOWNMIX` | `first` or `mean` channel downmix |
| `VOICE_INPUT_GAIN` | software input gain |
| `STT_URL` / `STT_LANGUAGE` / `STT_MAX_RECORD_S` | Qwen3-ASR sidecar (30 s cap via compose) |
| `VAD_SILENCE_S` / `VAD_SILENCE_SHORT_S` / `VAD_NO_SPEECH_S` | end-of-speech tails (0.6 s long / 0.48 s short) and the 6 s no-speech guard (WARP-3729) |
| `WHISPER_CPUS` / `WHISPER_CPU_THREADS` | Whisper sidecar CPU quota and decode threads, default 4 / 4 (WARP-3126, was 2 / 2). Keep them equal (WARP-1434). STT is CPU-only |
| `TTS_URL` / `TTS_VOICE` | Kokoro sidecar; `af_heart` default, eight bundled English voices; legacy Piper is an optional override |
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
