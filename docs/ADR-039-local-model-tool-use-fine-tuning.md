# ADR-039: Fine-tuning the local model for Droplet tool use — a LoRA adapter, trained off-box, gated by an eval this repo owns

**Status:** Proposed — no training has run. This ADR fixes the *shape* of the work and lands the first artifact (the dataset exporter, §7). Nothing here ships weights.
**Date:** 2026-08-14
**Deciders:** Engineering
**Builds on:** [ADR-036 (inference runtime abstraction)](ADR-036-inference-runtime-abstraction.md) — the adapter is a runtime artifact and inherits its distribution problem, [ADR-012 (phone-home egress control)](ADR-012-phone-home-egress-control.md), [ADR-003 (RAG techniques adoption)](ADR-003-rag-techniques-adoption.md) — the eval precedent this one copies.
**Companion (not yet written):** `droplet-local-LLM/docs/ADR-00X-tool-use-adapter-training.md` — the training half. **This ADR is deliberately incomplete without it**, and §6 says exactly where the seam is.
**Scope:** this repo owns the *data* and the *gate* — the canonical tool registry the model is being taught, the trajectory exporter, the redaction boundary, and the eval that decides whether an adapter is allowed to ship. The appliance repo owns the trainer, the GPU, the adapter artifact, and its lifecycle.

## Context — what is actually true today

**The model is `gpt-oss:20b`, and it is the same model everywhere.** `scripts/lib/secrets.sh:237-238` pins both defaults — `DROPLET_DEFAULT_DMR_MODEL=docker.io/ai/gpt-oss:20B-F16` and `DROPLET_DEFAULT_OLLAMA_MODEL=gpt-oss:20b` — and `scripts/lib/single-box.sh:1111` is where a provisioned box picks it up. `services/voice-io/docs/voice-latency-plan.md:8` records the constraint that makes this ADR tractable at all: the **one-model rule**. Voice and chat share the weights. An adapter that helps chat and hurts voice is a net loss, and §5's eval has to cover both or it is not a gate.

**Everything the model knows about operating a Droplet today is prompt-side.** There are ~130 tools in `packages/tools-core/src/registry.ts` (the canonical registry — `TOOLS`, `registry.ts:379`), of which roughly 68 are advertised in default chat after `apps/orchestrator/src/services/chat-tool-scope.ts` strips the rest. The steering for all 68 is one file: `apps/orchestrator/src/services/tool-guidance.service.ts`, 187 lines, one line per tool family, and its header comment states the problem this ADR exists to attack:

> Default chat advertises ~68 tools […] but the old inline guidance steered only 3 of them; small local models under-call the rest and do arithmetic mentally instead of calling `calculate`.

That file is also **hard-capped**. `TOOL_GUIDANCE_MAX_CHARS` (`prompt-budget.consts.ts`) bounds the render, and the header notes the guidance is folded into the never-dropped identity part of the WARP-1118 prompt estimate — *"every char here is permanent context cost on every turn."* This is the load-bearing fact: **prompt steering is a fixed, nearly-exhausted budget, and tool count only grows.** Teaching tool N+1 in the prompt costs context on every turn forever. Teaching it in the weights costs nothing at inference time. That asymmetry is the actual case for fine-tuning, and it is a stronger case than "the model is bad at tools."

**The failure modes are already enumerated in the source, by people who hit them.** They are not hypothetical and they are not uniform in kind:

| Failure | Evidence | Weights or prompt? |
|---|---|---|
| Writes directory paths with a trailing slash, constantly | `packages/tools-core/__tests__/handlers/files/_paths.test.ts:11`, `list-files.test.ts:67` (WARP-1373) | **Weights** — a syntactic habit, already worked around in the handler |
| Does arithmetic mentally instead of calling `calculate` | `tool-guidance.service.ts` (the "never do arithmetic in your head" mandate) | **Weights** — the prompt already says it, in the strongest terms available |
| Names a tool that `can()` strips → 3 guard-only iterations → failed turn | `tool-guidance.service.ts` WARP-642 invariant | **Prompt** — a scoping bug, fixed by gating; do NOT train it away |
| Harmony parser intermittently 500s | `services/ai-gateway/providers/ollama_local.py:392` (WARP-1333) | **Neither** — a runtime bug |
| Burns uncapped reasoning tokens before the first audible word | `services/voice-io/docs/voice-latency-plan.md:21`, `voice/llm.py:123` | **Neither** — fixed by `max_tokens` / `reasoning_effort` |

