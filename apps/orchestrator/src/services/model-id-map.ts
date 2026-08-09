/**
 * WARP-1749 (ADR-036 Phase 2) — the stored-model-id vocabulary map.
 *
 * WHAT THIS IS FOR
 * ----------------
 * Ollama and Docker Model Runner name the same weights differently. Ollama
 * says `gpt-oss:20b`; DMR says `ai/gpt-oss`, and REPORTS it fully qualified as
 * `docker.io/ai/gpt-oss:latest` (measured live 2026-08-05 against
 * `docker/model-runner:v1.2.6`).
 *
 * `droplet-local-LLM/services/ollama-manager/runtime/dmr.py` already translates
 * at the WIRE boundary, so a flipped box SERVES fine without touching a single
 * stored row. What it does not fix is that the rows we persisted under Ollama
 * then disagree with everything the runtime reports — and three places compare
 * the two:
 *
 *   1. `services/active-model.service.ts:85` — `installed.has(stored)`. A miss
 *      does not error; `resolveActiveChatModel` SILENTLY falls back to the
 *      first installed model (WARP-1511). The operator's explicit choice is
 *      replaced without a word.
 *   2. `routes/models.ts:143` — `installed.has(tag)` gates PATCH
 *      /api/models/active with a 400 `not_installed`.
 *   3. `apps/web-dashboard/src/app/chat/page.tsx:279` — `m.id === defaultModel`
 *      and the sibling "restore the model this conversation was held in" pass
 *      at :286-289, both keyed on `ChatSession.model`.
 *
 * This module is the ONE place that knows which Ollama id names the same model
 * as which OCI id. It is pure data + pure functions: no Prisma, no network, no
 * env reads. Nothing in the request path imports it — it is reached only from
 * `model-id-migration.service.ts` and the `model-id-migrate` CLI, so a bad row
 * here can never crash a running orchestrator.
 *
 * HOW THE TABLE WAS BUILT (every row is measured, none inferred)
 * -------------------------------------------------------------
 * The OCI side was verified against the real registry on 2026-08-05 with
 * `docker model search --source=dockerhub --limit=200 --json` (Docker Model
 * Runner CLI plugin v1.2.1) — the whole `ai/` namespace is 92 repositories.
 * Only ids that came back in that listing appear as a target below.
 *
 * That check is the entire reason this file is a TABLE and not a one-line
 * derivation. `dmr.py:to_runtime_id` derives `ai/<repo>` from `<repo>:<tag>`,
 * which is right for the models we ship and WRONG for exactly the vision ones:
 *
 *   - `ai/llava` DOES NOT EXIST. Verified: `docker model search llava` → empty.
 *   - `ai/llama3.2-vision` DOES NOT EXIST. Verified: `docker model search
 *     vision` returns qwen3-vl / ministral3 / kimi-k2.6 / mistral-small4 and no
 *     llama vision repo at all.
 *   - `ai/moondream` DOES NOT EXIST — the namespace carries `ai/moondream2`,
 *     which is a DIFFERENT model version, not a spelling variant.
 *
 * A derived migration would have rewritten those three stored ids into
 * references that resolve to nothing. They are `blocked` rows below: reported
 * loudly, never rewritten.
 */

/** Migration target: the OCI repository DMR serves this model from. */
export interface MappedModelRow {
  /** Ollama ids this appliance actually writes. Lowercased on index. */
  readonly ollamaIds: readonly string[];
  /**
   * Display names `prettify_ollama_name`
   * (`services/ai-gateway/providers/ollama_local.py:352`) produces for the
   * `ollamaIds` above. These are NOT decoration — see `ACTIVE_CHAT_MODEL_KEY`
   * note in `classifyModelId` for why a display name reaches the database.
   * Every string here was produced by running that function, not guessed.
   */
  readonly displayNames: readonly string[];
  /** The OCI repository. Verified present in the `ai/` namespace. */
  readonly oci: string;
  /** Why this row exists — file:line for the id we configure. */
  readonly evidence: string;
}

/** A model this appliance configures that DMR's catalog has no answer for. */
export interface BlockedModelRow {
  readonly ollamaIds: readonly string[];
  readonly displayNames: readonly string[];
  /** What the operator has to decide. Printed verbatim in the report. */
  readonly reason: string;
  readonly evidence: string;
}

