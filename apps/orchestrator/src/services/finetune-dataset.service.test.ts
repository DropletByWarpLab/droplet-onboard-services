/**
 * ADR-039 §7 — dataset export.
 *
 * The redaction block is the point of this file. A curation rule that
 * misfires costs training quality; a redaction rule that misfires puts a
 * household Wi-Fi passphrase into weights we ship to every other customer,
 * and there is no recall for that. Those tests plant known secrets and assert
 * the raw value is absent from the ENCODED record, which is what actually
 * leaves the box — not from some intermediate object.
 */
import { describe, it, expect } from "vitest";
import {
  buildToolManifest,
  registryFingerprint,
  groupTurns,
  curateTurn,
  curateMessages,
  renderJsonl,
  type SourceMessage,
  type ToolManifestEntry,
  type CurationOptions,
} from "./finetune-dataset.service.js";

// --- fixtures ---------------------------------------------------------------

function msg(over: Partial<SourceMessage> & { role: string }): SourceMessage {
  return {
    content: "",
    toolCalls: null,
    turnId: "turn-1",
    status: "completed",
    feedback: null,
    model: "gpt-oss:20b",
    provider: "ollama",
    ...over,
  };
}

const OPTS: CurationOptions = {
  knownTools: new Set(["list_cameras", "set_wifi_password"]),
  includeNoToolTurns: false,
  registryFingerprint: "fp-test",
};

/** A minimal completed turn that calls one known tool successfully. */
function goodTurn(): SourceMessage[] {
  return [
    msg({ role: "user", content: "which cameras do I have?" }),
    msg({
      role: "assistant",
      content: "You have one camera.",
      toolCalls: [
        { id: "c1", name: "list_cameras", args: {}, ok: true, data: { n: 1 } },
      ],
    }),
  ];
}

// --- tool manifest ----------------------------------------------------------

