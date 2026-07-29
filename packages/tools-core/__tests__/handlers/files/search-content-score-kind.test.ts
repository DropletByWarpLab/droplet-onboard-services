/**
 * WARP-1611 — `scoreKind` survives the search_content projection.
 *
 * WARP-1603 normalized the BGE reranker logit at the SOURCE
 * (`services/mcp-server/src/file-search.service.ts`) and stamped
 * `scoreKind: "similarity"` on each hit, but the tag stopped here:
 * `search_content` projects every hit onto a fixed field list, and
 * `scoreKind` was not on it. The browser therefore had to re-derive a
 * fact the server already knew.
 *
 * This projection is the only narrowing on the path from the retrieval
 * pipeline to the chip. The MCP envelope is JSON, and the orchestrator
 * relays the parsed result verbatim onto the SSE `tool_result` event
 * (`evt.data = parsed` in `apps/orchestrator/src/services/llm-agent.service.ts`),
 * so what this handler emits — after a JSON round-trip — is literally
 * what the browser's citation extractor reads. The tests below assert
 * against that round-tripped payload rather than the in-memory object
 * for exactly that reason.
 *
 * The load-bearing property is that the tag is OPTIONAL end to end:
 * absent must keep meaning "infer", so a producer that predates the tag
 * and a client that predates the tag both render exactly as they do now.
 */

import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getTool } from "../../../src/index.js";
import type { ScoreKind, ToolContext } from "../../../src/types.js";

function makeCtx(searchHybrid: ReturnType<typeof vi.fn>): ToolContext {
  return {
    prisma: {} as PrismaClient,
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    searchHybrid,
    userId: "alice",
    signal: new AbortController().signal,
  };
}

/**
 * One hit shaped exactly like `SearchHit` in mcp-server's
 * `file-search.service.ts` — the real producer on the other side of
 * `ctx.searchHybrid`. `scoreKind` is spread in last so a caller can
 * omit it and reproduce a pre-WARP-1603 hit verbatim.
 */
function makeHit(over: Record<string, unknown> = {}) {
  return {
    source: "nextcloud" as const,
    path: "/Docs/thermal-spec.md",
    chunkIdx: 3,
    pageNumber: null,
    brainItemId: null,
    score: 0.42555748318834,
    snippet: "the regulator derates above 70C...",
    metadata: null,
    ...over,
  };
}

/** The shape the browser reads a row back off the wire as. */
interface WireRow {
  source: string;
  path: string;
  chunkIdx: number;
  pageNumber: number | null;
  score: number;
  text: string;
  scoreKind?: ScoreKind;
}

/**
 * Run the real registered tool and return its rows as the client sees
 * them: JSON-serialized and re-parsed, which is what the MCP transport
 * does. The round-trip matters — a key whose value is `undefined`
 * vanishes in JSON, so only asserting on the in-memory object would let
 * a regression that emits `scoreKind: undefined` pass while producing a
 * payload that is NOT byte-identical to the pre-change one.
 */
async function project(hits: unknown[]): Promise<WireRow[]> {
  const tool = getTool("search_content")!;
  const res = await tool.handler(
    { query: "thermal derating" },
    makeCtx(vi.fn().mockResolvedValue(hits)),
  );
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  const wire = JSON.parse(JSON.stringify(res.data)) as {
    results: WireRow[];
  };
  return wire.results;
}

