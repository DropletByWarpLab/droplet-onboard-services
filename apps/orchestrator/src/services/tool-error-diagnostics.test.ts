/**
 * WARP-1480 — unit spec for the tool-error diagnostics envelope.
 *
 * The module under test is deliberately pure (no logger, no config, no IO), so
 * every property below is asserted directly instead of through a log sink. The
 * agent-loop integration — that the line actually FIRES, with the flag off — is
 * covered separately in `__tests__/llm-agent.tool-error-instrumentation.test.ts`.
 *
 * Every payload here is built with `parseToolResultPayload` from real wire
 * text. That is the WARP-1604 brand doing its job: a test cannot hand-roll a
 * shape mcp-server never emits.
 */
import { describe, it, expect, vi } from "vitest";
import { parseToolResultPayload } from "./tool-result-payload.js";
import { describeToolError, newAgentTurnId } from "./tool-error-diagnostics.js";

const BASE = {
  tool: "read_file",
  toolCallId: "call_abc123",
  turnId: "turn_deadbeef",
  iter: 3,
  args: {} as Record<string, unknown>,
  includeExcerpt: false,
};

function describeWire(
  text: string,
  over: Partial<typeof BASE> & { includeExcerpt?: boolean } = {},
) {
  return describeToolError({
    ...BASE,
    ...over,
    payload: parseToolResultPayload(text),
  });
}

describe("describeToolError — the four wire shapes", () => {
  it("classifies the handler-error envelope and keeps the handler's own code", () => {
    const d = describeWire(
      '{"status":"error","error":{"code":"NC_REQUEST_FAILED","message":"read failed"}}',
    );

    expect(d.error_shape).toBe("envelope");
    expect(d.error_code).toBe("NC_REQUEST_FAILED");
    expect(d.message_len).toBe("read failed".length);
  });

  it("classifies forbidden_tool_for_role as an envelope", () => {
    const d = describeWire(
      '{"status":"error","error":{"code":"forbidden_tool_for_role","message":"role \'guest\' may not call \'write_file\'"}}',
    );

    expect(d.error_shape).toBe("envelope");
    expect(d.error_code).toBe("forbidden_tool_for_role");
  });

  it("synthesizes UNKNOWN_TOOL for the bare-string unknown-tool reply", () => {
    // server.ts emits `{ error: "Unknown tool: <model-supplied name>" }` — a
    // bare string with no code, whose text embeds model-authored input.
    const d = describeWire(
      '{"error":"Unknown tool: read_file_/Patients/Jane Doe/chart.pdf"}',
    );

    expect(d.error_shape).toBe("string_error");
    expect(d.error_code).toBe("UNKNOWN_TOOL");
    // The raw string must NEVER become the code — it would explode cardinality
    // and carry a model-supplied path into the diagnostics bundle.
    expect(d.error_code).not.toContain("Jane Doe");
    expect(JSON.stringify(d)).not.toContain("Jane Doe");
  });

  it("synthesizes TOOL_DISPATCH_FAILED for the ORCH-05 throw path", () => {
    const d = describeWire(
      '{"error":"tool_dispatch_failed","tool":"read_file","message":"fetch failed"}',
    );

    expect(d.error_shape).toBe("string_error");
    expect(d.error_code).toBe("TOOL_DISPATCH_FAILED");
    expect(d.message_len).toBe("fetch failed".length);
  });

  it("falls back to UNSTRUCTURED_ERROR for any other bare-string error", () => {
    const d = describeWire('{"error":"something went sideways"}');

    expect(d.error_shape).toBe("string_error");
    expect(d.error_code).toBe("UNSTRUCTURED_ERROR");
  });

  it("classifies non-JSON stdio output as raw / NON_JSON_RESULT", () => {
    const d = describeWire("MCP child died: Segmentation fault");

    expect(d.error_shape).toBe("raw");
    expect(d.error_code).toBe("NON_JSON_RESULT");
    expect(d.message_len).toBeGreaterThan(0);
  });

  it("classifies anything else as UNCLASSIFIED", () => {
    expect(describeWire("[1,2,3]").error_shape).toBe("unknown");
    expect(describeWire("[1,2,3]").error_code).toBe("UNCLASSIFIED");
    expect(describeWire("null").error_code).toBe("UNCLASSIFIED");
    expect(describeWire('{"results":[]}').error_code).toBe("UNCLASSIFIED");
  });
});