/**
 * Ollama → OCI, for every model this appliance configures and DMR publishes.
 *
 * NOTE the many-to-one collapse: `gemma4:26b` and `gemma4:31b` both become
 * `ai/gemma4`; `qwen3-vl:8b` and `qwen3-vl:32b` both become `ai/qwen3-vl`. The
 * forward map is therefore LOSSY and cannot be inverted by lookup — which is
 * precisely why rollback reads a journal of what each row held before, and not
 * a reversed table. See `model-id-migration.service.ts`.
 *
 * The Ollama `:tag` is dropped rather than carried across, matching
 * `dmr.py:to_runtime_id`: an Ollama tag is a size/quantization selector inside
 * one repo, the OCI equivalent lives in the OCI tag, and we cannot derive one.
 * Fabricating `ai/gemma4:26b` would address a tag nobody has verified exists.
 */
export const MAPPED_MODEL_ROWS: readonly MappedModelRow[] = [
  {
    // The single-box default. `scripts/lib/single-box.sh:883` writes
    // `LLM_MODEL=gpt-oss:20b`; manifest `models/model-manifest.json` entry 1
    // carries `"default": true`.
    ollamaIds: ["gpt-oss:20b"],
    displayNames: ["Gpt-oss 20B"],
    oci: "ai/gpt-oss",
    evidence: "scripts/lib/single-box.sh:883 (LLM_MODEL); manifest default:true",
  },
  {
    // Both manifest gemma4 entries. One target: same repository, the Ollama
    // tag only chose a VRAM tier.
    ollamaIds: ["gemma4:26b", "gemma4:31b"],
    displayNames: ["Gemma 4 26B", "Gemma 4 31B"],
    oci: "ai/gemma4",
    evidence: "droplet-local-LLM/models/model-manifest.json (gemma4 26b + 31b)",
  },
  {
    ollamaIds: ["qwen3-vl:8b", "qwen3-vl:32b"],
    displayNames: ["Qwen 3-vl 8B", "Qwen 3-vl 32B"],
    oci: "ai/qwen3-vl",
    evidence: "droplet-local-LLM/models/model-manifest.json (qwen3-vl 8b + 32b)",
  },
  {
    ollamaIds: ["llama3.2:3b"],
    displayNames: ["Llama 3.2 3B"],
    oci: "ai/llama3.2",
    evidence: "droplet-local-LLM/models/model-manifest.json (llama3.2:3b, role fast)",
  },
  {
    // The voice assistant's model — this repo configures it, the manifest does
    // not carry it.
    ollamaIds: ["qwen2.5:3b-instruct"],
    displayNames: ["Qwen 2.5 3B Instruct"],
    oci: "ai/qwen2.5",
    evidence: "docker/docker-compose.yml:1909 (voice-io LLM_MODEL default)",
  },
] as const;

/**
 * Configured models with NO DMR equivalent. Left ALONE by the migration and
 * printed loudly, because after a flip these stop resolving entirely — that is
 * a product decision (drop the capability, or substitute a different model),
 * not something a rewrite can paper over.
 */
export const BLOCKED_MODEL_ROWS: readonly BlockedModelRow[] = [
  {
    ollamaIds: ["llama3.2-vision:11b", "llama3.2-vision"],
    displayNames: ["Llama 3.2-vision 11B"],
    reason:
      "No llama vision repository exists in the ai/ namespace (verified: `docker model search vision` returns qwen3-vl, ministral3, kimi-k2.6, mistral-small4 — no llama). Local chat-image vision has no DMR answer; either pick a listed VLM (ai/qwen3-vl is already mapped above) or accept OCR-only image handling.",
    evidence: ".env.example:213 (VISION_MODEL=llama3.2-vision:11b)",
  },
  {
    ollamaIds: ["llava:7b", "llava"],
    displayNames: ["Llava 7B"],
    reason:
      "`ai/llava` does not exist (verified: `docker model search llava` returns nothing). Same decision as llama3.2-vision.",
    evidence:
      "docs/superpowers/specs/2026-06-23-chat-image-vision-design.md:199; apps/orchestrator/src/__tests__/vision-attachments.service.test.ts:47",
  },
  {
    ollamaIds: ["moondream"],
    displayNames: ["Moondream"],
    reason:
      "The catalog carries `ai/moondream2`, NOT `ai/moondream`. moondream2 is a different model version, so mapping to it would silently swap the captioner behind the operator's back. Requires an explicit human decision, never an automatic rename.",
    evidence: "docs/ADR-003-rag-techniques-adoption.md:233",
  },
] as const;

/** Every OCI repository the forward map can produce. Membership set. */
export const TARGET_OCI_REPOSITORIES: ReadonlySet<string> = new Set(
  MAPPED_MODEL_ROWS.map((r) => r.oci),
);