describe("search_content — scoreKind reaches the wire (WARP-1611)", () => {
  it("carries a source-stamped 'similarity' tag through to the client shape", async () => {
    // Exactly what mcp-server's `rerankPassages` hands back after
    // WARP-1603: the BGE logit -0.3 already sigmoid-squashed, tagged.
    const [row] = await project([
      makeHit({ score: 0.42555748318834, scoreKind: "similarity" }),
    ]);

    expect(row.scoreKind).toBe("similarity");

    // ...alongside every field the extractor already consumed, so the
    // tag is an addition to the row rather than a reshaping of it.
    expect(row).toEqual({
      source: "nextcloud",
      path: "/Docs/thermal-spec.md",
      chunkIdx: 3,
      pageNumber: null,
      score: 0.42555748318834,
      text: "the regulator derates above 70C...",
      scoreKind: "similarity",
    });
  });

  it("carries 'logit' too — the tag is not hardcoded to the normalized case", async () => {
    // No producer emits raw logits today, but the whole point of the
    // tag is that one could: a raw logit that happens to land inside
    // [0, 1] is indistinguishable from a cosine by value alone, and
    // would be silently mis-scaled by inference. The tag is what makes
    // that case decidable, so it has to survive the projection.
    const [row] = await project([
      makeHit({ score: 0.8, scoreKind: "logit" }),
    ]);
    expect(row.scoreKind).toBe("logit");
    expect(row.score).toBe(0.8);
  });

  it("preserves the tag per-row across a mixed result set", async () => {
    const rows = await project([
      makeHit({ path: "/a.md", scoreKind: "similarity" }),
      makeHit({ path: "/b.md" }),
      makeHit({ path: "/c.md", scoreKind: "logit" }),
    ]);
    expect(rows.map((r) => r.scoreKind)).toEqual([
      "similarity",
      undefined,
      "logit",
    ]);
  });
});

describe("search_content — untagged hits stay untagged (WARP-1611)", () => {
  it("omits the key entirely for a hit with no scoreKind", async () => {
    // Backward compatibility, stated precisely: a hit from a producer
    // that predates the tag must yield a row with NO `scoreKind` key —
    // not a key set to undefined/null — so the payload is unchanged
    // from before this ticket and the client's inference still runs.
    const [row] = await project([makeHit()]);

    expect("scoreKind" in row).toBe(false);
    expect(Object.keys(row).sort()).toEqual([
      "chunkIdx",
      "pageNumber",
      "path",
      "score",
      "source",
      "text",
    ]);
  });

  it.each([
    ["an unrecognized kind", "cosine"],
    ["an empty string", ""],
    ["null", null],
    ["a non-string", 7],
    ["an object", { kind: "logit" }],
  ])("drops %s rather than forwarding it", async (_label, bogus) => {
    // A tag the renderer does not understand is worse than no tag:
    // `relevancePct` treats any kind that isn't "logit" as an
    // already-bounded relevance, so forwarding "cosine" on a negative
    // logit would clamp the chip to 0% while looking authoritative —
    // the WARP-859 / WARP-1603 bug, reintroduced. Dropping falls back
    // to inference, which is the documented default.
    const [row] = await project([makeHit({ scoreKind: bogus })]);
    expect("scoreKind" in row).toBe(false);
  });
});

describe("search_content — the tagged row satisfies the client contract (WARP-1611)", () => {
  it("survives mcp-server → tools-core → citation-extractor read", async () => {
    // Replays the field reads `extractCitations` performs in
    // apps/web-dashboard/src/lib/hooks/useChat.ts against the
    // round-tripped payload. tools-core owns getting the tag ONTO the
    // wire (this ticket); teaching `ChatCitation` + `extractCitations`
    // to carry it the last hop into the chip lives in web-dashboard and
    // is deliberately out of this change's scope fence.
    const [row] = await project([
      makeHit({ score: 0.42555748318834, scoreKind: "similarity" }),
    ]);

    const citation = {
      source: row.source === "brain" ? "brain" : "nextcloud",
      path: row.path,
      pageNumber: row.pageNumber ?? null,
      score: typeof row.score === "number" ? row.score : undefined,
      snippet: row.text,
      scoreKind: row.scoreKind,
    };

    expect(citation.scoreKind).toBe("similarity");
    // The renderer can now assert the scale instead of deducing it, and
    // the score it renders is unchanged by the tag being present.
    expect(Math.round((citation.score as number) * 100)).toBe(43);
  });

  it("leaves an untagged row's citation with an undefined kind, which means 'infer'", async () => {
    const [row] = await project([makeHit({ score: 0.42555748318834 })]);
    expect(row.scoreKind).toBeUndefined();
    // Unchanged from today: no tag, so the client's `inferScoreKind`
    // decides — 0.4255 is inside [0, 1], so it reads as a bounded
    // relevance and renders 43%, exactly as it did before this change.
    expect(Math.round(row.score * 100)).toBe(43);
  });
});