describe("describeToolError — message_excerpt is envelope-only and scrubbed", () => {
  const ENVELOPE_WITH_SECRET =
    '{"status":"error","error":{"code":"NC_REQUEST_FAILED","message":"upstream said Authorization: Bearer sk-live-abc123def456"}}';

  it("emits a scrubbed excerpt for the envelope shape when the flag is on", () => {
    const d = describeWire(ENVELOPE_WITH_SECRET, { includeExcerpt: true });

    expect(d.message_excerpt).toBeDefined();
    expect(d.message_excerpt).toContain("[REDACTED]");
    expect(d.message_excerpt).not.toContain("sk-live-abc123def456");
  });

  it("omits the excerpt for the envelope shape when the flag is off", () => {
    const d = describeWire(ENVELOPE_WITH_SECRET, { includeExcerpt: false });

    expect(d.message_excerpt).toBeUndefined();
    expect(d.message_len).toBeGreaterThan(0);
  });

  it("NEVER emits an excerpt for string_error, even with the flag on", () => {
    // This text is not authored in this repo — it is whatever an upstream
    // returned, and can carry a live credential.
    const d = describeWire(
      '{"error":"tool_dispatch_failed","tool":"read_file","message":"POST https://nc/index.php/apps/richdocuments/direct/LIVETOKEN failed"}',
      { includeExcerpt: true },
    );

    expect(d.error_shape).toBe("string_error");
    expect(d.message_excerpt).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain("LIVETOKEN");
    expect(d.message_len).toBeGreaterThan(0);
  });

  it("NEVER emits an excerpt for raw, even with the flag on", () => {
    const d = describeWire("upstream body: X-Api-Key: hunter2hunter2", {
      includeExcerpt: true,
    });

    expect(d.error_shape).toBe("raw");
    expect(d.message_excerpt).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain("hunter2hunter2");
  });

  it("drops an excerpt that still looks like key material after redaction", () => {
    // A PEM whose END delimiter falls outside the pre-redaction bound
    // (MAX_REDACT_INPUT = 64k) cannot be matched by the block rule — the
    // excerpt must be dropped rather than shipped half-scrubbed.
    //
    // The body is laid out as real PEM is — 64-column base64 lines — not as
    // one 200k-character run. `redactSecrets`' sensitive-key rule starts with
    // `[A-Za-z0-9_.-]*`, which is quadratic over a single unbroken
    // alphanumeric run: the 64k window costs ~17 s on Node 26 (measured
    // outside vitest too), blowing the 10 s budget, versus ~4 ms line-wrapped.
    // Only the "no END within the bound" property is under test here.
    const body = Array.from({ length: 3200 }, () => "A".repeat(64)).join("\n");
    const d = describeWire(
      JSON.stringify({
        status: "error",
        error: {
          code: "NC_REQUEST_FAILED",
          message: `-----BEGIN RSA PRIVATE KEY-----\n${body}`,
        },
      }),
      { includeExcerpt: true },
    );

    expect(d.message_excerpt).toBeUndefined();
  });
});

describe("describeToolError — message_class works with the excerpt flag OFF", () => {
  const cases: [string, string][] = [
    ['{"error":"tool_dispatch_failed","tool":"read_file","message":"fetch failed"}', "fetch_failed"],
    [
      '{"status":"error","error":{"code":"HANDLER_THREW","message":"fetch failed <- caused by: ECONNRESET"}}',
      "econnreset",
    ],
    [
      '{"status":"error","error":{"code":"HANDLER_THREW","message":"Headers Timeout Error [UND_ERR_HEADERS_TIMEOUT]"}}',
      "headers_timeout",
    ],
    [
      '{"status":"error","error":{"code":"HANDLER_THREW","message":"getaddrinfo ENOTFOUND nextcloud"}}',
      "enotfound",
    ],
    [
      '{"status":"error","error":{"code":"NC_BAD_PATH","message":"path traversal not allowed"}}',
      "path_traversal",
    ],
    ['{"error":"Unknown tool: whatever"}', "unknown_tool"],
    // `read_file`'s own READ_FAILED literal — the class WARP-1480 most needs.
    [
      '{"status":"error","error":{"code":"READ_FAILED","message":"nextcloud returned 504"}}',
      "nextcloud_504",
    ],
    [
      '{"status":"error","error":{"code":"READ_FAILED","message":"nextcloud returned 418"}}',
      "nextcloud_http_error",
    ],
  ];

  for (const [wire, expected] of cases) {
    it(`derives message_class="${expected}" with includeExcerpt=false`, () => {
      const d = describeWire(wire, { includeExcerpt: false });
      expect(d.message_excerpt).toBeUndefined();
      expect(d.message_class).toBe(expected);
    });
  }

  it("falls back to a single token rather than omitting the field", () => {
    const d = describeWire(
      '{"status":"error","error":{"code":"NC_X","message":"an entirely novel failure"}}',
    );
    expect(d.message_class).toBe("unclassified");
  });

  it("classifies from the TAIL of a long message so an appended cause survives", () => {
    const long = "x".repeat(50_000) + " ECONNRESET";
    const d = describeWire(
      JSON.stringify({
        status: "error",
        error: { code: "HANDLER_THREW", message: long },
      }),
    );
    expect(d.message_class).toBe("econnreset");
  });
});

