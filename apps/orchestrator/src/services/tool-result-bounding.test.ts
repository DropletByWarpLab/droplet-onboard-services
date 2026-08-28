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
  CURSOR_BASE_KEYS,
  COLLECTION_TOTAL_KEYS,
  MIN_REDUCIBLE_STRING,
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

describe("control envelopes bound JSON-safely, never a raw slice (WARP-2525)", () => {
  it("passes a normal envelope through untouched", () => {
    const env = JSON.stringify({ status: "error", error: { code: "REPEATED_CALL" } });
    expect(boundControlEnvelopeForModel(env)).toBe(env);
  });

  it("bounds an oversize JSON envelope to VALID JSON under the envelope cap", () => {
    // The previous rail was `text.slice(0, 4000)` — the exact defect this
    // module exists to fix for tool results: cutting JSON at a character
    // count yields invalid JSON and deletes every field after the cut.
    const env = JSON.stringify({
      status: "error",
      error: {
        code: "FORBIDDEN_TOOL",
        detail: "x".repeat(CONTROL_ENVELOPE_CAP_CHARS * 2),
      },
    });
    const out = boundControlEnvelopeForModel(env);
    expect(out.length).toBeLessThanOrEqual(CONTROL_ENVELOPE_CAP_CHARS);
    const parsed = JSON.parse(out) as Record<string, unknown>; // must not throw
    // The envelope's own identity survives — only the oversize detail shrank.
    expect(parsed.status).toBe("error");
    const m = parsed[TRUNCATION_MARKER_KEY] as Record<string, unknown>;
    expect(m).toBeDefined();
    // The marker is honest about WHICH cap did the cutting.
    expect(m.cap_chars).toBe(CONTROL_ENVELOPE_CAP_CHARS);
    expect(m.tool).toBe("control_envelope");
  });

  it("wraps an oversize non-JSON envelope instead of cutting it mid-string", () => {
    const out = boundControlEnvelopeForModel("y".repeat(CONTROL_ENVELOPE_CAP_CHARS + 500));
    expect(out.length).toBeLessThanOrEqual(CONTROL_ENVELOPE_CAP_CHARS);
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

function marker(wire: string, tool = "read_file"): Record<string, unknown> {
  const parsed = JSON.parse(boundToolResultForModel(wire, tool)) as Record<string, unknown>;
  return parsed[TRUNCATION_MARKER_KEY] as Record<string, unknown>;
}

function bounded(wire: string, tool = "read_file"): Record<string, unknown> {
  return JSON.parse(boundToolResultForModel(wire, tool)) as Record<string, unknown>;
}

describe("a cursor is recomputed only from numbers the PRODUCER published", () => {
  it("does not infer a base out of two unrelated integers that happen to add up", () => {
    // The over-claim this rule exists to stop, verbatim. `3000 + 9000 === 12000`,
    // so an "any numeric sibling may be the base" rule infers base 3000 and
    // emits `next_offset: 10379` beside 7379 delivered characters — a cursor
    // 3,000 characters past the end of a body the model just received in
    // shortened form. Neither `a` nor `b` is paging-named, so there is nothing
    // to corroborate a base and the cursor has to go.
    const out = bounded(
      JSON.stringify({
        path: "/a.md",
        content: "A".repeat(9000),
        offset: 0,
        next_offset: null,
        a: 3000,
        b: 12000,
      }),
    );
    expect(out).not.toHaveProperty("next_offset");
    expect(JSON.stringify(out)).not.toContain("10379");
  });

  it("refuses to recompute when a SECOND comparable body could own the cursor", () => {
    // `next_offset - offset === sidecar.length`, so the arithmetic closes over
    // `sidecar` exactly — while the cursor actually describes `content`, which
    // the model received IN FULL. Recomputing here told it to resume at 4365,
    // silently skipping characters 3000-4364.
    const out = bounded(
      JSON.stringify({
        path: "/a.md",
        content: "C".repeat(3000),
        sidecar: "S".repeat(9000),
        offset: 0,
        next_offset: 9000,
        chars_total: 40000,
      }),
    );
    expect(out).not.toHaveProperty("next_offset");
    expect(JSON.stringify(out)).not.toContain("4365");
  });

  it("requires the base to be PUBLISHED, not assumed to be zero", () => {
    // Page-one `read_file` arithmetic with no `offset` field: the producer
    // never said what this cursor counts from, so we do not get to decide.
    const out = bounded(
      JSON.stringify({ path: "/a.md", content: "A".repeat(10000), next_offset: 10000 }),
    );
    expect(out).not.toHaveProperty("next_offset");
  });

  it("recomputes when the base IS published", () => {
    const out = bounded(
      JSON.stringify({
        path: "/a.md",
        content: "A".repeat(10000),
        offset: 0,
        next_offset: 10000,
        chars_total: 90000,
      }),
    );
    expect(out.next_offset).toBe((out.content as string).length);
  });

  it("keeps a VERIFIED recompute when a sibling cursor fails and is deleted (WARP-2525)", () => {
    // One level, two cursor-shaped keys: `next_offset` recomputes against the
    // producer's own published base (0 + delivered), `cursor` is an opaque
    // string nothing can verify. The sweep used to delete EVERY cursor-shaped
    // key at the level the moment ONE failed — throwing away the one resume
    // point this pass had just checked against the producer's own numbers.
    // Only the keys that actually failed may go (plus the accounting group a
    // survivor could use to reconstruct a FAILED cursor).
    const out = bounded(
      JSON.stringify({
        content: "C".repeat(9000),
        offset: 0,
        next_offset: 9000,
        cursor: "opaque-resume-token-under-40ch",
      }),
    );
    // The verified recompute survives, still arithmetically honest.
    expect(typeof out.next_offset).toBe("number");
    expect(out.next_offset).toBe((out.content as string).length);
    // The key that actually failed is deleted…
    expect(out).not.toHaveProperty("cursor");
    // …and the accounting group still goes with it: `offset` would let the
    // model reconstruct the DELETED cursor, and that reconstruction is wrong.
    expect(out).not.toHaveProperty("offset");
    const m = out[TRUNCATION_MARKER_KEY] as Record<string, unknown>;
    expect(m.recomputed_keys).toContain("next_offset");
    expect(m.removed_keys).toContain("cursor");
  });

  it("will not let a BYTE total corroborate a CHARACTER cursor", () => {
    // `read_file` reports `bytes_total` beside `chars_total`, and on any
    // non-ASCII file the two differ. Letting bytes corroborate would make the
    // null-cursor inference silently wrong exactly on multi-byte documents —
    // so it is excluded even here, where it would have "worked" because the
    // body happens to be ASCII.
    expect(COLLECTION_TOTAL_KEYS.has("bytes_total")).toBe(false);
    const out = bounded(
      JSON.stringify({
        path: "/a.md",
        content: "A".repeat(9000),
        offset: 0,
        next_offset: null,
        bytes_total: 9000,
      }),
    );
    expect(out).not.toHaveProperty("next_offset");
  });

  it("keeps CURSOR_BASE_KEYS a strict subset of the accounting group", () => {
    // A base key IS paging accounting; if one were not, B4 would leave it
    // behind after deleting the cursor it belongs to.
    for (const k of CURSOR_BASE_KEYS) expect(PAGING_ACCOUNTING_KEYS.has(k)).toBe(true);
    expect(CURSOR_BASE_KEYS.size).toBeLessThan(PAGING_ACCOUNTING_KEYS.size);
  });
});

describe("the refusal cliff is where MAX_REDUCTION_ITERATIONS puts it", () => {
  const siblings = (n: number): string => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < n; i++) obj["k" + i] = String.fromCharCode(97 + i).repeat(2000);
    return JSON.stringify(obj);
  };

  it("delivers content well past the old eight-reduction cap", () => {
    // The probe budget used to cap the loop at EIGHT applied reductions while
    // MAX_REDUCTION_ITERATIONS advertised sixteen, so twelve comparable
    // siblings refused — zero characters — and eleven succeeded, with nothing
    // in the source naming eight as the real limit.
    for (const n of [9, 12, 16, 19]) {
      expect(marker(siblings(n), "t").refused).toBeUndefined();
    }
  });

  it("refuses beyond it, and says so rather than emitting a fragment", () => {
    const m = marker(siblings(20), "t");
    expect(m.refused).toBe(true);
    expect(m.reason).toBe("irreducible");
  });

  it("handles sixteen sibling arrays of fifty rows", () => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < 16; i++) {
      obj["arr" + i] = Array.from({ length: 50 }, (_, j) => `row ${i}-${j} padding text`);
    }
    const wire = JSON.stringify(obj);
    expect(wire.length).toBeGreaterThan(19000);
    expect(marker(wire, "t").refused).toBeUndefined();
  });
});

