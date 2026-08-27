# Model-id migration (WARP-1749, ADR-036 Phase 2)

Translating the model ids this box has **persisted** between the Ollama
vocabulary (`gpt-oss:20b`) and the Docker Model Runner vocabulary
(`ai/gpt-oss`).

> **This does not flip anything.** The runtime is selected by
> `INFERENCE_RUNTIME`, which resolves to `ollama` unless an operator sets it.
> This command only rewrites database rows, and only when explicitly run.

---

## 1. Do I need this at all?

**No, if you are not migrating the runtime.** A box on Ollama needs nothing
here, and a box that never runs the command behaves exactly as it does today.

**Not for the box to WORK, even after a flip.** The adapter in
`droplet-local-LLM/services/ollama-manager/runtime/dmr.py` translates ids at
the wire boundary, so a flipped box serves chat correctly with its old rows
untouched.

**Yes, for the box to stop lying to the operator.** After a flip, stored rows
disagree with everything the runtime reports, and three places compare the two:

| Comparison | What a mismatch does |
| --- | --- |
| `active-model.service.ts:85` — `installed.has(stored)` | **Silent.** `resolveActiveChatModel` falls back to the *first installed model* (WARP-1511). The operator's explicit choice is replaced with no error, no log, no badge. |
| `routes/models.ts:143` — `installed.has(tag)` | `PATCH /api/models/active` returns 400 `not_installed`. |
| `apps/web-dashboard/src/app/chat/page.tsx:279` + `:286-289` | The chat picker ignores `defaultModel`, and reopening an old conversation no longer restores the model it was held in. |

The first row is the reason this exists. A loud failure would need no
migration; a silent substitution does.

---

## 2. Ordering — flip FIRST, migrate SECOND

```
1.  Confirm Phase 0 (WARP-1741) passed on this hardware.
2.  Set INFERENCE_RUNTIME=dmr in .env and start the DMR compose profile.
3.  Verify: GET /api/models lists OCI ids (docker.io/ai/... ).
4.  npm run model-id-migrate            # report — changes nothing
5.  Read the report. Resolve every BLOCKED row.
6.  npm run model-id-migrate -- --apply
```

Rollback is the exact mirror — **migration first, runtime second:**

```
1.  npm run model-id-migrate -- --rollback
2.  Unset INFERENCE_RUNTIME (or set it to ollama) and stop the DMR profile.
```

### Why this order

Because step 3 is a gate. `--apply` rewrites rows into ids that **only DMR can
resolve**. Doing it before you have seen DMR actually serve on this hardware
means rewriting production rows for a runtime that might not stand up — and
then rolling them back. Migrating last means the destructive step happens only
after the risky step already succeeded.

### What breaks if you do it backwards

Neither order loses data, and neither order breaks chat — `resolveActiveChatModel`
falls back rather than failing. The damage is **silent wrongness**, which is
worse than an error because nothing announces it.

**Migrated too early** (rows are OCI, runtime is still Ollama):

- `ai.model.chat` holds `ai/gpt-oss`, which is not in Ollama's installed set →
  the active-model resolver silently substitutes the first installed model.
  The Models page shows a model the operator never chose, and shows it as if it
  were their choice.
- Every historical `ChatSession.model` names a model Ollama does not have, so
  reopening a conversation drops to the current default.
- `PATCH /api/models/active` still works (it validates against the live list),
  so an operator *can* fix the setting by hand — and by doing so will make it
  disagree with the journal, which then means `--rollback` correctly **skips**
  that row (see §5).

**Flipped without migrating** (rows are Ollama, runtime is DMR): the same
silent substitution, mirrored. Plus one extra, which is a real bug and not
just cosmetics:

- `model-readiness.service.ts:302-304` compares `LLM_MODEL` against the raw
  names from `/api/tags` with `present.has(model)`. Under DMR those names come
  back fully qualified (`docker.io/ai/gpt-oss:latest`), so the check **never**
  matches and `backgroundPull` fires **on every single boot**. That is the
  re-pull storm the WARP-193 guard exists to prevent, reintroduced by the
  vocabulary gap. Migrating the DB does not fix this one — it is an env-var
  comparison. Fix `LLM_MODEL` in `.env` at flip time (the report tells you
  what to set it to).

---

## 3. The mapping

Targets were verified against the live registry on 2026-08-05 with
`docker model search --source=dockerhub --limit=200 --json` (Docker Model
Runner CLI plugin v1.2.1). The `ai/` namespace is 92 repositories; only ids
that appeared in that listing are used.

| Stored (Ollama) | Becomes (OCI) | Source of the stored id |
| --- | --- | --- |
| `gpt-oss:20b` | `ai/gpt-oss` | `scripts/lib/single-box.sh:883` |
| `gemma4:26b` | `ai/gemma4` | model-manifest |
| `gemma4:31b` | `ai/gemma4` | model-manifest |
| `qwen3-vl:8b` | `ai/qwen3-vl` | model-manifest |
| `qwen3-vl:32b` | `ai/qwen3-vl` | model-manifest |
| `llama3.2:3b` | `ai/llama3.2` | model-manifest |
| `qwen2.5:3b-instruct` | `ai/qwen2.5` | `docker/docker-compose.yml:1909` |

Each row also matches the bare repository (`gpt-oss`), Ollama's
registry-qualified spelling (`library/gpt-oss:20b`), and the **prettified
display name** (`Gpt-oss 20B`) — see §6 for why that last one is not optional.

### BLOCKED — no DMR equivalent

