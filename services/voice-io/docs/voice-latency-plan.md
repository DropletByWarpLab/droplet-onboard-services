# Voice latency + wake-word plan (WARP-1430 epic)

> Goal (from Stefan, 2026-07-20): **speed up voice responses**, and make the
> wake word **"droplet"** (not just "Hey Droplet").
>
> This doc is the design of record for the epic. Each wave below is one child
> ticket → one PR through the Droplet agent harness. Nothing changes the shared
> model (`gpt-oss:20b`, the architecture-guard one-model rule stands). Every win
> here is streaming, prompt-shape, or wiring — not a model swap.

## Status (2026-09-25)

Waves A–E are shipped on `stage`. The wave sections below stay as the design
record; this table is the current state. Wave 2 is the last section.

| Wave | Ticket | PR | Status |
|---|---|---|---|
| A — wake word | WARP-1431 | #1183 | Shipped, then superseded by WARP-3128: the default is back to "hey droplet" only, because the bare "droplet" false-woke on ambient speech. |
| B — streaming + sentence-chunked TTS | WARP-626 | #1187 | Shipped. |
| C — voice turn shaping | WARP-1432 | #1185 | Shipped: `max_tokens`, `allowed_tools`, `ephemeral`. The reasoning-effort hint never shipped in voice-io; WARP-3123 sends it from ai-gateway. |
| D — connection reuse + warm-up | WARP-1433 | #1190 | Shipped. |
| E — capture/VAD tuning + config hygiene | WARP-1434 | #1190 | Shipped: `VAD_SILENCE_S` 0.6 s, VAD knobs env-wired, Whisper threads aligned to its `cpus` quota (2 / 2.0). WARP-3126 raises both to 4. WARP-3729 follow-up: frame-quantized counters, adaptive 0.48 / 0.6 s tail, no-speech and min-speech guards (see the Wave E section). |
| Wave 2 | WARP-3123..3127 | — | In progress (see the Wave 2 section). |

## Where the time actually goes

Measured/traced end-to-end from the four voice-io layers (`wake.py`, `stt.py`,
`tts.py`, `llm.py`) and the orchestrator `/api/llm/chat` route. The documented
budget in `docs/voice-assistant-overview.md` is ~4–6 s for small talk, ~8–15 s
for a tool question. The dominant costs, ranked:

| # | Cost | Where | Fix wave |
|---|---|---|---|
| 1 | **Fully blocking pipeline** — no token streaming at any hop; TTS waits for the last token, then synthesizes the whole reply, then plays. First audio = full LLM decode + full synthesis. | `llm.py:335` (`stream:false`), `pipeline.py:2039-2059`, `tts.py:199-237` (buffers chunks to `audio-stop`) | **B** |
| 2 | **`gpt-oss:20b` with no `max_tokens`** — an uncapped *reasoning* trace nobody hears is generated before the first audible word. Box runs 20B (`single-box.sh:813`), not the 3B the code comments assume. | `llm.py` (no `max_tokens`, no reasoning cap sent) | **C** |
| 3 | **~5k tokens of tool-schema prefill on every non-greeting turn** (43 tools serialized), ×2 when a tool actually fires. Voice omits `allowed_tools`, so it inherits the full `_service:voice` set. | `llm-agent.service.ts:376`, voice omits `allowed_tools` at `llm.py:326-328` | **C** |
| 4 | **~3 blocking Postgres writes per turn** — voice never sets `ephemeral`, so every utterance mints a throwaway `ChatSession` (+ litters the chat sidebar) before inference starts. | `routes/llm.ts:872`, `chat-persistence.service.ts:429` | **C** |
| 5 | **New TCP + mTLS handshake per request** — no `httpx.Client` reuse; ×2 on greeting turns (persona GET + chat POST). | `llm.py:347`, `persona.py:98`, `internal_tls.py:51-55` | **D** |
| 6 | **No warm-up** — first utterance after boot pays cold CTranslate2 init; first *spoken* reply can race a 70 MB Piper voice download inside a 15 s timeout. | `main.py:298-302`, `tts.py:62` | **D** |
| 7 | **1.0 s silence tail on every turn** + `STT_MAX_RECORD_S` drift (code/README say 3.0, box runs 5.0) + `--cpu-threads 4` inside `cpus: 2.0`. | `pipeline.py:290`, `docker-compose.yml:1750`, `:1823` | **E** |

