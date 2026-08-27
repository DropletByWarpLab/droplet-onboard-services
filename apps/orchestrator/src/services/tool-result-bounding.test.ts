/**
 * WARP-2203 — unit spec for the bounding step.
 *
 * The behavioural AC is proved on the ORCHESTRATOR path in
 * `__tests__/llm-agent.tool-result-bounding.test.ts`, because that is where the
 * original defect lived and where a handler-level test could never see it. This
 * file covers what that harness cannot reach cheaply: the verbatim fast path's
 * proof that it never parses, the exception branch, the refusal envelope's own
 * size, and the shape of the pure exports.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  boundToolResultForModel,
  boundControlEnvelopeForModel,
  MODEL_TOOL_RESULT_CAP_CHARS,
  CONTROL_ENVELOPE_CAP_CHARS,
  TRUNCATION_MARKER_KEY,
  CURSOR_KEYS,
  PAGING_ACCOUNTING_KEYS,
  COMPLETENESS_KEYS,
  type BoundingRefusal,
} from "./tool-result-bounding.js";

const CAP = MODEL_TOOL_RESULT_CAP_CHARS;

describe("the constants are the ones the rest of the system is calibrated against", () => {
  it("keeps the model tool-result cap at 8000", () => {
    // Moving this is a context-window change: `ai-gateway/schemas.py` caps a
    // message at 32,000 chars and a request at 128,000, and
    // `prompt-budget.consts.ts` sizes ITERATION_MIN_HEADROOM so that "one more
    // 8000-char tool result can't fit anyway". It belongs with the Phase 2
    // budget rail, not here.
    expect(MODEL_TOOL_RESULT_CAP_CHARS).toBe(8000);
  });

  it("keeps the marker key off every producer's namespace", () => {
    // `truncated` is a LIVE producer key in summarize-file.ts,
    // business/profile-get.ts and read-file.ts — colliding with it would
    // overwrite a producer's own honest flag.
    expect(TRUNCATION_MARKER_KEY).toBe("_orchestrator_truncation");
    expect(CURSOR_KEYS.has("truncated")).toBe(false);
    expect(COMPLETENESS_KEYS.has("truncated")).toBe(true);
  });

  it("keeps `next_weekday` and `total_mb` out of the exact-match sets", () => {
    // Both are live values a prefix rule would have eaten.
    expect(CURSOR_KEYS.has("next_weekday")).toBe(false);
    expect(PAGING_ACCOUNTING_KEYS.has("total_mb")).toBe(false);
    expect(PAGING_ACCOUNTING_KEYS.has("start_date")).toBe(false);
    expect(PAGING_ACCOUNTING_KEYS.has("start_time")).toBe(false);
  });
});

describe("the fast path is a pass-through, not a round-trip", () => {
  it("returns the input identity for anything at or under the cap", () => {
    const wire = JSON.stringify({ a: 1, b: "two" });
    expect(boundToolResultForModel(wire, "list_files")).toBe(wire);
  });

  it("does not even PARSE under the cap — malformed input comes back untouched", () => {
    // Proof the majority path costs nothing and changes nothing: a payload the
    // reducer could not possibly handle survives byte-for-byte.
    const junk = "Segmentation fault";
    expect(boundToolResultForModel(junk, "read_file")).toBe(junk);
  });

  it("treats the boundary as inclusive", () => {
    const wire = "x".repeat(CAP);
    expect(boundToolResultForModel(wire, "read_file")).toBe(wire);
    expect(boundToolResultForModel("x".repeat(CAP + 1), "read_file")).not.toBe("x".repeat(CAP + 1));
  });
});

describe("no path can hand the model something that is not JSON", () => {
  const cases: Record<string, string> = {
    "object root": JSON.stringify({ text: "T".repeat(20000) }),
    "array root": JSON.stringify(Array.from({ length: 900 }, (_, i) => `row-${i}-padding-padding`)),
    "string root": JSON.stringify("S".repeat(20000)),
    "number-keyed object": JSON.stringify(
      Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i])),
    ),
    "non-JSON stdio spew": "boom ".repeat(4000),
    "nulls and booleans": JSON.stringify({
      a: null,
      b: true,
      c: Array.from({ length: 800 }, () => null),
      d: "D".repeat(9000),
    }),
    "deeply nested": JSON.stringify(
      Array.from({ length: 30 }, () => ({ a: { b: { c: { d: "z".repeat(400) } } } })),
    ),
  };

  for (const [name, wire] of Object.entries(cases)) {
    it(`parses and fits: ${name}`, () => {
      const out = boundToolResultForModel(wire, "some_tool");
      expect(() => JSON.parse(out)).not.toThrow();
      expect(out.length).toBeLessThanOrEqual(CAP);
    });
  }
});

describe("the exception branch — what actually makes 'always valid JSON' true", () => {
  const realStringify = JSON.stringify;
  afterEach(() => {
    JSON.stringify = realStringify;
  });

  it("returns a valid-JSON refusal envelope and reports it when the reducer throws", () => {
    // The old `text.slice(0, 8000)` could not throw. A multi-hundred-line
    // walker can, and a reducer bug would otherwise become a DEAD TURN: the
    // model gets nothing back for a tool_call it is obliged to answer. Break
    // the first serialization only, so the refusal envelope can still be built.
    let calls = 0;
    JSON.stringify = ((...args: Parameters<typeof realStringify>) => {
      calls++;
      if (calls === 1) throw new Error("synthetic reducer fault");
      return realStringify(...args);
    }) as typeof JSON.stringify;

    const seen: BoundingRefusal[] = [];
    const out = boundToolResultForModel(
      realStringify({ text: "T".repeat(20000) }),
      "read_document_text",
      (r) => seen.push(r),
    );

    JSON.stringify = realStringify;
    const parsed = JSON.parse(out) as Record<string, unknown>;
    const marker = parsed[TRUNCATION_MARKER_KEY] as Record<string, unknown>;
    expect(marker.refused).toBe(true);
    expect(marker.reason).toBe("exception");
    expect(out.length).toBeLessThanOrEqual(CAP);

    expect(seen).toHaveLength(1);
    expect(seen[0].reason).toBe("exception");
    expect(seen[0].detail).toContain("synthetic reducer fault");
  });
});

describe("the refusal envelope is itself bounded and honest", () => {
  it("fits the cap even for a hostile tool name", () => {
    const wire = JSON.stringify(
      Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}_${"n".repeat(24)}`, 1])),
    );
    const seen: BoundingRefusal[] = [];
    const out = boundToolResultForModel(wire, "z".repeat(4000), (r) => seen.push(r));
    expect(out.length).toBeLessThanOrEqual(CAP);
    const marker = (JSON.parse(out) as Record<string, unknown>)[TRUNCATION_MARKER_KEY] as Record<
      string,
      unknown
    >;
    expect((marker.tool as string).length).toBeLessThanOrEqual(64);
    expect(marker.refused).toBe(true);
    expect(seen[0]).toMatchObject({ reason: "irreducible", inputChars: wire.length });
  });

  it("does not call back on a path that carried content", () => {
    const seen: BoundingRefusal[] = [];
    boundToolResultForModel(JSON.stringify({ t: "T".repeat(20000) }), "read_file", (r) =>
      seen.push(r),
    );
    expect(seen).toEqual([]);
  });
});

describe("the reduction loop terminates on adversarial input", () => {
  it("handles a multi-megabyte payload without running away", () => {
    const wire = JSON.stringify({
      rows: Array.from({ length: 20000 }, (_, i) => ({
        id: i,
        name: `row-${i}`,
        blob: "b".repeat(80),
      })),
    });
    expect(wire.length).toBeGreaterThan(2_000_000);
    const started = Date.now();
    const out = boundToolResultForModel(wire, "list_files");
    expect(Date.now() - started).toBeLessThan(4000);
    expect(out.length).toBeLessThanOrEqual(CAP);
    JSON.parse(out);
  });

  it("never grows the output relative to the cap, whatever the site mix", () => {
    for (let seed = 0; seed < 40; seed++) {
      const wire = JSON.stringify({
        a: "a".repeat(seed * 37),
        b: Array.from({ length: seed }, (_, i) => `v${i}`),
        c: { d: "d".repeat(seed * 53), e: seed },
        f: "f".repeat(9000 - seed * 11),
      });
      const out = boundToolResultForModel(wire, "search_content");
      expect(out.length).toBeLessThanOrEqual(CAP);
      JSON.parse(out);
    }
  });
});

describe("the assumption that makes the surrogate guard unreachable", () => {
  it("escapes a lone surrogate to six characters, not two", () => {
    // The `headString` surrogate guard cannot be killed by a mutation test, and
    // this is why: a stranded high surrogate costs SIX characters once
    // serialized (`\ud83d`) where the completed pair costs two, so cutting one
    // character further is always both legal and strictly shorter, and
    // `largestFitting`'s terminal `fits(lo) && !fits(lo + 1)` can never stop on
    // a split pair. That is a property of well-formed JSON.stringify (ES2019),
    // NOT of this module — so it is pinned here. If it ever stops holding, the
    // guard goes from defensive to load-bearing with no code change.
    const pair = "\u{1F642}";
    const lone = pair[0];
    expect(JSON.stringify(lone).length - 2).toBe(6);
    expect(JSON.stringify(pair).length - 2).toBe(2);
    expect(JSON.stringify(lone)).toContain("\\ud83d");
  });
});

describe("a reduction that cannot fit on its own is still a stepping stone", () => {
  it("combines reductions when no single site can reach the cap", () => {
    // Three comparable strings, 15 KB total. Cutting ANY one of them to zero
    // still leaves ~10 KB, so a rule that only ever probes sites which could
    // fit on their own probes nothing at all and refuses a payload that two
    // reductions handle comfortably.
    const wire = JSON.stringify({
      a: "A".repeat(5000),
      b: "B".repeat(5000),
      c: "C".repeat(5000),
    });
    const out = boundToolResultForModel(wire, "search_content");
    expect(out.length).toBeLessThanOrEqual(CAP);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    const marker = parsed[TRUNCATION_MARKER_KEY] as Record<string, unknown>;
    expect(marker.refused).toBeUndefined();
    const delivered = ["a", "b", "c"]
      .map((k) => (typeof parsed[k] === "string" ? (parsed[k] as string).length : 0))
      .reduce((x, y) => x + y, 0);
    expect(delivered).toBeGreaterThan(4000);
  });

  it("never records a reduction that did not shrink its site", () => {
    // The property the strict-progress rule enforces, asserted directly:
    // an entry in `reduced[]` that did not shorten anything is a claim the
    // payload was cut when it was not.
    const payloads = [
      JSON.stringify({ a: "A".repeat(5000), b: "B".repeat(5000), c: "C".repeat(5000) }),
      JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => `row ${i} text text`) }),
      JSON.stringify({ text: "T".repeat(20000), n: 5 }),
      JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ i, s: "s".repeat(50) }))),
    ];
    for (const wire of payloads) {
      const marker = (JSON.parse(boundToolResultForModel(wire, "t")) as Record<string, unknown>)[
        TRUNCATION_MARKER_KEY
      ] as { reduced?: { from: number; to: number }[] };
      for (const r of marker.reduced ?? []) expect(r.to).toBeLessThan(r.from);
    }
  });
});

describe("among candidates that fit, the one that DELIVERS MORE wins", () => {
  it("shortens the dominant element instead of emptying the array around it", () => {
    // The array is the heaviest site, and emptying it fits — so a "reduce the
    // largest site and stop" rule hands the model `rows: []`: zero characters
    // of the thing it asked for, from a payload that was 95% answer.
    const wire = JSON.stringify({ rows: ["R".repeat(9000), "a"] });
    const parsed = JSON.parse(boundToolResultForModel(wire, "search_content")) as {
      rows: string[];
    };
    expect(parsed.rows.length).toBe(2);
    expect(parsed.rows[0].length).toBeGreaterThan(6000);
    expect(parsed.rows[1]).toBe("a");
  });

  it("still trims the collection when trimming it is what delivers most", () => {
    // The mirror case: many comparable rows, so head-N on the array beats
    // mangling any single row.
    const wire = JSON.stringify({
      rows: Array.from({ length: 400 }, (_, i) => `row ${i} with a reasonable amount of text on it`),
    });
    const parsed = JSON.parse(boundToolResultForModel(wire, "search_content")) as {
      rows: string[];
    };
    expect(parsed.rows.length).toBeGreaterThan(50);
    expect(parsed.rows.length).toBeLessThan(400);
    // Whole rows, never a mangled one.
    expect(parsed.rows[0]).toBe("row 0 with a reasonable amount of text on it");
  });
});

describe("control envelopes ride a static rail, not the reducer", () => {
  it("passes a normal envelope through untouched", () => {
    const env = JSON.stringify({ status: "error", error: { code: "REPEATED_CALL" } });
    expect(boundControlEnvelopeForModel(env)).toBe(env);
  });

  it("slices at the static cap and nowhere else", () => {
    expect(boundControlEnvelopeForModel("y".repeat(CONTROL_ENVELOPE_CAP_CHARS + 500)).length).toBe(
      CONTROL_ENVELOPE_CAP_CHARS,
    );
  });
});