// ── normalisation ────────────────────────────────────────────────────────
//
// Conceptually the same reduction as `dmr.py:_normalize_oci_reference` /
// `DmrRuntime.comparable_id`, deliberately NOT a port of it — see
// `stripRegistryHost` for the one place this diverges on purpose.

/** OCI's implicit default tag: carries no selection information. */
const IMPLICIT_TAG = "latest";

/**
 * True when an OCI reference's first path segment is a registry host.
 *
 * The OCI distribution spec's own rule: a first segment containing a `.` or a
 * `:` (port), or the literal `localhost`, is a host rather than a namespace.
 *
 * DIVERGENCE FROM THE ADAPTER (intentional). `dmr.py:_normalize_oci_reference`
 * only tests for a host when the reference has EXACTLY three segments, so
 * `docker.io/gpt-oss:latest` (two segments, first is a host) keeps its registry
 * prefix and normalises to `docker.io/gpt-oss` — a value that then compares
 * unequal to the same model under any other spelling. The instruction for this
 * ticket was to reuse the adapter's logic conceptually and not inherit its
 * bugs, so the host test here is applied at any depth ≥ 2.
 */
function isRegistryHost(segment: string): boolean {
  return segment.includes(".") || segment.includes(":") || segment === "localhost";
}

function stripRegistryHost(segments: string[]): string[] {
  if (segments.length >= 2 && isRegistryHost(segments[0]!)) {
    return segments.slice(1);
  }
  return segments;
}

/**
 * Reduce an OCI reference to the form we ADDRESS by: registry host dropped, a
 * meaningful tag KEPT, `:latest` dropped.
 *
 *   `docker.io/ai/gpt-oss:latest` → `ai/gpt-oss`
 *   `ai/smollm2:360M-Q4_K_M`      → `ai/smollm2:360m-q4_k_m`  (tag kept)
 *   `ai/gpt-oss`                  → `ai/gpt-oss`              (idempotent)
 *
 * Keeping a non-`latest` tag matters: an OCI tag selects a quantization, and
 * dropping it would name different weights than the caller asked for.
 *
 * The tag is only ever split off the LAST segment, so a registry port
 * (`localhost:5000/ai/x`) can never be mistaken for a tag.
 */
export function canonicalOciId(value: string): string {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return "";
  const segments = stripRegistryHost(normalized.split("/").filter(Boolean));
  if (segments.length === 0) return "";
  const last = segments[segments.length - 1]!;
  const colon = last.indexOf(":");
  const repository = colon === -1 ? last : last.slice(0, colon);
  const tag = colon === -1 ? "" : last.slice(colon + 1);
  segments[segments.length - 1] = tag === "" || tag === IMPLICIT_TAG ? repository : last;
  return segments.join("/");
}

/**
 * Reduce an OCI reference to bare `namespace/name` — the SET-MEMBERSHIP form,
 * mirroring `DmrRuntime.comparable_id`. Answers "is some build of this
 * repository the thing this row names?", never "which weights".
 *
 * Only ever used to recognise an ALREADY-migrated value. Never used to address
 * a model, and never written to a row.
 */
export function ociRepository(value: string): string {
  const canonical = canonicalOciId(value);
  if (!canonical) return "";
  const segments = canonical.split("/");
  const last = segments[segments.length - 1]!;
  const colon = last.indexOf(":");
  segments[segments.length - 1] = colon === -1 ? last : last.slice(0, colon);
  return segments.join("/");
}

// ── alias index ──────────────────────────────────────────────────────────

/**
 * Every spelling of an Ollama id that could plausibly be sitting in a column,
 * derived from one declared id.
 *
 *   `gpt-oss:20b` → `gpt-oss:20b`, `gpt-oss`, `library/gpt-oss:20b`
 *
 * The bare-repository alias is safe here even though it is coarse: the two
 * rows that share a repository (`gemma4`, `qwen3-vl`) share a TARGET too, so
 * the collapse cannot produce a wrong answer. `assertNoAliasConflicts` below
 * enforces that property instead of trusting it.
 *
 * `library/` is Ollama's registry-qualified form — `ollama_local.py:378`
 * documents seeing it, so it is a real shape, not a hypothetical.
 */
function aliasesForOllamaId(ollamaId: string): string[] {
  const id = ollamaId.trim().toLowerCase();
  const bare = id.includes(":") ? id.slice(0, id.indexOf(":")) : id;
  return [id, bare, `library/${id}`, `library/${bare}`];
}

type AliasTarget =
  | { readonly kind: "mapped"; readonly row: MappedModelRow }
  | { readonly kind: "blocked"; readonly row: BlockedModelRow };

