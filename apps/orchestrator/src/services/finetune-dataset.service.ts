/**
 * ADR-039 §7 — dataset export for the tool-use LoRA adapter.
 *
 * Pure, synchronous, no Prisma, no filesystem. The CLI
 * (`src/cli/finetune-export.ts`) does the I/O; everything that decides
 * *what* is allowed into a training corpus lives here so the unit tests are
 * the authoritative proof rather than a manual read of an export.
 *
 * Two products, and the difference between them is the whole privacy story
 * (ADR-039 §3):
 *
 *   - {@link buildToolManifest} renders the canonical registry
 *     (`@droplet/tools-core`) as training input. It is derived entirely from
 *     committed source and contains NO customer data, which is why it is the
 *     default and needs no gate.
 *   - {@link curateTurn} turns a real conversation into a training record. It
 *     is gated behind an explicit CLI flag, and every string it emits goes
 *     through `redactSecrets` on the way out — architecture-guard rule 19,
 *     the same boundary the diagnostics bundle sits behind.
 *
 * TWO scrubs, and picking the wrong one silently leaks. `redactSecrets` is a
 * TEXT scrub: it matches `PASSWORD=x`, bearer tokens, PEM blocks — and it does
 * NOT match `{"password":"x"}`, because the JSON quote sits between the key and
 * the colon its pattern needs. Tool arguments are exactly that shape, and
 * `set_wifi_password` is a real tool in the registry. So structured values
 * (args, tool result `data`) go through `redactSecretParams`, which walks by
 * key and additionally runs `redactSecrets` over every string it passes; only
 * free prose (message content) uses the text scrub directly.
 *
 * NOT anonymization. Both scrubs match secret *shapes* and key *names*; neither
 * removes a person's name or a home address out of a calendar entry. ADR-039 §3
 * is explicit that no scrubber does, and that this is exactly why the corpus is
 * synthetic-first.
 *
 * ## WARP-2425 — the connector firewall, and why a scrub was not enough
 *
 * That last paragraph is the whole reason this section exists. A tool result is
 * rendered into the corpus by {@link renderToolResult} with its `data` intact,
 * scrubbed only for secret SHAPES and secret KEY NAMES. A `cloud_query_dataset`
 * result is a page of a customer's books — counterparty names, amounts, due
 * dates, email addresses — and NONE of that matches a secret pattern. It would
 * have gone into a LoRA training corpus in full, and weights do not forget.
 *
 * WARP-2425 asked for "a provable architectural firewall between connector data
 * and every weight-updating path". Two paths were audited and they are not in
 * the same condition:
 *
 *   erp-sync landing seam   CLEAN, structurally. `erp-sync.service.ts`'s
 *                           `runOneCursor` reads rows, extracts a POSITION and
 *                           discards them; `ErpEntityCache` still has zero
 *                           writers in the tree (ADR-041 §4 forbids a cloud
 *                           connector becoming its first while WARP-2028 is
 *                           open). Nothing lands, so nothing reaches the file
 *                           indexer's embedder — which walks Nextcloud files
 *                           and has no other source.
 *   LoRA export             NOT clean. This module. Fixed by
 *                           {@link CONNECTOR_RECORD_TOOLS} below.
 *
 * The fix is an EXCLUSION, not a redaction, and that choice is deliberate:
 * redacting the values would leave a record whose tool-call shape is right and
 * whose result teaches the model that this tool returns nothing, which is a
 * worse training target than no record at all. Dropping the turn costs a
 * tool-use example; keeping it costs a customer's ledger, permanently.
 */
import { createHash } from "node:crypto";
import { TOOLS, TOOL_CATALOG } from "@droplet/tools-core";
import type { PersistedToolCall } from "./chat-persistence.service.js";
import { redactSecrets, redactSecretParams } from "../lib/log-redaction.js";

// ---------------------------------------------------------------------------
// Tool manifest — the no-customer-data product
// ---------------------------------------------------------------------------

export interface ToolManifestEntry {
  readonly name: string;
  /** The agent-facing description, i.e. what the model is actually shown. */
  readonly description: string;
  readonly inputSchema: object;
  readonly requiresWrite: boolean;
  readonly requiresConfirmation: boolean;
  readonly domain: string;
}