describe("buildToolManifest", () => {
  it("emits every catalog tool with its live schema and safety flags", () => {
    const m = buildToolManifest();
    expect(m.toolCount).toBeGreaterThan(50);
    expect(m.tools).toHaveLength(m.toolCount);
    for (const t of m.tools) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.inputSchema).toBeTypeOf("object");
      expect(t.requiresWrite).toBeTypeOf("boolean");
      expect(t.requiresConfirmation).toBeTypeOf("boolean");
      expect(t.domain).toBeTruthy();
    }
  });

  it("is sorted by name, so the file diffs cleanly between exports", () => {
    const names = buildToolManifest().tools.map((t) => t.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("is deterministic across calls", () => {
    expect(buildToolManifest().fingerprint).toBe(
      buildToolManifest().fingerprint,
    );
  });
});

describe("registryFingerprint", () => {
  const base: ToolManifestEntry[] = [
    {
      name: "a",
      description: "d",
      inputSchema: { type: "object" },
      requiresWrite: false,
      requiresConfirmation: false,
      domain: "system",
    },
    {
      name: "b",
      description: "d",
      inputSchema: { type: "object" },
      requiresWrite: true,
      requiresConfirmation: false,
      domain: "system",
    },
  ];

  it("ignores input order", () => {
    expect(registryFingerprint(base)).toBe(
      registryFingerprint([...base].reverse()),
    );
  });

  it("ignores description — prose is not part of the tool surface", () => {
    const reworded = base.map((e) => ({ ...e, description: "reworded" }));
    expect(registryFingerprint(reworded)).toBe(registryFingerprint(base));
  });

  it("changes when a schema changes", () => {
    const changed = [
      { ...base[0], inputSchema: { type: "object", required: ["x"] } },
      base[1],
    ];
    expect(registryFingerprint(changed)).not.toBe(registryFingerprint(base));
  });

  // The reason the flags are hashed: a tool that quietly stops requiring
  // confirmation is a different training target with an identical schema.
  it("changes when requiresConfirmation flips", () => {
    const changed = [{ ...base[0], requiresConfirmation: true }, base[1]];
    expect(registryFingerprint(changed)).not.toBe(registryFingerprint(base));
  });

  it("changes when a tool is removed", () => {
    expect(registryFingerprint([base[0]])).not.toBe(registryFingerprint(base));
  });
});

// --- turn grouping ----------------------------------------------------------

describe("groupTurns", () => {
  it("starts a new turn at each user message", () => {
    const turns = groupTurns([
      msg({ role: "user", content: "one" }),
      msg({ role: "assistant", content: "a" }),
      msg({ role: "user", content: "two" }),
      msg({ role: "assistant", content: "b" }),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("drops rows before the first user message", () => {
    const turns = groupTurns([
      msg({ role: "assistant", content: "orphan" }),
      msg({ role: "user", content: "one" }),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].messages).toHaveLength(1);
  });

  // Grouping must not key on turnId: it is nullable, and every row written
  // before the column existed carries null.
  it("still separates turns when turnId is null throughout", () => {
    const turns = groupTurns([
      msg({ role: "user", content: "one", turnId: null }),
      msg({ role: "assistant", content: "a", turnId: null }),
      msg({ role: "user", content: "two", turnId: null }),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].turnId).toBeNull();
  });

  it("returns nothing for an empty session", () => {
    expect(groupTurns([])).toEqual([]);
  });
});

// --- curation rules ---------------------------------------------------------

describe("curateTurn", () => {
  it("keeps a clean tool-calling turn", () => {
    const out = curateTurn(groupTurns(goodTurn())[0], OPTS);
    expect(out.kept).toBe(true);
    if (!out.kept) return;
    expect(out.record.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(out.record.messages[1].tool_calls?.[0].function.name).toBe(
      "list_cameras",
    );
    expect(out.record.messages[2].tool_call_id).toBe("c1");
    expect(out.record.provenance.registryFingerprint).toBe("fp-test");
    expect(out.record.provenance.turnId).toBe("turn-1");
  });

  it("drops a turn that never reached a terminal state", () => {
    const rows = goodTurn();
    rows[1] = { ...rows[1], status: "aborted" };
    const out = curateTurn(groupTurns(rows)[0], OPTS);
    expect(out).toEqual({ kept: false, reason: "not_completed" });
  });

  it("drops a thumbs-down turn", () => {
    const rows = goodTurn();
    rows[1] = { ...rows[1], feedback: "down" };
    expect(curateTurn(groupTurns(rows)[0], OPTS)).toEqual({
      kept: false,
      reason: "negative_feedback",
    });
  });

  it("keeps a thumbs-up turn", () => {
    const rows = goodTurn();
    rows[1] = { ...rows[1], feedback: "up" };
    expect(curateTurn(groupTurns(rows)[0], OPTS).kept).toBe(true);
  });

  it("drops a turn whose tool errored", () => {
    const rows = goodTurn();
    rows[1] = {
      ...rows[1],
      toolCalls: [
        {
          id: "c1",
          name: "list_cameras",
          args: {},
          ok: false,
          status: "error",
          message: "boom",
        },
      ],
    };
    expect(curateTurn(groupTurns(rows)[0], OPTS)).toEqual({
      kept: false,
      reason: "tool_error",
    });
  });

  // ADR-039 §4 — the staleness rule, enforced per record and not only in the
  // manifest. Training on a retired tool teaches a call that lands in the
  // hallucinated-tool guard.
  it("drops a turn naming a tool the registry no longer has", () => {
    const rows = goodTurn();
    rows[1] = {
      ...rows[1],
      toolCalls: [{ id: "c1", name: "retired_tool", args: {}, ok: true }],
    };
    expect(curateTurn(groupTurns(rows)[0], OPTS)).toEqual({
      kept: false,
      reason: "unknown_tool",
    });
  });

  it("drops a zero-tool turn by default", () => {
    const rows = [
      msg({ role: "user", content: "hello" }),
      msg({ role: "assistant", content: "hi" }),
    ];
    expect(curateTurn(groupTurns(rows)[0], OPTS)).toEqual({
      kept: false,
      reason: "no_tool_calls",
    });
  });

  it("keeps a zero-tool turn as a negative when asked", () => {
    const rows = [
      msg({ role: "user", content: "hello" }),
      msg({ role: "assistant", content: "hi" }),
    ];
    const out = curateTurn(groupTurns(rows)[0], {
      ...OPTS,
      includeNoToolTurns: true,
    });
    expect(out.kept).toBe(true);
    if (!out.kept) return;
    expect(out.record.messages[1].tool_calls).toBeUndefined();
  });

  it("drops a user message with no assistant reply", () => {
    const rows = [msg({ role: "user", content: "hello?" })];
    expect(curateTurn(groupTurns(rows)[0], OPTS)).toEqual({
      kept: false,
      reason: "incomplete_exchange",
    });
  });

  // Reason attribution: a failed turn reads as not_completed even though it
  // also carries a tool error, so the CLI histogram names the root cause.
  it("attributes a failed turn with a tool error to not_completed", () => {
    const rows = goodTurn();
    rows[1] = {
      ...rows[1],
      status: "failed",
      toolCalls: [
        { id: "c1", name: "list_cameras", args: {}, ok: false, message: "x" },
      ],
    };
    expect(curateTurn(groupTurns(rows)[0], OPTS)).toEqual({
      kept: false,
      reason: "not_completed",
    });
  });

  it("carries multi-hop trajectories through in order", () => {
    const rows = [
      msg({ role: "user", content: "rotate the wifi password" }),
      msg({
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "list_cameras", args: {}, ok: true, data: {} },
        ],
      }),
      msg({
        role: "assistant",
        content: "Done.",
        toolCalls: [
          {
            id: "c2",
            name: "set_wifi_password",
            args: { ssid: "Home" },
            ok: true,
            data: {},
          },
        ],
      }),
    ];
    const out = curateTurn(groupTurns(rows)[0], OPTS);
    expect(out.kept).toBe(true);
    if (!out.kept) return;
    expect(out.record.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
  });
});

// --- redaction (the block that matters) -------------------------------------

describe("redaction of exported records", () => {
  /** What actually leaves the box is the encoded line, so assert on that. */
  function encode(rows: SourceMessage[]): string {
    const out = curateTurn(groupTurns(rows)[0], OPTS);
    expect(out.kept).toBe(true);
    if (!out.kept) throw new Error("expected a kept record");
    return JSON.stringify(out.record);
  }

  // THE REGRESSION THIS FILE EXISTS FOR. A text scrub over
  // JSON.stringify(args) leaves {"password":"..."} untouched, and
  // set_wifi_password is a real registered tool — so an exporter built the
  // obvious way ships household passphrases while looking fully redacted.
  it("strips a secret-keyed tool ARGUMENT, which the text scrub cannot see", () => {
    const rows = goodTurn();
    rows[1] = {
      ...rows[1],
      toolCalls: [
        {
          id: "c1",
          name: "set_wifi_password",
          args: { ssid: "Home", password: "hunter2-correct-horse" },
          ok: true,
          data: {},
        },
      ],
    };
    const encoded = encode(rows);
    expect(encoded).not.toContain("hunter2-correct-horse");
    expect(encoded).toContain("[REDACTED]");
    // Non-secret siblings survive — a corpus of all-placeholder args is
    // useless as training data.
    expect(encoded).toContain("Home");
  });

  it("strips a secret nested inside tool result data", () => {
    const rows = goodTurn();
    rows[1] = {
      ...rows[1],
      toolCalls: [
        {
          id: "c1",
          name: "list_cameras",
          args: {},
          ok: true,
          data: { cameras: [{ name: "Front", rtsp_password: "s3cr3t-cam" }] },
        },
      ],
    };
    const encoded = encode(rows);
    expect(encoded).not.toContain("s3cr3t-cam");
    expect(encoded).toContain("Front");
  });

  it("strips a bearer token pasted into message content", () => {
    const rows = goodTurn();
    rows[0] = {
      ...rows[0],
      content: "use Authorization: Bearer abcdef1234567890 for this",
    };
    expect(encode(rows)).not.toContain("abcdef1234567890");
  });

  it("strips a secret from an assistant answer", () => {
    const rows = goodTurn();
    rows[1] = { ...rows[1], content: "I set WIFI_PASSWORD=swordfish99 for you" };
    expect(encode(rows)).not.toContain("swordfish99");
  });

  // WARP-640's confirmationToken is a live single-use credential that stays
  // valid for its TTL. It teaches the model nothing, so it is read by nothing
  // in the exporter — pinned here so a later "the chip renders it" edit fails.
  it("never exports the WARP-640 confirmation token", () => {
    const rows = goodTurn();
    rows[1] = {
      ...rows[1],
      toolCalls: [
        {
          id: "c1",
          name: "list_cameras",
          args: {},
          ok: true,
          data: {},
          confirmation: {
            kind: "scene",
            sceneId: "s1",
            confirmationToken: "live-token-must-not-leak",
          },
        },
      ],
    };
    expect(encode(rows)).not.toContain("live-token-must-not-leak");
  });

  it("strips credentials from a tool error message", () => {
    const rows = goodTurn();
    rows[1] = {
      ...rows[1],
      toolCalls: [
        { id: "c1", name: "list_cameras", args: {}, ok: true, data: {} },
      ],
      content: "failed to reach postgresql://droplet:tops3cret@db/droplet",
    };
    expect(encode(rows)).not.toContain("tops3cret");
  });
});

// --- aggregation ------------------------------------------------------------

describe("curateMessages", () => {
  it("counts kept records and attributes every drop", () => {
    const rows = [
      ...goodTurn(),
      msg({ role: "user", content: "hi" }),
      msg({ role: "assistant", content: "hello" }), // no_tool_calls
      msg({ role: "user", content: "bad" }),
      msg({ role: "assistant", content: "x", status: "failed" }), // not_completed
    ];
    const run = curateMessages(rows, OPTS);
    expect(run.summary.kept).toBe(1);
    expect(run.summary.dropped.no_tool_calls).toBe(1);
    expect(run.summary.dropped.not_completed).toBe(1);
    expect(run.summary.dropped.tool_error).toBe(0);
    expect(run.records).toHaveLength(1);
  });

  it("handles an empty session", () => {
    const run = curateMessages([], OPTS);
    expect(run.summary.kept).toBe(0);
    expect(run.records).toEqual([]);
  });
});

describe("renderJsonl", () => {
  it("writes one parseable object per line with a trailing newline", () => {
    const run = curateMessages(goodTurn(), OPTS);
    const text = renderJsonl(run.records);
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0])).not.toThrow();
  });

  it("emits nothing at all for an empty corpus", () => {
    expect(renderJsonl([])).toBe("");
  });
});