These are left **exactly as stored** and reported loudly. They are a product
decision, not something a rewrite can resolve:

| Stored | Why |
| --- | --- |
| `llama3.2-vision:11b` (`.env.example:213`) | No llama vision repository exists in `ai/`. Verified: `docker model search vision` returns `ai/qwen3-vl`, `ai/ministral3`, `ai/kimi-k2.6`, `ai/mistral-small4` — no llama. |
| `llava:7b` | `ai/llava` does not exist. Verified: `docker model search llava` returns nothing. |
| `moondream` | The catalog has `ai/moondream2`, a **different model version**. Mapping to it would silently swap the captioner. |

> This is why the mapping is a table and not `ai/${repo}`. The derivation in
> `dmr.py:to_runtime_id` is right for everything we ship and wrong for exactly
> these three — a derived migration would have written `ai/llava` and
> `ai/llama3.2-vision`, references that resolve to nothing.

**If you use local chat-image vision, resolve this before flipping.** Either
point `VISION_MODEL` at a listed VLM (`ai/qwen3-vl` is already mapped) or
accept OCR-only image handling.

---

## 4. What gets touched, and what deliberately does not

**Migrated** — the three places a model id is actually persisted:

| Site | Column | Written by |
| --- | --- | --- |
| `WorkspaceSetting` where `key='ai.model.chat'` | `valueJson` | `routes/models.ts:158` |
| `ChatSession` | `model` | `chat-persistence.service.ts:433` |
| `ChatMessage` | `model` | `chat-persistence.service.ts:505,521` |

**Deliberately not touched:**

- **`ActivityRow` audit rows**, including the `previousModel`/`nextModel` refs
  from `routes/models.ts:177-182`. An audit log records what happened;
  rewriting history to match a later decision is the one thing it must never do.
- **`Camera.model`, `ApDevice.model`, `FabricMember.model`** — hardware model
  names. Same column name, unrelated vocabulary.
- **The Redis benchmark cache** (`benchCacheKey`,
  `model-benchmark.service.ts:46`). A TTL'd cache, not state. After a flip the
  key simply misses and the Models card shows `—` until somebody re-measures.
- **`.env` (`LLM_MODEL`, `VISION_MODEL`, `DEFAULT_MODEL`)** — operator-owned.
  The report tells you what each would become; the command never edits the file.
- **Embeddings.** `EMBEDDING_MODEL` defaults to `bge-small-en-v1.5`
  (WARP-2196; previously `all-MiniLM-L6-v2`)
  (`services/file-indexer/config.py:47`) and is served by ai-gateway's own
  sentence-transformers (`providers/embeddings.py:18`), never by Ollama. DMR
  does not serve it, **so no pgvector row needs re-embedding.** This is the
  single biggest thing that is *not* in the blast radius and it is worth saying
  out loud.

**Unmapped ids always survive.** A model a customer pulled themselves is
reported under "Unknown / customer-pulled" and left byte-for-byte as stored.
Nothing is ever dropped, and nothing is ever rewritten on a guess.

---

## 5. Reversibility

The forward map is **many-to-one**: `gemma4:26b` and `gemma4:31b` both become
`ai/gemma4`. `ai/gemma4` cannot tell you which tier a row held, so rollback
**cannot** be a reversed lookup table — it reads a journal of the actual
before-values (`ModelIdMigrationBatch` / `ModelIdMigrationEntry`, created empty
by `20260805120000_warp_1749_model_id_migration_journal`).

Both directions are idempotent, and not by a "has it run?" flag:

- `--apply` computes the plan from the values the rows hold **right now**, so a
  second run classifies them as already-migrated and writes nothing — no batch
  is even recorded.
- `--rollback` flips the forward batch's `state` to `reverted` (an explicit
  column, never inferred from the absence of a later row), so a second run
  finds no applied forward batch and no-ops.

**Rollback verifies before restoring.** If a row no longer holds the value the
forward run wrote — somebody re-pointed it by hand in between — that row is
**skipped and reported**, never dragged back over their edit.

---

## 6. Note: `ai.model.chat` may hold a display name, not a tag

Worth knowing before reading a report and thinking it is wrong.

`ActiveModelPicker.tsx:92` calls `choose(m.name)` with `LocalModelRow.name`,
which `models-summary.service.ts:142` populates from `ModelInfo.name` — the
**prettified display string** (`ollama_local.py:546`), not the id. `PATCH
/api/models/active` accepts it because `localModelIdentifiers`
(`active-model.service.ts:49-57`) unions ids *and* names into one set.

So on any box where somebody used the Models page picker, this setting holds
`"Gpt-oss 20B"`, not `"gpt-oss:20b"`. The mapping table carries the measured
display names for exactly this reason — without them the migration would
classify the real-world value as unknown and silently do nothing.

> Separately: `prettify_ollama_name("docker.io/ai/gpt-oss:latest")` produces
> `"Docker.io/ai/gpt-oss LATEST"`. After a flip the Models page will render
> that. Cosmetic, out of scope here, and its own ticket.

---

## 7. Commands

```bash
# In the orchestrator container.
npm run model-id-migrate                          # report (default) — changes nothing
npm run model-id-migrate -- --apply --note "..."  # forward, journaled
npm run model-id-migrate -- --rollback            # undo the last applied batch
npm run model-id-migrate -- --json                # machine-readable outcome
```

Exit codes: `0` did what was asked, `1` failed, `2` bad arguments. An
unrecognised flag is an error, never a silent fall-back to report — a typo'd
`--aply` must not leave you believing the box was migrated.