export interface ToolManifest {
  /** ADR-039 §4 — pinned into the adapter and re-checked by the eval. */
  readonly fingerprint: string;
  readonly toolCount: number;
  readonly tools: readonly ToolManifestEntry[];
}

/**
 * ADR-039 §4 — a stable hash of the tool surface.
 *
 * Covers name, schema, and BOTH safety flags. The flags are in deliberately:
 * a tool that quietly stops requiring confirmation is a different training
 * target even though its schema is untouched, and an adapter trained before
 * that change must not silently pass the eval afterwards.
 *
 * Sorted by name so map iteration order can never move the hash.
 */
export function registryFingerprint(
  entries: readonly ToolManifestEntry[],
): string {
  const canonical = [...entries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({
      name: e.name,
      inputSchema: e.inputSchema,
      requiresWrite: e.requiresWrite,
      requiresConfirmation: e.requiresConfirmation,
    }));
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

/**
 * Join the two halves of the registry: `TOOL_CATALOG` owns the domain,
 * `TOOLS` owns the `inputSchema` (the catalog deliberately omits it — see its
 * header). A catalog entry with no live tool is skipped rather than emitted
 * half-formed; `tools-core`'s own `catalog.test.ts` already fails the build on
 * that drift, so this is a belt-and-braces guard, not a supported state.
 */
export function buildToolManifest(): ToolManifest {
  const entries: ToolManifestEntry[] = [];
  for (const cat of TOOL_CATALOG) {
    const tool = TOOLS.get(cat.name);
    if (!tool) continue;
    entries.push({
      name: cat.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      requiresWrite: tool.requiresWrite,
      requiresConfirmation: tool.requiresConfirmation,
      domain: cat.domain,
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return {
    fingerprint: registryFingerprint(entries),
    toolCount: entries.length,
    tools: entries,
  };
}

// ---------------------------------------------------------------------------
// Trajectories — the gated product
// ---------------------------------------------------------------------------

/** The `ChatMessage` columns this module reads. Structural on purpose: the
 *  tests construct these directly instead of standing up Prisma. */
export interface SourceMessage {
  readonly role: string;
  readonly content: string;
  readonly toolCalls: PersistedToolCall[] | null;
  readonly turnId: string | null;
  readonly status: string;
  readonly feedback: string | null;
  readonly model: string | null;
  readonly provider: string | null;
}

/** One user message and everything the assistant did in response. */
export interface Turn {
  readonly turnId: string | null;
  readonly messages: readonly SourceMessage[];
}

export type DropReason =
  /** Turn never reached a terminal `completed` state (WARP-329 lifecycle). */
  | "not_completed"
  /** Explicit thumbs-down (WARP-844). A labelled failure is not a target. */
  | "negative_feedback"
  /** A tool returned `ok:false` — the call was wrong or the tool was broken. */
  | "tool_error"
  /** Names a tool the current registry no longer has (ADR-039 §4). */
  | "unknown_tool"
  /** No tool calls, and negatives were not requested. */
  | "no_tool_calls"
  /** No user message, or no assistant reply — not a trainable exchange. */
  | "incomplete_exchange"
  /**
   * WARP-2425 — the turn read a customer's connected system of record.
   *
   * Its tool result carries rows from a connector (Xero invoices, HubSpot
   * contacts, a practice's schedule) that no scrub in this module removes,
   * because none of it looks like a secret. Excluded from every corpus this
   * module produces, flag or no flag.
   */
  | "connector_records";

export interface TrainingMessage {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly type: "function";
    readonly function: { readonly name: string; readonly arguments: string };
  }[];
  readonly tool_call_id?: string;
}

export interface TrainingRecord {
  readonly messages: readonly TrainingMessage[];
  readonly provenance: {
    readonly source: "chat-history";
    readonly turnId: string | null;
    readonly model: string | null;
    readonly provider: string | null;
    readonly feedback: string | null;
    readonly registryFingerprint: string;
  };
}

export type CurationOutcome =
  | { readonly kept: true; readonly record: TrainingRecord }
  | { readonly kept: false; readonly reason: DropReason };

/**
 * WARP-2425 — the tools whose RESULTS carry a customer's system-of-record rows.
 *
 * DERIVED from the catalog's own `domain` axis rather than hand-listed, so a
 * connector tool added later is inside the firewall the moment it is
 * catalogued — which is the property a hand-written list cannot have and the
 * reason the previous shape of this problem was invisible.
 *
 * Two domains, and each is the whole of its class:
 *   `cloud`  the SaaS connectors' single read tool (`cloud_query_dataset`),
 *            whose result is a page of Stripe / HubSpot / Mailchimp / Xero
 *            records.
 *   `erp`    the LAN practice-management reads. They answer ERP_NOT_CONNECTED
 *            today (WARP-2104), so they carry nothing yet — and they are in
 *            here precisely BECAUSE of that: the day that ticket wires them,
 *            they start returning PHI, and a firewall that had to be widened
 *            by hand on that day is a firewall that would not have been.
 *
 * NOT included, and stated so the boundary is legible rather than assumed:
 * the `crm` domain. Those tools read `crm.service.ts`, which is box-local
 * business data the owner entered (ADR-044), not a copy of a vendor's records.
 * If PartyLink ever lands connector rows into those tables, this set must grow
 * with it — that is a real follow-up, not a theoretical one.
 */
export const CONNECTOR_RECORD_TOOLS: ReadonlySet<string> = new Set(
  TOOL_CATALOG.filter((t) => t.domain === "cloud" || t.domain === "erp").map((t) => t.name),
);

export interface CurationOptions {
  /** Names in the registry the adapter will be evaluated against. */
  readonly knownTools: ReadonlySet<string>;
  /** Keep zero-tool turns as "correctly no tool" negatives (ADR-039 §5). */
  readonly includeNoToolTurns: boolean;
  readonly registryFingerprint: string;
}

/**
 * Split a session's messages into turns.
 *
 * A user message starts a turn; everything up to the next user message
 * belongs to it. Grouping is NOT keyed on `turnId` even though the column
 * exists — it is nullable (client-supplied, and null on every row written
 * before it existed), so keying on it would silently collapse every
 * pre-`turnId` conversation into one giant turn. `turnId` rides along as
 * provenance instead.
 *
 * Messages must already be ordered by `createdAt` — the caller's query owns
 * that (`@@index([sessionId, createdAt])`).
 */
export function groupTurns(messages: readonly SourceMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: SourceMessage[] | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      if (current) turns.push({ turnId: current[0].turnId, messages: current });
      current = [m];
      continue;
    }
    // Leading non-user rows (a system preamble, or a trailing fragment from a
    // truncated fetch) have no user message to answer — deliberately dropped.
    if (current) current.push(m);
  }
  if (current) turns.push({ turnId: current[0].turnId, messages: current });
  return turns;
}

/** Render a tool call's outcome as the `role:"tool"` content the model saw.
 *
 *  Reconstructed from the inlined result fields on `PersistedToolCall`
 *  (`ok` / `status` / `message` / `data`) rather than from the separate
 *  `role="tool"` rows. One source, always present on the assistant row, so
 *  reconstruction cannot depend on whether a given deployment persisted the
 *  companion rows.
 *
 *  Redacted STRUCTURALLY before stringify — `data` is arbitrary handler output
 *  and routinely carries secret-keyed fields that a text scrub over the encoded
 *  JSON would not see.
 *
 *  `call.confirmation` is read by NOTHING here, on purpose: it carries a live
 *  single-use `confirmationToken` (WARP-640) that stays valid server-side for
 *  its TTL. It is a credential, it teaches the model nothing, and it must not
 *  be widened into this record by a later "the chip renders it, so export it"
 *  edit. */
function renderToolResult(call: PersistedToolCall): string {
  if (call.ok === false) {
    return JSON.stringify(
      redactSecretParams({
        ok: false,
        status: call.status ?? "error",
        message: call.message ?? "",
      }),
    );
  }
  return JSON.stringify(
    redactSecretParams({ ok: true, data: call.data ?? null }),
  );
}

/**
 * Apply ADR-039 §7's curation rules to one turn.
 *
 * Rules are checked cheapest-and-most-decisive first so the drop-reason
 * histogram the CLI prints attributes each turn to its most fundamental
 * disqualifier: a `failed` turn reads as `not_completed`, not as whatever
 * tool error caused it to fail.
 */
export function curateTurn(
  turn: Turn,
  opts: CurationOptions,
): CurationOutcome {
  const user = turn.messages.find((m) => m.role === "user");
  const assistants = turn.messages.filter((m) => m.role === "assistant");
  if (!user || assistants.length === 0) {
    return { kept: false, reason: "incomplete_exchange" };
  }

  // WARP-329 lifecycle: only terminal-clean turns are targets. Checked across
  // every row in the turn — a completed final answer on top of a failed
  // intermediate step is still a turn that went wrong.
  if (turn.messages.some((m) => m.status !== "completed")) {
    return { kept: false, reason: "not_completed" };
  }
  if (assistants.some((m) => m.feedback === "down")) {
    return { kept: false, reason: "negative_feedback" };
  }

  const calls = assistants.flatMap((m) => m.toolCalls ?? []);
  if (calls.some((c) => c.ok === false)) {
    return { kept: false, reason: "tool_error" };
  }
  if (calls.some((c) => !opts.knownTools.has(c.name))) {
    return { kept: false, reason: "unknown_tool" };
  }
  // WARP-2425 — checked BEFORE any message is rendered, so a connector result
  // never reaches `renderToolResult` at all. Placing it after would mean the
  // rows had already been stringified into a `TrainingMessage` and the
  // exclusion would rest on the record being thrown away afterwards, which is
  // a promise rather than a boundary.
  if (calls.some((c) => CONNECTOR_RECORD_TOOLS.has(c.name))) {
    return { kept: false, reason: "connector_records" };
  }
  if (calls.length === 0 && !opts.includeNoToolTurns) {
    return { kept: false, reason: "no_tool_calls" };
  }

  const messages: TrainingMessage[] = [
    { role: "user", content: redactSecrets(user.content) },
  ];
  for (const a of assistants) {
    const aCalls = a.toolCalls ?? [];
    messages.push({
      role: "assistant",
      content: redactSecrets(a.content),
      ...(aCalls.length > 0
        ? {
            tool_calls: aCalls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: {
                name: c.name,
                // Structural scrub, NOT redactSecrets over the encoded string —
                // `{"password":"x"}` survives the text scrub (module header).
                arguments: JSON.stringify(redactSecretParams(c.args ?? {})),
              },
            })),
          }
        : {}),
    });
    for (const c of aCalls) {
      messages.push({
        role: "tool",
        tool_call_id: c.id,
        content: renderToolResult(c),
      });
    }
  }

  const last = assistants[assistants.length - 1];
  return {
    kept: true,
    record: {
      messages,
      provenance: {
        source: "chat-history",
        turnId: turn.turnId,
        model: last.model,
        provider: last.provider,
        feedback: last.feedback,
        registryFingerprint: opts.registryFingerprint,
      },
    },
  };
}

export interface CurationSummary {
  readonly kept: number;
  readonly dropped: Readonly<Record<DropReason, number>>;
}

export interface CurationRun {
  readonly records: readonly TrainingRecord[];
  readonly summary: CurationSummary;
}

const EMPTY_DROPS: Record<DropReason, number> = {
  not_completed: 0,
  negative_feedback: 0,
  tool_error: 0,
  unknown_tool: 0,
  no_tool_calls: 0,
  incomplete_exchange: 0,
  connector_records: 0,
};

/** Curate a whole session's worth of messages, keeping the drop histogram. */
export function curateMessages(
  messages: readonly SourceMessage[],
  opts: CurationOptions,
): CurationRun {
  const dropped = { ...EMPTY_DROPS };
  const records: TrainingRecord[] = [];
  for (const turn of groupTurns(messages)) {
    const outcome = curateTurn(turn, opts);
    if (outcome.kept) records.push(outcome.record);
    else dropped[outcome.reason] += 1;
  }
  return { records, summary: { kept: records.length, dropped } };
}

/** One JSON object per line, trailing newline. The JSONL the trainer reads. */
export function renderJsonl(records: readonly TrainingRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
}