describe("describeToolError — arg_keys is shape-guarded", () => {
  it("drops a path-shaped key and counts the drop", () => {
    const d = describeWire('{"error":"x"}', {
      args: {
        path: "/Patients/Jane Doe/chart.pdf",
        "/Patients/Jane Doe/chart.pdf": true,
        "kebab-case": 1,
        offset: 0,
      },
    });

    expect(d.arg_keys).toEqual(["offset", "path"]);
    expect(d.arg_keys_dropped).toBe(2);
    expect(JSON.stringify(d.arg_keys)).not.toContain("Jane Doe");
  });

  it("sorts and caps at 20, counting the overflow as dropped", () => {
    const args: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) args[`k${String(i).padStart(2, "0")}`] = i;

    const d = describeWire('{"error":"x"}', { args });

    expect(d.arg_keys).toHaveLength(20);
    expect(d.arg_keys[0]).toBe("k00");
    expect([...d.arg_keys]).toEqual([...d.arg_keys].sort());
    expect(d.arg_keys_dropped).toBe(5);
  });

  it("reports zero drops for a clean arg set", () => {
    const d = describeWire('{"error":"x"}', { args: { path: "/a.txt" } });
    expect(d.arg_keys).toEqual(["path"]);
    expect(d.arg_keys_dropped).toBe(0);
  });
});

describe("describeToolError — the tool name is shape-guarded too", () => {
  it("passes a registry-shaped name through", () => {
    expect(describeWire('{"error":"x"}', { tool: "read_file" }).tool).toBe(
      "read_file",
    );
  });

  it("replaces a model-authored non-identifier with a fixed token", () => {
    const d = describeWire('{"error":"Unknown tool: x"}', {
      tool: "read /Patients/Jane Doe/chart.pdf",
    });

    expect(d.tool).toBe("<non-identifier>");
    expect(JSON.stringify(d)).not.toContain("Jane Doe");
  });

  it("replaces an over-long name rather than logging it", () => {
    const d = describeWire('{"error":"x"}', { tool: "a".repeat(65) });
    expect(d.tool).toBe("<non-identifier>");
  });
});

