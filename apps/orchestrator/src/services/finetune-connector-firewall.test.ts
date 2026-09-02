/**
 * WARP-2425 — the architectural firewall between connector data and every
 * weight-updating path.
 *
 * ## What the audit found, so the next reader does not have to repeat it
 *
 * Two paths could carry a customer's connected system-of-record data into
 * something that changes model behaviour. They were not in the same condition.
 *
 *   **The erp-sync landing seam is clean, structurally.**
 *   `erp-sync.service.ts`'s `runOneCursor` reads rows, extracts a POSITION from
 *   them (`identify` → `highWaterMark`) and discards them. `ErpEntityCache` has
 *   ZERO writers in the tree — ADR-041 §4 forbids a cloud connector becoming
 *   its first while WARP-2028 is open, and every connector's docstring says so.
 *   Nothing lands, so nothing reaches the file indexer's embedder, which walks
 *   Nextcloud files (`services/file-indexer/watcher.py`) and has no other
 *   source. There is no vector store fed from a connector anywhere.
 *
 *   **The LoRA export was NOT clean.** `finetune-dataset.service.ts`
 *   `curateTurn` renders every successful tool call's `data` into the training
 *   corpus via `renderToolResult`, scrubbed only for secret SHAPES and secret
 *   KEY NAMES. A `cloud_query_dataset` result is a page of a customer's books —
 *   counterparty names, amounts, due dates, email addresses — and none of it
 *   matches a secret pattern. ADR-039 §3 states plainly that neither scrub
 *   anonymises. It would have gone into a training corpus in full.
 *
 * So the firewall is the exclusion in `CONNECTOR_RECORD_TOOLS`, and these tests
 * are what make it a boundary rather than an intention. Every test names the
 * mutation that must turn it red.
 */
import { describe, it, expect } from "vitest";

import { TOOL_CATALOG } from "@droplet/tools-core";
import {
  CONNECTOR_RECORD_TOOLS,
  curateMessages,
  curateTurn,
  type CurationOptions,
  type SourceMessage,
} from "./finetune-dataset.service.js";

const OPTS: CurationOptions = {
  knownTools: new Set(TOOL_CATALOG.map((t) => t.name)),
  includeNoToolTurns: true,
  registryFingerprint: "test-fingerprint",
};

/**
 * A turn whose tool result carries a customer's ledger.
 *
 * The row is obviously fictional, and deliberately shaped like a real one: the
 * point of the test is that NOTHING here looks like a secret, so no scrub in
 * that module removes any of it.
 */
function ledgerTurn(toolName: string): SourceMessage[] {
  return [
    {
      role: "user",
      content: "who still owes us money?",
      status: "completed",
    } as SourceMessage,
    {
      role: "assistant",
      content: "Two customers have open invoices.",
      status: "completed",
      toolCalls: [
        {
          id: "call-1",
          name: toolName,
          args: { dataset: "invoice" },
          ok: true,
          data: {
            dataset: "invoice",
            provider: "xero",
            rows: [
              {
                invoice_id: "INV-0042",
                customer_id: "Fictional Widgets Ltd",
                amount: 1250.5,
                balance: 500.25,
              },
            ],
          },
        },
      ],
    } as unknown as SourceMessage,
  ];
}

describe("the connector-record tool set is derived, not hand-listed", () => {
  it("covers every tool in the cloud and erp domains", () => {
    // Derived from the catalog's own `domain` axis so a connector tool added
    // later is inside the firewall the moment it is catalogued.
    // Mutation: hand-list `["cloud_query_dataset"]` → the `erp_*` reads fall
    // outside, and the day WARP-2104 wires them they start putting a practice's
    // PHI into a training corpus with nothing saying so.
    const expected = TOOL_CATALOG.filter(
      (t) => t.domain === "cloud" || t.domain === "erp",
    ).map((t) => t.name);
    expect([...CONNECTOR_RECORD_TOOLS].sort()).toEqual([...expected].sort());
    expect(CONNECTOR_RECORD_TOOLS.has("cloud_query_dataset")).toBe(true);
    expect(CONNECTOR_RECORD_TOOLS.size).toBeGreaterThan(1);
  });

  it("does NOT sweep in the box-local tools", () => {
    // The boundary has to be legible in both directions. `crm_*` reads
    // `crm.service.ts` — business data the owner entered (ADR-044) — not a
    // copy of a vendor's records, and excluding it would silently delete most
    // of the corpus.
    // Mutation: widen the filter to every domain → nothing is ever curated and
    // the export becomes the tool manifest alone.
    expect(CONNECTOR_RECORD_TOOLS.has("crm_search_customers")).toBe(false);
    expect(CONNECTOR_RECORD_TOOLS.has("business_profile_get")).toBe(false);
    expect(CONNECTOR_RECORD_TOOLS.has("get_system_health")).toBe(false);
  });
});

