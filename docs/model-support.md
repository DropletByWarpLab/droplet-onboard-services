# Local model support: what a model needs, and how to debug one on a box (WARP-3411)

**Read this when** a feature misbehaves only on some model, or before making a
new model active or shipping one. Runtime background is in
[ADR-036](ADR-036-inference-runtime-abstraction.md) and
[dmr-single-box.md](dmr-single-box.md). Whatever this page says about code,
check the code: the source wins.

The box ships **gpt-oss:20B** today. Other models (GLM-4.7-flash is pulled on
the lab box) can be made active from the Models page, and every server-side
feature follows the active model (`resolveActiveModel`,
`active-model.service.ts`): chat, the Daily report and other tool-spec
write-ups, email analysis, the brain. So a model that behaves differently
changes all of them at once.

## What the box adapts per model family

Model-specific switches live in ONE table in the ai-gateway,
`_THINKING_CONTROLS` in `services/ai-gateway/providers/ollama_local.py`
(WARP-3409, #2558). A caller asks for *what it wants* ("low thinking") and
the gateway sends each family its own control; `/ai/models` reports each
model's `thinking_control`. Add a family there. Don't special-case a model
in a caller. Every Daily report or tool-spec write-up asks for low thinking.

| Family | Thinking control | Verified |
|---|---|---|
| gpt-oss | `reasoning_effort` (top level, plus `chat_template_kwargs` on DMR, WARP-3123) | on the lab box |
| GLM-4.x | `chat_template_kwargs.enable_thinking=false` for low (DMR only) | on the lab box, 2026-09-30: the rendered prompt ends `<\|assistant\|><think>` by default and `<\|assistant\|></think>` with the flag |
| Qwen3 | the upstream template takes the same kwarg (renders an empty `<think></think>` block); a TODO in the table, not code | not on a served template |
| anything else | nothing sent | — |

## Known traps with local chat templates

On DMR the prompt is built by the **model's own jinja template** from the
GGUF, rendered by llama.cpp. Templates differ, and several of them silently
drop or reject things our code sends.

| Symptom | Cause | Where it is handled |
|---|---|---|
| Pins, attachments, per-chat or project instructions ignored; forced "answer now" came back blank | gpt-oss's template keeps **only the first system message**; later ones vanish | fold every system message into `messages[0]` on the wire (WARP-3338, #2545/#2553); forced answers are `user` messages (WARP-3285, #2538) |
| `developer` role: 422 from the gateway, or dropped | the gateway accepts system/user/assistant/tool only; DMR renders `developer` only at index 0; Ollama drops it | don't send `developer` |
| Every turn offering a tool fails with a 500 from the model runner | a tool schema `array` without `items` makes the gpt-oss template throw | WARP-3314 guard test `array-schema-items.guard.test.ts` |
| A write-up or answer comes back empty, or cut off, with `finish_reason: "length"` | a thinking model spent the whole `max_tokens` budget reasoning | per-family thinking control (table above). In the Daily report: one retry (capped, low thinking); a still-cut-off write-up is trimmed to its last full sentence, marked `truncated: true` and ends "This summary was cut short…"; an empty one becomes a plain per-source readout (`fallback: true`) |
| 422 `max_tokens … less than or equal to 4096` | the gateway caps `max_tokens` at 4096 (`services/ai-gateway/schemas.py`) | `completeOnce` clamps to the cap (Daily report fix) |
| Ollama box behaves differently from a DMR box | Ollama uses its own Go template: it merges every system message and drops `developer` | render on the box you're debugging |

## Measured: the Daily report write-up, per model

Replay of the failed 2026-09-30 run (7 sources, a 4,719-character prompt,
about 1,850 prompt tokens), 3 runs each, on the lab box (RTX 5060 Ti):

| Model and setting | Finished | Completion tokens | Time |
|---|---|---|---|
| GLM-4.7-flash, thinking on, 2,100 budget | 0/3 (cut off; 2 empty, 1 truncated) | 2,100 | 21–26 s |
| GLM-4.7-flash, thinking on, 4,096 budget | 3/3 | 2,038–3,488 | 20–54 s |
| **GLM-4.7-flash, `enable_thinking=false`** | **3/3** | **187–267** | **~2 s** |
| gpt-oss:20B, default effort, 2,100 budget | 5/6 over two replays (1 cut off) | 796–2,100 | 8–29 s |
| **gpt-oss:20B, low effort, 2,100 budget** | **3/3** | **319–341** | **3.3–3.9 s** |

Even gpt-oss at its default effort occasionally uses the whole budget on a
five-paragraph summary. Low effort produced write-ups of the same length in a
tenth of the tokens. Give thinking-light tasks (summaries, titles,
classification) low thinking through the table, and don't raise budgets.

## Debugging a model problem on a box

Everything below runs **on the box**, as root where it uses docker. All of it
is read-only.

1. **Which model actually ran.** The active model is the `ai.model.chat`
   WorkspaceSetting (the Models page writes it through
   `PATCH /api/models/active`, which also logs the change and unloads other
   models). A withheld domain's write-up runs on the local model even when a
   cloud model is active. The orchestrator's warn lines name the
   model.
2. **What the logs already tell you.** In `droplet-orchestrator-1`:
   - `tool-spec-summarizer` "summarizer returned empty content…", with the
     model, `finishReason` and `reasoningChars`;
   - `tool_spec_summary_fallback`: the write-up failed and the report went out
     as a plain readout (the step's trace has `fallback: true` and
     `fallbackReason`; a trimmed write-up has `truncated: true`). Sources
     that aren't connected never reach the prompt;
   - `tool-spec-runner` "tool spec run failed", with the step error;
   - `agent_blank_answer_retry` and `blankDiagnostics` for chat blanks;
   - `agent_system_fold_trimmed` and `agent_system_fold_over_cap` for the
     system-message fold.

   In `droplet-ai-gateway-1`, the request id links the orchestrator line to
   the model runner's status code.
3. **What the run gathered.** A Daily report or tool-spec run keeps its trace:
   ```bash
   sudo docker exec droplet-db-1 psql -U droplet -d droplet -Atc \
     "select trace from \"ToolRun\" where id='<run id>'"
   ```
4. **Replay the write-up on any model**, using the summarizer's real
   rendering, prompt and gateway client (WARP-3409; usage in its header):
   ```bash
   docker exec -i droplet-orchestrator-1 node - --run <run id> --thinking low \
     < scripts/model-support/replay-summary.mjs
   ```
   Compare models, budgets and thinking settings on the exact failed input
   before changing code.
5. **See the exact prompt the model receives:**
   ```bash
   sudo scripts/model-support/render-template.sh <model-tag> --props      # build + template hash
   sudo scripts/model-support/render-template.sh <model-tag> request.json # render a request
   sudo scripts/model-support/render-template.sh <model-tag> --template   # the raw template
   ```
   `request.json` is `{"messages": [...], "tools": [...], "chat_template_kwargs": {...}}`.
   Anything the template drops is simply absent from the output. The model
   must be loaded (make it active, or send it one chat). This talks to the
   llama-server socket inside `droplet-dmr`; the model runner's own HTTP API
   has no `/apply-template`.
6. **Whole-agent behaviour:** run the agent-loop eval on the box against the
   model (`tests/agent-loop-eval/bench-box.sh` with `MODEL=<tag>`; the suite
   lands with PR #2537), and compare with a gpt-oss run on the same box.

## Before making a new model active, or shipping it

- [ ] `render-template.sh --props` and `--template`: note the template hash in the ticket.
- [ ] Render a request with several system messages, a tool whose schema has an array, and a tool round. Check nothing our code relies on is dropped.
- [ ] Find its thinking control (render with and without the candidate kwarg), and add the family to the gateway table with a test.
- [ ] Replay a Daily report write-up (`replay-summary.mjs`) at the summarizer's budget: it must finish on the first call.
- [ ] Run the agent-loop eval (66 cases × 3). No regression against the gpt-oss baseline beyond noise; zero blank answers; zero hard-gate failures.
- [ ] Check tool calling (`capabilities.tools`): agent runs fall back to `LLM_MODEL` when a model states it can't call tools.
- [ ] Context: the box runs a 16k window (`LLAMA_ARG_CTX_SIZE`). Check the model's GGUF supports it.
- [ ] GPU: the model runner has no memory-aware eviction. Switch through the Models page (it unloads the old model), not by hand.

## Open items

- Qwen3 thinking control: unverified on a served template (no Qwen3 on the lab box).
- Scheduled routines with a write-up step fail on every fire: the schedule
  ticker runs specs without a summarizer (WARP-3410).
- Attachment text can carry instructions the model repeats (WARP-3405).
- The Mac and iOS apps kept a previously auto-picked chat model after the box's
  default changed, until relaunch. The fix is in DropletKit (auto-picked
  models follow the box default; explicit picks stick).