Three of five are not fine-tuning problems. That table is the honest scope: **fine-tuning is aimed at the two rows marked Weights, and the case for it is the context-budget asymmetry above, not a general "the model is bad" claim.** Anyone reading this ADR as authorization to train away the other three rows has misread it.

**The model is a reasoning model with a specific wire format.** `ollama_local.py:622-627` marks the `gpt-oss` family (`_REASONING_MODEL_MARKERS`) and `:837-840` maps `reasoning_effort` onto harmony's `Reasoning: <level>` directive; `services/ai-gateway/schemas.py:103-109` carries it on the request. Training data must round-trip *that* format, including the reasoning channel, or the adapter will be trained on a chat shape the box never actually sends.

**Real trajectories are already persisted, with a graded signal.** `apps/orchestrator/prisma/schema.prisma:453` — `ChatMessage` carries `toolCalls` (Json) and `toolCallId` (`:459-460`), `turnId` for grouping, `status` (`ChatMessageStatus`: `completed` / `failed` / `aborted` / `streaming` / `pending`, WARP-329), `model` + `provider` per turn (WARP-904), and `feedback` (`ChatMessageFeedback`: `up` / `down`, WARP-844 — whose own doc comment says it *"Feeds the admin RAG-eval loop"*). This is a labelled corpus that already exists. **It is also the single most dangerous asset in this design**, which is §3.

**We have an eval precedent and it is the right one to copy.** `services/rag-eval/` is a scheduled RAGAS service, opt-in via the `eval` Compose profile, running on a test box against the appliance's own local judge, with goldens in `tests/retrieval-eval/ragas/goldens.yaml`. Its README states the convention this ADR inherits verbatim: *"GitHub Actions does NOT run the eval […] GHA is for dev tasks, not for functionality that runs on the machine."* Given the hard CI spending limit in `docs/ci-cost-budget.md`, a GPU eval in Actions was never on the table.

**What does not exist: any measurement of tool-calling quality.** `rag-eval` measures retrieval. There is no golden set of "user says X → correct tool sequence Y", anywhere. That absence is the reason §5 is a blocker and not a follow-up.

## Decision

1. **Train a LoRA adapter on `gpt-oss:20b` for Droplet tool use.** Not a full fine-tune, not a distillation to a smaller model, not continued pre-training. LoRA because the adapter is small enough to version and ship independently of the ~13 GB base weights, and cheap enough to *retrain on every registry change* — which §4 shows is a hard requirement rather than a nicety.
2. **The dataset is synthetic-first, generated from the canonical registry.** Customer chat history is a *second, opt-in, redacted* source and is not required for v1. §3.
3. **This repo exports; the appliance repo trains.** The seam is a versioned on-disk dataset contract, §6.
4. **No adapter ships without passing a tool-use eval that lives in this repo.** §5. The eval is built *before* the trainer, not after.
5. **The adapter is per-release, not per-customer.** No on-box training, no federated anything, no customer-specific weights. §3 explains why this is a security decision and not a scoping one.

## §3 — The privacy constraint, which is the part that constrains everything else

The obvious training corpus is customer chat history. Using it naively would invert the founding thesis.

`CLAUDE.md`'s Foundation is explicit: *security and an air-gapped mentality first*, everything crossing the boundary *screened both ways (ingress threat, egress exfiltration), default-deny, audited*. `apps/orchestrator/src/lib/log-redaction.ts` encodes the operational rule in its header — **architecture-guard rule 19, no secrets in anything that leaves the box** — and it exists because the diagnostics bundle was the first thing that ever wanted to leave.

A training corpus is a diagnostics bundle with the safety removed. It is, by construction, the highest-value, highest-sensitivity export the appliance could ever produce: every file path, every device name, every calendar entry, every email subject the assistant ever touched, aggregated across customers, shipped to a GPU we control, and then **partially memorized into weights we ship back to every other customer.** Membership-inference and extraction attacks against fine-tuned LLMs are a mature literature; "the adapter is small" is not a defense.

So:

