/**
 * WARP-2752 (ADR-051) — `business_find` reaches the brain.
 *
 * These are two ENUM VALUES on a tool that already ships, not two new tools,
 * and that is the point ADR-045 was arguing for: a new capability costs a
 * schema value rather than a registration against the full-registry ceiling
 * plus a DOMAIN_RULES keyword rule — the artifact forgotten three times
 * (WARP-2058 `pm`, WARP-2454 `team_chat`, WARP-2546's seven `crm_*`).
 *
 * What is worth pinning here is the projection, because it is the ONLY
 * narrowing between the database and the model:
 *
 *   money       stays a minor-unit STRING, like every other amount this tool
 *               returns — a JSON number here would be the one place amounts
 *               change type, against the tool's own promise
 *   evidence    is summarised, not passed through. A tool result is capped at
 *               8,000 chars; whole evidence arrays would fill it with three
 *               findings and the model would believe that was all of them
 *   scope       is exposed on a digest, so the model can tell a personal note
 *               from a company-wide fact instead of citing one as the other
 *   total       stays the SERVER's count even when the client filters, so a
 *               narrowed list never claims the corpus is smaller than it is
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ToolContext } from "../../../src/types.js";
import { expectOk } from "../../helpers/tool-result.js";
import businessFind from "../../../src/handlers/business/find.js";

const get = vi.fn();
const ctx = {
  http: { orchestrator: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() } },
} as unknown as ToolContext;

function res(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

const apiFinding = {
  id: "f1",
  kind: "loss",
  title: "Acme is 90 days past due",
  rationale: "An invoice fell due 90 days ago and still carries a balance.",
  impactMinor: "4000000",
  currency: "USD",
  status: "new",
  confidence: 80,
  detectorKey: "money.overdue-receivable",
  firstSeenAt: "2026-09-01T00:00:00.000Z",
  evidence: {
    sources: [
      { sourceKind: "erp_document", sourceId: "d1", quote: "quickbooks receivable, due 2026-06-01" },
      { sourceKind: "erp_document", sourceId: "d2", quote: "second source" },
    ],
  },
};

const apiDigest = {
  id: "g1",
  kind: "obligation",
  title: "Acme invoices are net 30",
  body: "The 2026 MSA sets payment terms at net 30 from delivery.",
  scope: "personal",
  confidence: 70,
  lastConfirmedAt: "2026-09-04T00:00:00.000Z",
  sources: [{ sourceKind: "file", sourceId: "1234", quote: "net 30 from delivery" }],
};

beforeEach(() => get.mockReset());

describe("business_find entity:finding (WARP-2752)", () => {
  it("defaults to open findings", async () => {
    // "What needs attention" means open work. Returning dismissed rows would
    // make the answer an archive rather than a to-do list.
    get.mockResolvedValueOnce(res(true, 200, { findings: [apiFinding], total: 1 }));
    await businessFind.handler({ entity: "finding" }, ctx);
    expect(get.mock.calls[0]![0]).toContain("status=new");
  });

  it("honours an explicit status", async () => {
    get.mockResolvedValueOnce(res(true, 200, { findings: [], total: 0 }));
    await businessFind.handler({ entity: "finding", status: "dismissed" }, ctx);
    expect(get.mock.calls[0]![0]).toContain("status=dismissed");
  });

  it("keeps money a minor-unit string", async () => {
    get.mockResolvedValueOnce(res(true, 200, { findings: [apiFinding], total: 1 }));
    const out = expectOk(await businessFind.handler({ entity: "finding" }, ctx));
    const f = (out.data as { findings: Array<Record<string, unknown>> }).findings[0]!;
    expect(f.impact_minor).toBe("4000000");
    expect(typeof f.impact_minor).toBe("string");
    expect(f.currency).toBe("USD");
  });

  it("summarises evidence instead of passing the whole array", async () => {
    // Three findings' worth of full evidence would fill the 8,000-char result
    // cap, and the model would take three problems for all of them.
    get.mockResolvedValueOnce(res(true, 200, { findings: [apiFinding], total: 1 }));
    const out = expectOk(await businessFind.handler({ entity: "finding" }, ctx));
    const f = (out.data as { findings: Array<Record<string, unknown>> }).findings[0]!;
    expect(f.evidence_count).toBe(2);
    expect(f).not.toHaveProperty("evidence");
    expect((f.evidence_first as { id: string }).id).toBe("d1");
  });

  it("carries a null impact through as null, not as zero", async () => {
    get.mockResolvedValueOnce(
      res(true, 200, {
        findings: [{ ...apiFinding, impactMinor: null, currency: null }],
        total: 1,
      }),
    );
    const out = expectOk(await businessFind.handler({ entity: "finding" }, ctx));
    const f = (out.data as { findings: Array<Record<string, unknown>> }).findings[0]!;
    expect(f.impact_minor).toBeNull();
  });
});

describe("business_find entity:digest (WARP-2752)", () => {
  it("exposes scope so the model can tell personal from company-wide", async () => {
    get.mockResolvedValueOnce(res(true, 200, { digests: [apiDigest], total: 1 }));
    const out = expectOk(await businessFind.handler({ entity: "digest" }, ctx));
    const d = (out.data as { digests: Array<Record<string, unknown>> }).digests[0]!;
    expect(d.scope).toBe("personal");
  });

  it("reports the MATCH count and names the window it searched", async () => {
    // The first draft returned the server's full corpus total beside a
    // filtered list, which said "I searched everything and found 1 of 2" when
    // what happened was "I searched the newest N and found 1". A model cannot
    // tell absence from an unsearched window unless the result says which.
    get.mockResolvedValueOnce(
      res(true, 200, {
        digests: [apiDigest, { ...apiDigest, id: "g2", title: "Unrelated", body: "x" }],
        total: 900,
      }),
    );
    const out = expectOk(await businessFind.handler({ entity: "digest", query: "net 30" }, ctx));
    const data = out.data as {
      digests: unknown[];
      total: number;
      searched: { most_recent: number; corpus_total: number };
      note?: string;
    };
    expect(data.digests).toHaveLength(1);
    expect(data.total).toBe(1);
    expect(data.searched).toEqual({ most_recent: 2, corpus_total: 900 });
    expect(data.note).toContain("older ones were not read");
  });

  it("reads the WIDEST page when searching, so the filter can match", async () => {
    // A client-side filter can only match what it fetched.
    get.mockResolvedValueOnce(res(true, 200, { digests: [], total: 0 }));
    await businessFind.handler({ entity: "digest", query: "lease" }, ctx);
    expect(get.mock.calls[0]![0]).toContain("limit=200");
  });

  it("omits the window note when it did read the whole corpus", async () => {
    get.mockResolvedValueOnce(res(true, 200, { digests: [apiDigest], total: 1 }));
    const out = expectOk(await businessFind.handler({ entity: "digest", query: "net 30" }, ctx));
    expect(out.data as { note?: string }).not.toHaveProperty("note");
  });

  it("returns everything when no query is given", async () => {
    get.mockResolvedValueOnce(res(true, 200, { digests: [apiDigest], total: 1 }));
    const out = expectOk(await businessFind.handler({ entity: "digest" }, ctx));
    expect((out.data as { digests: unknown[] }).digests).toHaveLength(1);
  });
});

describe("business_find brain entities — argument discipline (WARP-2752)", () => {
  it("refuses idle_days on a finding, by name", async () => {
    // The shared arg vocabulary is only safe because HONOURED_ARGS is per
    // entity; a silently-ignored filter is how a model learns to trust a
    // result that never applied it.
    const out = await businessFind.handler({ entity: "finding", idle_days: 30 }, ctx);
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).toContain("idle_days");
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses a free-text query on a finding", async () => {
    const out = await businessFind.handler({ entity: "finding", query: "acme" }, ctx);
    expect(out.ok).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it("still accepts status on a deal, which means something else there", async () => {
    // Same arg name, TWO vocabularies. HONOURED_ARGS decides whether an arg is
    // accepted; a second, entity-blind normalizer used to decide what it MEANS
    // and only knew the deal one — so every finding filter was refused before
    // its branch ran. These three cases pin the split.
    get.mockResolvedValueOnce(res(true, 200, { deals: [], total: 0 }));
    const out = await businessFind.handler({ entity: "deal", status: "OPEN" }, ctx);
    expect(out.ok).toBe(true);
  });

  it("refuses a DEAL vocabulary word on a finding", async () => {
    // "WON" must not pass here: a filter that silently matches nothing is
    // worse than a refusal, because the model believes the answer applied it.
    const out = await businessFind.handler({ entity: "finding", status: "WON" }, ctx);
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).toContain("acknowledged");
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses a FINDING vocabulary word on a deal", async () => {
    const out = await businessFind.handler({ entity: "deal", status: "dismissed" }, ctx);
    expect(out.ok).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it("accepts a finding status case-insensitively", async () => {
    get.mockResolvedValueOnce(res(true, 200, { findings: [], total: 0 }));
    await businessFind.handler({ entity: "finding", status: "Dismissed" }, ctx);
    expect(get.mock.calls[0]![0]).toContain("status=dismissed");
  });
});