describe("a turn that read a connected system of record never enters the corpus", () => {
  it("drops the turn, with its own named reason", () => {
    // Mutation: delete the `CONNECTOR_RECORD_TOOLS` check in `curateTurn` →
    // `kept: true`, and the record below carries the customer's ledger.
    const outcome = curateTurn(
      { turnId: "t1", messages: ledgerTurn("cloud_query_dataset") },
      OPTS,
    );
    expect(outcome).toEqual({ kept: false, reason: "connector_records" });
  });

  it("emits no message carrying the row, not even a redacted one", () => {
    // The exclusion is checked BEFORE any message is rendered, so the rows
    // never reach `renderToolResult` at all. Mutation: move the check after
    // the render loop → this still passes on the return value while the
    // stringified ledger has already been built, and the guarantee becomes
    // "we threw it away afterwards" rather than "we never made it".
    const run = curateMessages(ledgerTurn("cloud_query_dataset"), OPTS);
    expect(run.records).toHaveLength(0);
    expect(run.summary.dropped.connector_records).toBe(1);
    const encoded = JSON.stringify(run);
    expect(encoded).not.toContain("Fictional Widgets Ltd");
    expect(encoded).not.toContain("INV-0042");
    expect(encoded).not.toContain("1250.5");
  });

  it("drops an ERP turn on the same rule, before those tools carry anything", () => {
    // They answer ERP_NOT_CONNECTED today (WARP-2104), which is exactly why
    // they are inside the firewall NOW: a boundary that has to be widened on
    // the day the data starts flowing is a boundary that would not have been.
    // Mutation: restrict the set to the `cloud` domain → red.
    const outcome = curateTurn(
      { turnId: "t2", messages: ledgerTurn("erp_find_patient") },
      OPTS,
    );
    expect(outcome).toEqual({ kept: false, reason: "connector_records" });
  });

  it("still keeps an ordinary tool turn", () => {
    // The firewall must not become a reason nothing is ever curated. Mutation:
    // invert the membership test → the corpus loses every turn that is safe
    // and keeps every turn that is not.
    const messages: SourceMessage[] = [
      { role: "user", content: "how is the box doing?", status: "completed" } as SourceMessage,
      {
        role: "assistant",
        content: "All healthy.",
        status: "completed",
        toolCalls: [
          { id: "c", name: "get_system_health", args: {}, ok: true, data: { ok: true } },
        ],
      } as unknown as SourceMessage,
    ];
    const run = curateMessages(messages, OPTS);
    expect(run.records).toHaveLength(1);
    expect(run.summary.dropped.connector_records).toBe(0);
  });
});

describe("the erp-sync landing seam has nothing to firewall", () => {
  it("has no writer for ErpEntityCache anywhere in the orchestrator", async () => {
    // The other half of the audit, pinned so a future ticket cannot quietly
    // land connector rows and reopen the embedding path.
    // Mutation: add `prisma.erpEntityCache.create(...)` anywhere under src/ →
    // red, and ADR-041 §4 is violated at the same moment (WARP-2028 is open,
    // so the model's promised encryption does not exist).
    const { execFileSync } = await import("node:child_process");
    const { resolve } = await import("node:path");
    // `process.cwd()` rather than `import.meta.url`: this workspace's tsc
    // targets CommonJS, where `import.meta` is a compile error (TS1470), and
    // `tool-scope-claim-trust.guard.test.ts` already resolves its scan root
    // this way. Vitest's root is `apps/orchestrator`.
    const srcRoot = resolve(process.cwd(), "src");
    let out = "";
    try {
      out = execFileSync(
        "grep",
        // PRODUCTION source only. A test file naming the model — including
        // this one, in the comment above — is not a writer, and a scanner that
        // could not tell them apart would make the boundary undocumentable.
        ["-rIn", "--include=*.ts", "--exclude=*.test.ts", "erpEntityCache", srcRoot],
        { encoding: "utf8" },
      );
    } catch {
      // grep exits 1 on no match, which is the passing case.
      out = "";
    }
    const writes = out
      .split("\n")
      .filter((line) => /erpEntityCache\s*\.\s*(create|createMany|upsert|update|updateMany)/.test(line));
    expect(writes).toEqual([]);
  });
});