- **Redaction is mandatory and non-optional on every exported byte**, reusing `log-redaction.ts` rather than inventing a second notion of "secret" — that module's header is explicit that its entry points share `SENSITIVE_WORDS` precisely so they cannot drift, and a third consumer joins that discipline rather than forking it.
- **Which of the two entry points you use is load-bearing, and the obvious choice is the wrong one.** `redactSecrets` (`:175`) is a *text* scrub: it matches `PASSWORD=x`, bearer tokens, PEM blocks. It does **not** match `{"password":"x"}` — the JSON quote sits between the key and the colon its pattern requires — verified against the live implementation, not assumed. Tool arguments are exactly that shape, and `set_wifi_password` is a real registered tool. So structured values (call arguments, tool-result `data`) go through `redactSecretParams` (`:238`), which walks by key and additionally runs the text scrub over every string it passes; free prose uses the text scrub directly. `redactSecretParams`' own doc comment names `set_wifi_password → {iface_section, password}` as its motivating case, so this is the boundary it was built for. An exporter that ran the text scrub over `JSON.stringify(args)` would have shipped household Wi-Fi passphrases into a training corpus while appearing fully redacted.
- **Redaction is not anonymization, and this ADR does not pretend otherwise.** `redactSecrets` matches secret *shapes* — PEM blocks, bearer tokens, `*_PASSWORD=` assignments. It does not remove a person's name, a home address in a calendar event, or a child's bedroom named as a smart-home room. **There is no reliable scrubber for that class of content and we should stop looking for one.** This is precisely why the decision is synthetic-first: the synthetic corpus has no PII to fail to remove.
- **The exporter therefore refuses to emit customer content unless explicitly told to** (`--include-user-content`, §7), stamps provenance on every record, and prints the consequence at the point of use. The default output is the tool manifest, which is derived from `packages/tools-core/` and contains no customer data at all.
- **Customer traces, if ever used, are opt-in per deployment, exported by an operator, and reviewed before they leave.** That gate is deliberately manual. An automated trace pipeline is a phone-home channel wearing a lab coat, and ADR-012 exists to prevent exactly that.

**The synthetic corpus is where the leverage is anyway.** What we are teaching is *the shape of our tool surface* — 130 schemas, their `requiresWrite` / `requiresConfirmation` semantics (`packages/tools-core/src/types.ts:151-158`), and the routing between them. All of that is public-to-us, fully specified in the registry, and generable without a single customer utterance.

## §4 — Registry drift is the failure mode that kills adapters

Tools churn constantly in this repo; the WARP references scattered through `registry.ts` are the evidence. An adapter is a **frozen snapshot of the tool surface at training time.** Ship it against a registry that has moved and the model confidently emits calls to tools that no longer exist — landing straight in the hallucinated-tool guard the WARP-642 invariant describes, which costs three wasted iterations and a failed turn. The adapter would then be *worse than no adapter*, and worse in a way that looks like a model bug rather than a staleness bug.

Two mitigations, both mandatory:

- **Every dataset export records a registry fingerprint** — the sorted tool names plus a hash of their schemas — in the manifest (§7). The trainer stamps it into the adapter's metadata.
- **The eval (§5) fails closed on fingerprint mismatch.** An adapter whose fingerprint does not match the registry it is being evaluated against does not get a score; it gets a refusal. This mirrors `services/rag-eval/corpus_fingerprint.py`, which already does exactly this for the RAG corpus — the pattern is proven in-repo.

## §5 — The eval is a blocker, not a follow-up

Fine-tuning without an eval is unfalsifiable. We would be committing new weights to a two-year hardware lease cycle on the strength of a vibe.

The tool-use eval is a golden set of `{user request, conversation state, tool scope} → expected tool call(s)`, scored on:

- **Selection** — right tool, or correctly no tool. The "correctly no tool" negatives matter as much as the positives: an adapter that learns to always call something is a regression, and a positives-only eval cannot see it.
- **Arguments** — schema-valid against the registry's `inputSchema`, semantically right on the arguments that matter.
- **Sequencing** — multi-hop trajectories (`list_smart_home_devices` → `control_device`) in the right order.
- **Safety** — `requiresConfirmation` tools are never called without confirmation. **A regression here is disqualifying regardless of the aggregate score**, and it must be scored as a gate rather than folded into an average, because averaging lets a safety regression be bought with selection wins.
- **Voice parity** — the one-model rule means the voice path is scored too, or the gate is fiction.

It follows `rag-eval`'s shape: opt-in `eval` Compose profile, runs on a test box, never in GitHub Actions (`docs/ci-cost-budget.md`). Baseline the stock model first; that baseline is what any adapter must beat.

**Sequencing note.** §7's exporter is landing before this eval. That ordering is defensible only because the exporter is the input to *both* — the same tool manifest that feeds the trainer feeds the golden-set author, and neither can start without it. It is not license to train first and measure later.

## §6 — The cross-repo seam

Following ADR-036's split (this repo owns the consumer half, the appliance repo owns the runtime):