function buildAliasIndex(): ReadonlyMap<string, AliasTarget> {
  const index = new Map<string, AliasTarget>();
  const claim = (alias: string, target: AliasTarget): void => {
    const key = alias.trim().toLowerCase();
    if (!key) return;
    const existing = index.get(key);
    if (existing) {
      // Same target twice is fine (two rows sharing a bare repository AND a
      // destination). Two different destinations is a table bug — fail at
      // import so the colocated test catches it, never at 3am on a box.
      const sameMapped =
        existing.kind === "mapped" &&
        target.kind === "mapped" &&
        existing.row.oci === target.row.oci;
      const sameBlocked =
        existing.kind === "blocked" && target.kind === "blocked" && existing.row === target.row;
      if (!sameMapped && !sameBlocked) {
        throw new Error(
          `model-id-map: alias "${key}" claimed by two different targets — the table is ambiguous`,
        );
      }
      return;
    }
    index.set(key, target);
  };

  for (const row of MAPPED_MODEL_ROWS) {
    const target: AliasTarget = { kind: "mapped", row };
    for (const id of row.ollamaIds) for (const a of aliasesForOllamaId(id)) claim(a, target);
    for (const name of row.displayNames) claim(name, target);
  }
  for (const row of BLOCKED_MODEL_ROWS) {
    const target: AliasTarget = { kind: "blocked", row };
    for (const id of row.ollamaIds) for (const a of aliasesForOllamaId(id)) claim(a, target);
    for (const name of row.displayNames) claim(name, target);
  }
  return index;
}

const ALIAS_INDEX = buildAliasIndex();

// ── classification ───────────────────────────────────────────────────────

/**
 * What the migration should do with one stored value.
 *
 *   `skip`    — blank. `ai.model.chat` seeds to `""`
 *               (`workspace-settings.service.ts:137`); that is the explicit
 *               "no choice yet" state, not a value to translate.
 *   `already` — already names a target OCI repository. Makes re-running the
 *               forward migration a no-op.
 *   `rewrite` — a known Ollama id. The only case that touches a row.
 *   `blocked` — a model WE configure that DMR cannot serve. Left alone, loud.
 *   `unknown` — anything else, including a model the customer pulled that we
 *               have never heard of. Left alone, listed. Never rewritten,
 *               never dropped.
 */
export type ModelIdClassification =
  | { readonly kind: "skip" }
  | { readonly kind: "already"; readonly oci: string }
  | { readonly kind: "rewrite"; readonly oci: string; readonly evidence: string }
  | { readonly kind: "blocked"; readonly reason: string; readonly evidence: string }
  | { readonly kind: "unknown" };

/**
 * Classify one stored model id.
 *
 * WHY DISPLAY NAMES ARE IN THE TABLE. The `ai.model.chat` WorkspaceSetting
 * does not reliably hold a model TAG. `ActiveModelPicker.tsx:92` calls
 * `choose(m.name)` with `LocalModelRow.name`, which
 * `models-summary.service.ts:142` populates from `ModelInfo.name` — the
 * PRETTIFIED display string (`ollama_local.py:546`), not the id. PATCH
 * /api/models/active accepts it because `localModelIdentifiers`
 * (`active-model.service.ts:49-57`) unions ids AND names into one set. So on
 * any box where somebody used the Models page picker, this setting holds
 * `"Gpt-oss 20B"`, not `"gpt-oss:20b"`. A migration that only knew tags would
 * classify the real-world value as `unknown` and quietly do nothing.
 *
 * Ordering is load-bearing: `already` is tested before `rewrite` so a second
 * forward run is a no-op rather than a re-translation.
 */
export function classifyModelId(value: string | null | undefined): ModelIdClassification {
  const raw = (value ?? "").trim();
  if (!raw) return { kind: "skip" };

  const repository = ociRepository(raw);
  if (repository && TARGET_OCI_REPOSITORIES.has(repository)) {
    return { kind: "already", oci: repository };
  }

  const hit = ALIAS_INDEX.get(raw.toLowerCase());
  if (hit?.kind === "mapped") {
    return { kind: "rewrite", oci: hit.row.oci, evidence: hit.row.evidence };
  }
  if (hit?.kind === "blocked") {
    return { kind: "blocked", reason: hit.row.reason, evidence: hit.row.evidence };
  }
  return { kind: "unknown" };
}

/** Exported for the colocated table-integrity test. */
export function aliasIndexSize(): number {
  return ALIAS_INDEX.size;
}