describe("describeToolError — the correlation keys are always present", () => {
  it("carries tool_call_id, turn_id and iter", () => {
    const d = describeWire('{"error":"x"}');

    expect(d.tool_call_id).toBe("call_abc123");
    expect(d.turn_id).toBe("turn_deadbeef");
    expect(d.iter).toBe(3);
  });

  it("accepts the id shapes real providers actually mint", () => {
    for (const id of [
      "call_abc123",
      "toolu_01ABCdefGHIjklMNOpqr",
      "chatcmpl-tool-9f8e7d6c",
      "0f9c1e2a-4b6d-4a1f-9c3e-7d2b8a5f1e04",
      "call:12.3",
    ]) {
      expect(describeWire('{"error":"x"}', { toolCallId: id }).tool_call_id).toBe(
        id,
      );
    }
  });

  it("replaces a model-authored non-identifier tool_call_id with a fixed token", () => {
    // `ToolCall.id` is provider JSON cast to an interface. Nothing zod-parses
    // `choices[].message.tool_calls`, and the streaming accumulator copies
    // `frag.id` through unchanged — it is never minted server-side, so it is
    // exactly as model-controlled as `tool` is, and prompt injection steers it
    // the same way. Unguarded it was a 64-char unrestricted-charset channel
    // (spaces, slashes, colons) that is ALWAYS on, that this WARN line is the
    // first thing to route into journald and therefore the diagnostics zip,
    // and that neither redaction layer can catch — both match secret SHAPES,
    // not names or paths.
    const d = describeWire('{"error":"x"}', {
      toolCallId: "/Patients/Jane Doe/chart.pdf ssn=123-45-6789",
    });

    expect(d.tool_call_id).toBe("<non-identifier>");
    expect(JSON.stringify(d)).not.toContain("Jane Doe");
    expect(JSON.stringify(d)).not.toContain("123-45-6789");
  });

  it("replaces an over-long tool_call_id rather than logging it", () => {
    const d = describeWire('{"error":"x"}', { toolCallId: "c".repeat(500) });
    expect(d.tool_call_id).toBe("<non-identifier>");
    expect(d.tool_call_id.length).toBeLessThanOrEqual(64);
  });

  it("survives a NON-STRING tool_call_id from a broken provider", () => {
    // Everywhere else in the loop the id is only ASSIGNED, so this module
    // would be the first to call a method on it — and a TypeError here would
    // kill a still-recoverable turn.
    for (const bad of [null, undefined, 42, { a: 1 }]) {
      const d = describeWire('{"error":"x"}', {
        toolCallId: bad as unknown as string,
      });
      expect(d.tool_call_id).toBe("<non-identifier>");
    }
  });

  it("mints a distinct turn id per call", () => {
    expect(newAgentTurnId()).not.toBe(newAgentTurnId());
    expect(newAgentTurnId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("omits thread_id when the turn is not persisted", () => {
    expect(describeWire('{"error":"x"}').thread_id).toBeUndefined();
  });
});

describe("describeToolError — args_fingerprint is salted per process", () => {
  it("is stable within one module instance", () => {
    const a = describeWire('{"error":"x"}', { args: { path: "/a.txt" } });
    const b = describeWire('{"error":"x"}', { args: { path: "/a.txt" } });
    expect(a.args_fingerprint).toBe(b.args_fingerprint);
  });

  it("is insensitive to key insertion order (canonical JSON)", () => {
    const a = describeWire('{"error":"x"}', { args: { a: 1, b: 2 } });
    const b = describeWire('{"error":"x"}', { args: { b: 2, a: 1 } });
    expect(a.args_fingerprint).toBe(b.args_fingerprint);
  });

  it("differs across module instances for the SAME input — the salt is per-process", async () => {
    const first = describeWire('{"error":"x"}', { args: { path: "/a.txt" } });

    // A fresh module registry re-runs the module-scope randomBytes(16), which
    // is exactly what a second orchestrator process does. An UNSALTED sha256
    // would make these two equal — and equal digests are a checkable
    // commitment to a guessed path that survives crypto-shred.
    vi.resetModules();
    const fresh = await import("./tool-error-diagnostics.js");
    const freshParse = await import("./tool-result-payload.js");
    const second = fresh.describeToolError({
      ...BASE,
      args: { path: "/a.txt" },
      payload: freshParse.parseToolResultPayload('{"error":"x"}'),
    });
    vi.resetModules();

    expect(second.args_fingerprint).not.toBe(first.args_fingerprint);
    expect(second.args_identity).not.toBe(first.args_identity);
  });

  it("never contains the argument value itself", () => {
    const d = describeWire('{"error":"x"}', {
      args: { path: "/Patients/Jane Doe/chart.pdf" },
    });
    expect(d.args_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(d)).not.toContain("Jane Doe");
  });
});

describe("describeToolError — args_identity clusters varied spellings", () => {
  it("collides for two spellings of one path", () => {
    const spellings = [
      "/Notes/Q3 Report.md",
      "Notes/Q3 Report.md",
      "/Notes//Q3 Report.md",
      "/Notes/Q3 Report.md/",
      "/Notes/./Q3 Report.md",
      "  /Notes/Q3 Report.md  ",
      "/Notes/Q3%20Report.md",
    ];
    const identities = new Set(
      spellings.map(
        (path) => describeWire('{"error":"x"}', { args: { path } }).args_identity,
      ),
    );

    expect(identities.size).toBe(1);
  });

  it("still separates two genuinely different paths", () => {
    const a = describeWire('{"error":"x"}', { args: { path: "/Notes/a.md" } });
    const b = describeWire('{"error":"x"}', { args: { path: "/Notes/b.md" } });
    expect(a.args_identity).not.toBe(b.args_identity);
  });

  it("keeps args_fingerprint sensitive to the exact spelling it clusters over", () => {
    // The whole point of carrying BOTH: identity answers "same target?",
    // fingerprint answers "byte-identical retry?". sha256 is full-avalanche,
    // so the fingerprint alone can never answer the first question.
    const a = describeWire('{"error":"x"}', { args: { path: "/Notes/a.md" } });
    const b = describeWire('{"error":"x"}', { args: { path: "Notes//a.md" } });

    expect(a.args_fingerprint).not.toBe(b.args_fingerprint);
    expect(a.args_identity).toBe(b.args_identity);
  });

  it("normalizes strings nested in arrays and objects", () => {
    const a = describeWire('{"error":"x"}', {
      args: { paths: ["/Notes/a.md"], filter: { under: "/Notes" } },
    });
    const b = describeWire('{"error":"x"}', {
      args: { paths: ["Notes/a.md"], filter: { under: "Notes/" } },
    });
    expect(a.args_identity).toBe(b.args_identity);
  });

  it("survives a pathologically nested / cyclic args object", () => {
    const cyclic: Record<string, unknown> = { path: "/a.txt" };
    cyclic.self = cyclic;

    const d = describeWire('{"error":"x"}', { args: cyclic });

    expect(d.args_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(d.args_identity).toMatch(/^[0-9a-f]{16}$/);
  });
});