| Owned here | Owned in `droplet-local-LLM` |
|---|---|
| Canonical tool registry (`packages/tools-core/`) | Trainer (LoRA/SFT), GPU, hyperparameters |
| Dataset exporter + manifest contract (§7) | Synthetic trajectory generation from the manifest |
| Redaction boundary (§3) | Adapter artifact, versioning, fingerprint stamping |
| Tool-use eval + gate (§5) | Serving the adapter (DMR/Ollama adapter loading) |

The seam is the **dataset directory**: `tools.json` (registry manifest) + optional `trajectories.jsonl`, both described in §7. Everything crossing it is a file with a stable schema, which is what lets the two repos move independently.

**Serving is an open question and it is the appliance repo's to answer.** ADR-036 established that we speak the OpenAI-compat contract to whichever runtime is selected. Neither DMR nor Ollama exposes a first-class "load this LoRA adapter" knob on that contract — the likely answer is a merged-weights model artifact published through the same lifecycle as the base model, which drags in the weight-distribution hole ADR-036 §"Weight distribution" already records as open (`docs/security/allowed-egress.yaml` — *"No repo literal — the Ollama daemon owns the destination"*). **This ADR does not close that hole and must not be read as having closed it.** If the companion ADR cannot answer serving, the adapter cannot ship, and the honest outcome is that the §5 eval still pays for itself as a regression gate on prompt changes.

## Consequences

**Good.** Tool competence moves out of a nearly-exhausted per-turn context budget and into weights that cost nothing at inference. The eval (§5) is worth building even if training never happens — it makes every future change to `tool-guidance.service.ts` measurable, which today it is not.

**Bad.** A second artifact to version, fingerprint, and distribute, on a runtime that has no clean adapter story yet (§6). Retraining becomes a standing cost of adding a tool. And a fine-tuned model is harder to reason about than a prompt: when it misbehaves, the fix is a training run, not an edit.

**The failure we are most likely to actually have** is not a bad adapter — it is a *stale* one, silently degrading tool calls months after a registry change nobody connected to the model. §4 is the whole answer to that, and it is why the fingerprint is mandatory rather than advisory.

## §7 — What landed with this ADR

`npm run finetune-export` (`apps/orchestrator/src/cli/finetune-export.ts`, logic in `services/finetune-dataset.service.ts`).

**Default mode — tool manifest.** Emits `tools.json` from `@droplet/tools-core`: every tool's name, description, `inputSchema`, `requiresWrite`, `requiresConfirmation`, and domain, plus the §4 registry fingerprint. Derived entirely from the registry; **contains no customer data**, so it is safe to hand to the training repo unreviewed. This is the input to synthetic generation and to the §5 golden set.

**Opt-in mode — trajectories.** `--include-user-content` emits `trajectories.jsonl`, one curated turn per line in OpenAI-messages shape. Curation, each rule independently tested:

- terminal `status=completed` only — `failed` / `aborted` / `streaming` / `pending` turns are not targets;
- `feedback=down` turns dropped (an explicit negative label is not training data);
- turns containing a tool **error** result dropped;
- turns naming a tool absent from the current registry dropped (§4 drift, enforced per-record and not only in the manifest);
- turns with zero tool calls excluded by default (`--include-no-tool-turns` keeps them as negatives for §5's "correctly no tool" cases);
- redaction applied unconditionally, with no flag to turn it off: the text scrub on message content, the **structural** scrub on call arguments and tool-result data (§3 explains why mixing those two up leaks passphrases).

Every record carries provenance and the registry fingerprint. The mode prints the §3 warning at the point of use. **No training runs from this; it produces files.**

**Two known limitations of the trace path, both structural and neither fixable in the exporter.** They are recorded here because a trainer that assumes otherwise will produce a subtly mistrained adapter, and the cost of discovering that after a GPU run is much higher than the cost of reading this paragraph:

1. **The exported turn has no system message.** The base prompt — identity, plus the `tool-guidance.service.ts` render — is composed per request and never persisted; `ChatSession.systemPrompt` holds only the *caller-supplied* prompt. So a trace records what the model answered, not everything it was told. The trainer must reconstruct the system message from the current prompt builder, and must accept that it is reconstructing today's prompt for a turn that ran under an older one.
2. **The advertised tool scope for that turn is not recoverable.** `chat-tool-scope.ts` narrows the tool list per request from role and RBAC; the result is never persisted. A trace therefore cannot say which of the 132 tools the model could actually see when it chose. Training on the full manifest over-states the model's options and teaches it to pick from a menu it will not always be shown.

Both push in the same direction as §3: the synthetic corpus, where the system prompt and the tool scope are *chosen* rather than reconstructed, is the higher-quality data as well as the safer data. If persisting per-turn scope is ever wanted, that is a schema change with its own ticket, not a change to this exporter.