describe("the marker's own size bounds are real", () => {
  it("caps `reduced` at six entries however many reductions were applied", () => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < 14; i++) obj["k" + i] = String.fromCharCode(97 + i).repeat(1200);
    const m = marker(JSON.stringify(obj), "t");
    expect((m.reduced as unknown[]).length).toBeLessThanOrEqual(6);
  });

  it("caps `removed_keys` at twelve", () => {
    const wire = JSON.stringify({
      text: "T".repeat(12000),
      next_offset: 5,
      offset: 1,
      start_chunk: 2,
      chunks_returned: 3,
      total_chunks: 4,
      chars_total: 6,
      bytes_total: 7,
      count: 8,
      total: 9,
      total_count: 10,
      returned: 11,
      limit: 12,
      page: 13,
      per_page: 14,
      page_size: 15,
      truncated: false,
      complete: true,
    });
    expect((marker(wire, "t").removed_keys as string[]).length).toBeLessThanOrEqual(12);
  });

  it("clips a removed key name at forty-eight characters", () => {
    // B3 removes ANY sibling scalar that matched the pre-reduction length, so
    // the removed NAME is producer-controlled and otherwise unbounded.
    const longKey = "count_of_things_" + "z".repeat(120);
    const wire = JSON.stringify({
      items: Array.from({ length: 400 }, (_, i) => `item ${i} padding padding`),
      [longKey]: 400,
    });
    const removed = marker(wire, "t").removed_keys as string[];
    expect(removed.length).toBeGreaterThan(0);
    for (const k of removed) expect(k.length).toBeLessThanOrEqual(48);
  });

  it("clips a reduction path at sixty characters", () => {
    const wire = JSON.stringify({
      an_outer_section_name_here: {
        a_middle_section_name_here: {
          an_inner_section_name_here: { the_actual_body_field_here: "B".repeat(12000) },
        },
      },
    });
    const reduced = marker(wire, "t").reduced as { at: string }[];
    expect(reduced.length).toBeGreaterThan(0);
    for (const r of reduced) expect(r.at.length).toBeLessThanOrEqual(60);
  });
});