**Not the problem** (don't touch): the agent-loop budget (`max_iter`, now 4 via `VOICE_MAX_ITER` — WARP-3316) is already tuned down;
`--beam-size 1` is already greedy-optimal; STT is already 16 kHz-native with no
disk I/O. Model residency is short on purpose: `OLLAMA_KEEP_ALIVE` defaults to
`5m` (WARP-1826, the `ollama` service in `docker/docker-compose.yml`), not 24 h.
A day-long keep-alive pinned a bad CPU placement long after VRAM freed. Don't
raise it for latency. The cold load after an idle gap is covered by the
`model_loading` spoken cue (WARP-3124) and warm-on-wake (WARP-3127).

The single highest-leverage change is **#1 (streaming)** — the overview doc
already predicts it "would roughly halve perceived latency." Everything else
compounds on top.

## Wave A — Wake word: accept "droplet" **and** "Hey Droplet"

> **Superseded 2026-09-25 (WARP-3128):** the default is back to `hey droplet`
> only. On the bench the bare one-word "droplet" false-woke ~23x/hour on
> ambient conversation, often at confidence 1.00, so no threshold could filter
> it. Multi-phrase support stays; operators can opt back in with
> `WAKE_WORD=droplet,hey droplet`.

**Decision: accept both** (Stefan, 2026-07-20). "Droplet" alone wakes it; "Hey
Droplet" keeps working. No regression for boxes in the field, and all 14 shipped
copy strings + the calibration wizard's 3-of-3 wake test stay valid.

**Why this is small:** the production wake engine is **Vosk**, a
grammar-constrained keyword spotter (`WAKE_ENGINE=vosk`), *not* a trained
`.onnx`/`.tflite` model. The phrase flows straight into a JSON grammar at load
(`wake.py:347`, `grammar = json.dumps([self._phrase, "[unk]"])`). Changing what
it listens for needs **no model training and no new artifact** — it's a grammar
+ matcher change.

Implementation:
- `WAKE_WORD` becomes a comma-separated list; default `droplet,hey droplet`.
- `VoskWakeWordDetector` builds the grammar from **all** phrases
  (`["droplet", "hey droplet", "[unk]"]`) and fires if **any** phrase matches,
  scoring/timing-gating on the matched window (today's logic assumes one phrase —
  `_phrase`, `_phrase_tokens`, `_phrase_in_text`, `_phrase_confidence` all
  generalize to a list).
- `pipeline.py` intent regexes (`_INTENT_NO_TOOLS_PATTERNS`) learn a bare
  `droplet` prefix (today they match `hey droplet` but not `droplet` alone).
- Compose default + `.env.example` + README + `voice-assistant-overview.md`
  updated. Design canon in `shared_brain/content/brand/handoffs/voice/` keeps
  "Hey Droplet" as the *primary* spoken form — both are valid, so no copy sweep.

**Caveats to price in (and soak-test on the box):**
- A single common word ("droplet") false-accepts more than a two-word unit. Keep
  the Vosk threshold at its 0.7 default (now 0.85, WARP-3128): min per-word
  confidence over one word is weaker than over two. Re-run the living-room-TV
  soak.
- The timing-plausibility gate's 0.2 s span floor bites a clipped sub-200 ms
  "droplet"; that's a new (honest, logged) failure mode "Hey Droplet" never had.
- The current shipping default is Vosk. Explicit openWakeWord installs must
  provide appropriately licensed assets; missing models report errors instead
  of silently switching the wake phrase to hey_jarvis.

## Wave B — Streaming end-to-end + sentence-chunked TTS (WARP-626)

The headline. Every layer here already supports streaming; voice-io opts out.

- **LLM:** switch voice-io to `stream:true` and consume the orchestrator SSE
  path (`content_delta`/`tool_call`/`tool_result`/`done` — already implemented at
  `llm.ts:1461`). `reply()` becomes a generator of text deltas.
- **Chunker:** buffer deltas into sentence/clause units (split on `.?!`, safe
  min/max length) — a new, tested pure function. No such splitter exists today.
- **TTS:** synthesize each sentence as it completes rather than the whole reply
  once (`tts.py` already receives Piper's streamed `audio-chunk`s and throws the
  streaming away by buffering to `audio-stop`).
- **Playback:** move from `sd.play()`+`sd.wait()` on one full buffer to a
  chunked `OutputStream` so audio for sentence 1 plays while sentence 2
  synthesizes. Rework the `speak()` non-blocking lock lifetime accordingly.
- Anti-feedback (post-speak cooldown, `speaking`-state mic gating) and the
  `already_speaking` guard must survive the redesign — they're load-bearing for
  the shared reSpeaker mic/speaker endpoint.

Time-to-first-audio drops from *(full decode + full synth)* to *(first sentence
decode + first sentence synth)*.

## Wave C — Voice turn shaping (all client-side; orchestrator already accepts these)

Pure `voice/llm.py` request-shape changes. The orchestrator schema **already**
accepts `max_tokens` (`llm.ts:156`), `ephemeral` (`:176`), and `allowed_tools`.

- **`max_tokens`** — cap voice replies (they're meant to be one spoken sentence).
  Stops gpt-oss burning uncapped tokens.
- **Reasoning control** — pass the low-reasoning-effort hint for gpt-oss so the
  inaudible reasoning channel doesn't dominate time-to-first-token (respecting
  WARP-495's reasoning-content handling).
- **`allowed_tools`** — send a narrow voice tool set (the handful voice actually
  uses) instead of inheriting all 43. Cuts prefill from ~5k to ~1k tokens/turn.
- **`ephemeral:true`** — kills ~3 Postgres writes/turn and stops one throwaway
  conversation per utterance polluting the chat sidebar.

## Wave D — Connection reuse + warm-up

- Introduce a module-level `httpx.Client` (with the mTLS cert kwargs) reused
  across turns — no fresh TCP + TLS handshake per request; ×2 saved on greetings.
- Warm-up inference at startup: one throwaway Piper synth + one tiny Whisper
  transcribe after `pipeline.start()`, so the first *real* utterance isn't cold
  (and any 70 MB voice download happens off the critical path).

## Wave E — Capture/VAD tuning + config hygiene

- Trim `VAD_SILENCE_S` 1.0 → ~0.6 s (a full second of dead air ends every turn).
- Env-wire the VAD knobs (`VAD_SILENCE_S`/`VAD_SPEECH_RMS`/`VAD_MIN_SPEECH_S`) —
  `main.py` never reads them today, so the "tune per-room" comment is unfollowable.
- Reconcile `STT_MAX_RECORD_S` (code/README `3.0` vs compose `5.0`) — pick one,
  document it, one source of truth.
- Align Whisper `--cpu-threads` to the container `cpus` quota (4 vs 2.0 today).
- Remove the dead `WHISPER_DEVICE` / `WAKE_VISUAL_DECAY_S` knobs or wire them.

### Follow-up (WARP-3729): adaptive tail, frame-quantized counters, cliff guards

- The tail was never 600 ms: the counters accumulated 0.08 s floats, so
  `VAD_SILENCE_S=0.6` needed 8 frames = 640 ms (the measured turn: 5 loud + 8
  silent frames = 960 ms of capture). Every seconds knob is now converted once
  to whole frames (`_vad_frames`, ceil of the exact ratio — 0.2/0.4/0.48/0.5/0.6
  are 3/5/6/7/8 frames as before; 0.8 is 10 where the accumulation gave 11) and
  the per-turn counters are integers.
- Adaptive tail: a short, pause-free command (voiced span up to 1.2 s, no gap of
  240 ms or more inside it) ends after `VAD_SILENCE_SHORT_S` = 0.48 s (6 frames);
  longer utterances and anyone who already paused keep `VAD_SILENCE_S`. 0.48
  rather than 0.4 because a first hesitation inside a short command is the
  exposure and there is no on-box pause data yet. Setting `VAD_SILENCE_S` alone
  keeps one tail (short = long), so tuned rooms keep their tuning.
- The speech threshold stays in the post-gain domain (`raw RMS × input_gain ≥
  VAD_SPEECH_RMS`, i.e. relative to the calibrated −12 dBFS peak): a box
  calibrated to gain 8 speaks at ~100–200 raw and a raw-domain bar would never
  see it. The RMS is computed once per frame (`_track_input_level` stashes it).
- Cliff guards: the first two capture frames are the wake tail by construction
  and never count; the min-speech gate is 0.24 s (3 counted frames), so a
  one-word command after a pause ends on the normal tail; a capture whose
  counted speech never meets the gate ends `short_speech` (still transcribed)
  after `VAD_NO_SPEECH_S` of silence; a capture with no speech at all ends
  `no_speech` after `VAD_NO_SPEECH_S` = 6 s and is NOT transcribed (the session
  closes without audio-stop; outcome `empty`). Before, all three ran to the 30 s
  cap and handed Qwen 30 s of room noise (~11.6 s of decode on the box).
- Expected gain: ~160 ms of capture plus ~50–70 ms of STT on short commands;
  0 on long or paused ones. Nothing was measured on the box yet.
- On-box verification (default log level, no code): from `docker logs` of
  voice-io over a day, count the `end-of-speech (... short tail)`, `long tail`
  and `fallback tail` lines and the `vad_end` / `vad_tail` values on the
  `voice_turn_timing` lines — expect most short commands to end on the short
  tail and `cap` near zero. Read the tail from `vad_tail`, not from
  `capture_ms − speech_ms`: that difference also holds the wake-tail window
  (up to 160 ms that `speech_ms` no longer counts) and any pause before or
  inside the command. INFO does not carry transcripts (SEC-DATA-9), so
  false-cut suspects are counted either with `LOG_LEVEL=DEBUG` for the day
  (transcripts ending in a function word: to / for / the / a / at / on / and /
  in / of / my) or by proxy: a short-tail turn whose outcome is `fragment` or
  `empty`, or that is followed by a re-wake within 5 s. If suspects exceed
  ~2 % of short-tail turns, set `VAD_SILENCE_SHORT_S=0.56` (7 frames) or equal
  to `VAD_SILENCE_S` to disable; only once they sit well under 2 % is 0.4
  (5 frames) worth trying.

## Sequencing & verification

Waves B/C/D/E all touch `voice/llm.py` and/or `pipeline.py`, so they sequence
(B → C → D → E, each rebased on the prior); **A is independent** and ships first.
Each wave is one ticket → one branch off `stage` → one PR into `stage` through
the harness (dev → qa → [ux] → manager → code-reviewer). `stage` is the
integration branch; `main` only moves through the periodic "Promote stage to
main" PRs. **No merges to prod and no on-box changes without sign-off** (hard
rule 1). Box verification is the gated finale: after the PRs merge, reflash
`192.168.1.87` onto a build that carries them, measure time-to-first-audio
(the `voice_turn_timing` line below) and run the wake-word soak —
plan-then-confirm.

## Wave 2 (WARP-3123..3127)

Waves A–E made the reply stream. What was left is dead air and serial work
inside a turn: a tool question sat silent for 8–15 s (two model round trips
plus the dispatch, with the first round's text held back by WARP-1602), each
sentence was synthesized only after the previous one finished playing, and
nothing measured where a turn's time went. Scope approved 2026-09-25. The five
tickets are parallel branches off `stage`, each kept to its own files so they
merge in any order:

| Ticket | Where | Change |
|---|---|---|
| WARP-3123 | `services/ai-gateway` | Send the reasoning-effort hint to DMR (the Wave C item that never shipped). |
| WARP-3124 | `services/voice-io` | Spoken cues, synth-ahead TTS, the per-turn timing line, and a persona fetch that never blocks a turn (details below). |
| WARP-3125 | orchestrator + `voice/llm.py` | Cache-stable voice prompt: explicit `allowed_tools` tool selection, one system message for the voice caller, and time context that doesn't break the cached prefix. |
| WARP-3126 | compose | Whisper gets 4 CPUs and 4 threads. |
| WARP-3127 | orchestrator + voice-io wake site | Warm-on-wake: `POST /api/llm/warm` at the wake, so a cold model loads while the user is still talking. |

WARP-3124 in detail:

- **Spoken cues.** voice-io reads the orchestrator's `tool_call` and
  `model_loading` SSE frames (`OrchestratorLLM.reply_events`). The first
  `tool_call` plays "Let me check."; `model_loading` plays "One moment." Both
  are synthesized once at warm-up (`WakePipeline.prime_cues`). At most one cue
  per turn, never once the answer has started, and a cue that can't be
  synthesized is skipped, never a failed turn. A cue is ordinary `speaking`
  audio: same `_speak_lock`, same single post-speak cooldown. There is no new
  pipeline state.
- **Synth-ahead.** A per-turn `voice-synth` producer thread reads the reply
  stream and synthesizes sentence N+1 while the turn thread plays sentence N,
  over a one-slot hand-off. The producer is the only thread that advances the
  reply generator, so it also closes it (the WARP-329 SSE teardown) on any
  bail-out.
- **`voice_turn_timing`.** Exactly one INFO line per turn, JSON, whole ms from
  `time.monotonic()`, null where a stage didn't happen: `outcome`,
  `wake_to_capture_ms`, `speech_ms`, `capture_ms`, `vad_end`
  (`silence`/`short_speech`/`no_speech`/`cap`), since WARP-3729 `vad_tail`
  (`short`/`long`/`fallback`, null when no VAD tail ended the capture),
  `stt_ms`, `first_delta_ms`, `first_audio_ms`,
  `first_answer_audio_ms`, `total_ms`, `cue`, `sentences`, `error_kind`,
  `ended_at`, and since WARP-3729 `first_chunk_chars`. The `first_*` fields
  count from the transcript and `total_ms` counts from the wake; `sentences`
  counts the answer chunks played (a first clause split off under WARP-3729
  counts as one) and `first_chunk_chars` is the length of the chunk behind
  `first_answer_audio_ms`. The last turn is also on `/voice/status` as
  `last_turn_timing`.
- **Persona stale-while-revalidate.** `PersonaFetcher.get_block()` returns the
  cached block at once and refreshes in the background once the 60 s TTL
  passes. A failed refresh keeps the last good block; `/health` still reports
  the failure.

Still on the hot path, left for a follow-up: `OrchestratorLLM._current_model()`
(WARP-3047) makes a synchronous `GET /api/llm/models` (2 s timeout) once per
30 s TTL, inside the chat-body build.

## First-clause chunking (WARP-3729)

The persona pins one short spoken sentence per reply, so after Wave B the
first chunk was usually the whole reply: first audio waited for every token
of it plus the synthesis of the full sentence (Kokoro synthesizes a whole
`[.!?;:]`-delimited part before it writes any audio). `SentenceChunker` now
also ends a chunk at `;` or `:` followed by whitespace (the same parts Kokoro
already synthesizes separately, so the audio is unchanged), and ends the
FIRST chunk of an utterance at a `, ` once the clause is at least 24
characters long, the next word is not a number and at least 12 characters of
tail have arrived with no sentence end among them (so "The kitchen light is
on, yes." stays whole). The chunk after a clause cut is cut at its last comma
once 80 characters are buffered, so the remainder is synthesized before the
clause before it has finished playing. Expected gain, to be read from
`first_answer_audio_ms` on the box: about 0.3-0.4 s on a one-sentence reply
with a leading clause, 1.5-2 s on a long `:`/`;` sentence, nothing on a
comma-free sentence. The comma join is a standalone synthesis (a pitch reset
and a 150-250 ms pause); if it sounds wrong on the box, raise
`DEFAULT_FIRST_CLAUSE_MIN_CHARS` in `voice/text_chunk.py` to 30-40, or pass
`first_clause_min_chars=None` in `_speak_reply_stream` to go back to
sentence-only first chunks. No env var.
