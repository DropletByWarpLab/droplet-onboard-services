# Voice latency + wake-word plan (WARP-1430 epic)

> Goal (from Stefan, 2026-07-20): **speed up voice responses**, and make the
> wake word **"droplet"** (not just "Hey Droplet").
>
> This doc is the design of record for the epic. Each wave below is one child
> ticket → one PR through the Droplet agent harness. Nothing changes the shared
> model (`gpt-oss:20b`, the architecture-guard one-model rule stands). Every win
> here is streaming, prompt-shape, or wiring — not a model swap.

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

**Not the problem** (don't touch): Ollama `keep_alive` is a correct 24 h
(`docker-compose.yml:2080`); `max_iter:2` is already tuned down; `--beam-size 1`
is already greedy-optimal; STT is already 16 kHz-native with no disk I/O.

The single highest-leverage change is **#1 (streaming)** — the overview doc
already predicts it "would roughly halve perceived latency." Everything else
compounds on top.

## Wave A — Wake word: accept "droplet" **and** "Hey Droplet"

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
  the Vosk threshold at its 0.7 default (min per-word confidence over one word is
  weaker than over two) and re-run the living-room-TV soak.
- The timing-plausibility gate's 0.2 s span floor bites a clipped sub-200 ms
  "droplet"; that's a new (honest, logged) failure mode "Hey Droplet" never had.
- openWakeWord path is unaffected (it already falls back to `hey_jarvis` with no
  trained model); this change is Vosk-only, which is the shipping default.

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

## Sequencing & verification

Waves B/C/D/E all touch `voice/llm.py` and/or `pipeline.py`, so they sequence
(B → C → D → E, each rebased on the prior); **A is independent** and ships first.
Each wave is one ticket → one branch off `main` → one PR through the harness
(dev → qa → [ux] → manager → code-reviewer). **No merges to prod and no on-box
changes without sign-off** (hard rule 1). Box verification is the gated finale:
after the PRs merge, reflash `192.168.1.87` onto the new `main` and measure
time-to-first-audio + run the wake-word soak — plan-then-confirm.