describe("the walk reaches real nesting depth", () => {
  it("finds and reduces a body six levels down", () => {
    const wire = JSON.stringify({ a: { b: { c: { d: { e: { f: "F".repeat(12000) } } } } } });
    const out = bounded(wire, "t") as unknown as {
      a: { b: { c: { d: { e: { f: string } } } } };
    };
    expect(out.a.b.c.d.e.f.length).toBeGreaterThan(1000);
    expect(out.a.b.c.d.e.f.length).toBeLessThan(12000);
  });

  it("pins MIN_REDUCIBLE_STRING as a decision, not an accident", () => {
    // Not mutation-killable: a shorter site is rejected by the strict-progress
    // rule anyway, so this is a WORK bound. Pinned the way the 8000 cap is —
    // because the number is a decision someone has to re-argue to change.
    expect(MIN_REDUCIBLE_STRING).toBe(40);
    const reduced = marker(JSON.stringify({ t: "T".repeat(20000) }), "t").reduced as {
      from: number;
    }[];
    for (const r of reduced) expect(r.from).toBeGreaterThanOrEqual(MIN_REDUCIBLE_STRING);
  });
});

describe("the nested sweep deletes no truths, and leaves no hollow sections", () => {
  it("keeps still-true accounting in a sub-object nothing reduced", () => {
    const out = bounded(
      JSON.stringify({
        body: "B".repeat(12000),
        pagination: { nextCursor: "abc", total: 40, limit: 10, page: 1 },
      }),
      "t",
    );
    const pagination = out.pagination as Record<string, unknown>;
    // The cursor goes — deletion is depth-agnostic and it may now point past
    // what survived. `total`/`limit`/`page` describe a collection nothing
    // touched, so removing them would be inventing a loss.
    expect(pagination).not.toHaveProperty("nextCursor");
    expect(pagination.total).toBe(40);
    expect(pagination.limit).toBe(10);
    expect(pagination.page).toBe(1);
  });

  it("drops a sub-object the sweep emptied rather than leaving `{}`", () => {
    // `page_info: {}` reads as "this section exists and holds nothing", which
    // is a claim. The truth is that the section was removed.
    const wire = JSON.stringify({ body: "B".repeat(12000), page_info: { nextCursor: "abc" } });
    expect(Object.prototype.hasOwnProperty.call(bounded(wire, "t"), "page_info")).toBe(false);
    expect(marker(wire, "t").removed_keys).toContain("page_info");
  });
});

describe("the remaining recompute conditions each carry weight", () => {
  it("deletes a null cursor when TWO published bases both corroborate", () => {
    // `offset + 9000 === chars_total` and `start_chunk + 9000 === total`, so
    // two different published bases each "explain" the exhausted cursor and
    // they disagree about where to resume. Unique or nothing — picking either
    // one is a coin flip the model would read as fact.
    const out = bounded(
      JSON.stringify({
        path: "/a.md",
        content: "A".repeat(9000),
        offset: 0,
        start_chunk: 5,
        next_offset: null,
        chars_total: 9000,
        total: 9005,
      }),
    );
    expect(out).not.toHaveProperty("next_offset");
  });

  it("recomputes an ARRAY-paged cursor, in the collection's own units", () => {
    // `cursor = base + deliveredRows` is the producer's own semantics for a
    // row-paged collection, and `from`/`to` are already in rows — so this
    // closes for exactly the same reason the character case does.
    const rows = Array.from({ length: 300 }, (_, i) => `row ${i} with some padding text here`);
    const out = bounded(
      JSON.stringify({ rows, offset: 0, next_offset: 300, total: 5000 }),
      "search_content",
    );
    const delivered = (out.rows as unknown[]).length;
    expect(delivered).toBeGreaterThan(0);
    expect(delivered).toBeLessThan(300);
    expect(out.next_offset).toBe(delivered);
  });

  it("still refuses the chunk cursor over a character body", () => {
    // The case a blanket "strings only" rule was standing in for: chunk
    // indices are not dense, so no arithmetic over a shortened `text` yields a
    // correct `next_chunk`. The base check rejects it on its own.
    const out = bounded(
      JSON.stringify({
        type: "read_document_text",
        path: "/d.pdf",
        text: "T".repeat(12000),
        start_chunk: 0,
        next_chunk: 7,
        total_chunks: 40,
      }),
      "read_document_text",
    );
    expect(out).not.toHaveProperty("next_chunk");
  });
});

describe("`at or under this level` is a path relation, not a string prefix", () => {
  it("does not treat `groupsExtra` as living under `groups`", () => {
    // `pathKey` renders these as ".groups" and ".groupsExtra.body", and
    // `".groupsExtra.body".startsWith(".groups")` is TRUE — so a string-prefix
    // test would decide that reducing inside `groupsExtra` licensed stripping
    // still-true accounting out of the untouched `groups`.
    const out = bounded(
      JSON.stringify({
        groups: { nextCursor: "abc", total: 40, limit: 10, page: 1 },
        groupsExtra: { body: "B".repeat(12000) },
      }),
      "t",
    );
    const groups = out.groups as Record<string, unknown>;
    expect(groups).not.toHaveProperty("nextCursor");
    expect(groups.total).toBe(40);
    expect(groups.limit).toBe(10);
    expect(groups.page).toBe(1);
  });
});
