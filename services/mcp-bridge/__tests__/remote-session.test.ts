/**
 * WARP-2398 — session lifecycle, the four failure states, bounded
 * event-driven reconnect, and rule 19.
 *
 * NOTHING HERE OPENS A SOCKET. Every connection is a double injected through
 * `RemoteMcpSessionOptions.connect`, and every retry runs through an injected
 * `scheduleRetry`, so the suite is deterministic and dials nothing.
 *
 * The credential material below is obviously fake
 * (`ATATT-FAKE-000000000000`) — GitHub push protection cannot be
 * allowlisted, and a rejected push costs an hour.
 */
import { describe, it, expect, vi } from "vitest";
import {
  RemoteMcpSession,
  RemoteMcpSessionNotReadyError,
  type RemoteMcpConnection,
  type RemoteMcpSessionOptions,
  type RemoteToolDescriptor,
} from "../src/remote-session.js";
import { basicCredential } from "../src/credentials.js";
import { classifyRemoteMcpError, FAILURE_STATES } from "../src/session-state.js";

const FAKE_EMAIL = "ops@vendor.example";
const FAKE_TOKEN = "ATATT-FAKE-000000000000";

function tool(name: string): RemoteToolDescriptor {
  return { name, description: `${name} description`, inputSchema: { type: "object" } };
}

/** A connection double whose behaviour the test drives directly. */
function connectionDouble(tools: RemoteToolDescriptor[] = [tool("jira_get_issue")]) {
  let onClosed: (err?: unknown) => void = () => {};
  const listTools = vi.fn(async () => tools);
  const callTool = vi.fn(async () => ({
    content: [{ type: "text", text: "{}" }],
    isError: false,
  }));
  const close = vi.fn(async () => {});
  const connection: RemoteMcpConnection = {
    listTools,
    callTool,
    close,
    onClosed: (h) => {
      onClosed = h;
    },
  };
  return {
    connection,
    listTools,
    callTool,
    close,
    drop: (err?: unknown) => onClosed(err),
    setTools: (next: RemoteToolDescriptor[]) => {
      tools = next;
    },
  };
}

function httpError(status: number): Error & { code: number } {
  return Object.assign(new Error(`HTTP ${status}`), { code: status });
}

function nodeError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function makeSession(
  opts: Partial<RemoteMcpSessionOptions> & {
    connect: ConstructorParameters<typeof RemoteMcpSession>[0]["connect"];
  },
) {
  return new RemoteMcpSession({
    serverId: "vendor",
    url: "https://mcp.vendor.example/v1/mcp",
    credential: basicCredential(FAKE_EMAIL, FAKE_TOKEN),
    now: () => 1_700_000_000_000,
    ...opts,
  });
}

describe("RemoteMcpSession lifecycle", () => {
  it("starts idle, never 'ready by default'", () => {
    const s = makeSession({ connect: async () => connectionDouble().connection });
    expect(s.state).toBe("idle");
    expect(s.isStarted).toBe(false);
    expect(s.health().lastReadyAt).toBeNull();
  });

  it("connects to ready and reports a health payload", async () => {
    const d = connectionDouble();
    const s = makeSession({ connect: async () => d.connection });
    const health = await s.connect();
    expect(health.state).toBe("ready");
    expect(s.isStarted).toBe(true);
    expect(health.consecutiveFailures).toBe(0);
    expect(health.lastReadyAt).toBe(1_700_000_000_000);
  });

  it("close() is terminal — connect() does not silently re-open it", async () => {
    const d = connectionDouble();
    const s = makeSession({ connect: async () => d.connection });
    await s.connect();
    await s.close();
    expect(s.state).toBe("closed");
    expect(d.close).toHaveBeenCalledOnce();
    await s.connect();
    expect(s.state).toBe("closed");
  });

  it("refuses dispatch in every non-dispatchable state, naming the state", async () => {
    const s = makeSession({ connect: async () => connectionDouble().connection });
    await expect(s.callTool("jira_get_issue", {})).rejects.toBeInstanceOf(
      RemoteMcpSessionNotReadyError,
    );
    await expect(s.listTools()).rejects.toThrow(/is idle/);
  });
});

describe("the three ADR-041 failure states are distinct, and none is an empty result", () => {
  it("401/403 → auth_rejected / credential_rejected", async () => {
    const s = makeSession({
      connect: async () => {
        throw httpError(401);
      },
    });
    const health = await s.connect();
    expect(health.state).toBe("auth_rejected");
    expect(health.reason).toBe("credential_rejected");
    expect(health.consecutiveFailures).toBe(1);
  });

  it("ECONNREFUSED / ENOTFOUND → unreachable / endpoint_unreachable", async () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]) {
      const s = makeSession({
        connect: async () => {
          throw nodeError(code);
        },
      });
      const health = await s.connect();
      expect(health.state, code).toBe("unreachable");
      expect(health.reason, code).toBe("endpoint_unreachable");
    }
  });

  it("406/415 → protocol_mismatch, and a version complaint is named as such", async () => {
    const s = makeSession({
      connect: async () => {
        throw httpError(406);
      },
    });
    expect((await s.connect()).state).toBe("protocol_mismatch");

    expect(classifyRemoteMcpError(new Error("Unsupported protocol version: 2099-01-01")))
      .toEqual({ state: "protocol_mismatch", reason: "protocol_version_unsupported" });
  });

  it("the three remedies never collapse into one another", async () => {
    const seen = new Set<string>();
    for (const err of [httpError(403), nodeError("ETIMEDOUT"), httpError(415)]) {
      const s = makeSession({
        connect: async () => {
          throw err;
        },
      });
      seen.add((await s.connect()).state);
    }
    expect([...seen].sort()).toEqual([
      "auth_rejected",
      "protocol_mismatch",
      "unreachable",
    ]);
  });

  it("every failure state is a named enum member, not a derived boolean", () => {
    expect([...FAILURE_STATES].sort()).toEqual([
      "auth_rejected",
      "catalog_changed",
      "protocol_mismatch",
      "unreachable",
    ]);
  });
});

describe("ADR-043 §1's fourth failure state: the catalog changed under us", () => {
  it("a tool that vanished moves the session to catalog_changed and records the drift", async () => {
    const d = connectionDouble([tool("jira_get_issue"), tool("jira_add_comment")]);
    const s = makeSession({ connect: async () => d.connection });
    await s.connect();
    expect(await s.listTools()).toHaveLength(2);
    expect(s.state).toBe("ready");

    d.setTools([tool("jira_get_issue"), tool("jira_new_thing")]);
    const second = await s.listTools();

    // The new catalog is RETURNED — "there is nothing to do" is exactly the
    // rendering the ADR forbids.
    expect(second.map((t) => t.name)).toEqual(["jira_get_issue", "jira_new_thing"]);
    expect(s.state).toBe("catalog_changed");
    expect(s.catalogDrift()).toEqual({
      removed: ["jira_add_comment"],
      added: ["jira_new_thing"],
    });
  });

  it("dispatch is blocked until the new surface is explicitly acknowledged", async () => {
    const d = connectionDouble([tool("a")]);
    const s = makeSession({ connect: async () => d.connection });
    await s.connect();
    await s.listTools();
    d.setTools([tool("b")]);
    await s.listTools();

    await expect(s.callTool("b", {})).rejects.toThrow(/catalog_changed/);
    expect(s.acknowledgeCatalog().state).toBe("ready");
    await expect(s.callTool("b", {})).resolves.toEqual({
      content: [{ type: "text", text: "{}" }],
      isError: false,
    });
  });

  it("the first listing is not drift", async () => {
    const d = connectionDouble([tool("a")]);
    const s = makeSession({ connect: async () => d.connection });
    await s.connect();
    await s.listTools();
    expect(s.state).toBe("ready");
    expect(s.catalogDrift()).toBeNull();
  });
});

describe("reconnect is event-driven and bounded — no scheduling loop", () => {
  it("retries a dropped transport on a growing backoff, then settles", async () => {
    const delays: number[] = [];
    const pending: Array<() => void> = [];
    let attempts = 0;
    const d = connectionDouble();
    const s = makeSession({
      maxReconnectAttempts: 2,
      scheduleRetry: (ms, run) => {
        delays.push(ms);
        pending.push(run);
      },
      connect: async () => {
        attempts += 1;
        if (attempts === 1) return d.connection;
        throw nodeError("ECONNREFUSED");
      },
    });
    await s.connect();
    expect(s.state).toBe("ready");

    d.drop(nodeError("ECONNRESET"));
    expect(s.state).toBe("reconnecting");
    expect(delays).toEqual([1_000]);

    pending.shift()!();
    await vi.waitFor(() => expect(s.state).toBe("unreachable"));

    // A second drop while already failed schedules the second (and last)
    // attempt at double the delay.
    d.drop(nodeError("ECONNRESET"));
    expect(delays).toEqual([1_000, 2_000]);
    pending.shift()!();
    await vi.waitFor(() => expect(s.state).toBe("unreachable"));

    // Budget spent: the next drop settles instead of scheduling a third.
    d.drop(nodeError("ECONNRESET"));
    expect(delays).toHaveLength(2);
    expect(s.state).toBe("unreachable");
    expect(s.health().reason).toBe("retries_exhausted");
  });

  it("does NOT retry a revoked credential — re-dialling cannot fix it", async () => {
    const scheduleRetry = vi.fn();
    const d = connectionDouble();
    const s = makeSession({ scheduleRetry, connect: async () => d.connection });
    await s.connect();

    d.drop(httpError(401));

    expect(scheduleRetry).not.toHaveBeenCalled();
    expect(s.state).toBe("auth_rejected");
    expect(s.health().reason).toBe("credential_rejected");
  });

  it("does NOT retry a protocol mismatch", async () => {
    const scheduleRetry = vi.fn();
    const d = connectionDouble();
    const s = makeSession({ scheduleRetry, connect: async () => d.connection });
    await s.connect();
    d.drop(httpError(415));
    expect(scheduleRetry).not.toHaveBeenCalled();
    expect(s.state).toBe("protocol_mismatch");
  });

  it("a successful reconnect clears the failure counters", async () => {
    const pending: Array<() => void> = [];
    const d = connectionDouble();
    const s = makeSession({
      scheduleRetry: (_ms, run) => pending.push(run),
      connect: async () => d.connection,
    });
    await s.connect();
    d.drop(nodeError("ECONNRESET"));
    pending.shift()!();
    await vi.waitFor(() => expect(s.state).toBe("ready"));
    expect(s.health().consecutiveFailures).toBe(0);
  });

  /**
   * The shape the 20-test suite structurally could not see: every other
   * reconnect test uses a `connect` that FAILS after the first success, so the
   * attempt counter always accumulated. Here every dial succeeds and the
   * server drops us straight afterwards — a budget reset on `connect()` alone
   * is never spent, the backoff never leaves its 1 s floor, and `health()`
   * reports `ready` with zero failures while the box dials a vendor once a
   * second forever.
   *
   * MUTATION: move the reset back to `connect()`'s success branch
   * (`this.#reconnectAttempts = 0`) → this test goes red.
   */
  it("a server that accepts and immediately drops SPENDS the budget", async () => {
    const delays: number[] = [];
    const pending: Array<() => void> = [];
    const d = connectionDouble();
    const s = makeSession({
      maxReconnectAttempts: 2,
      // Frozen clock: no reconnect ever holds `ready` for the stability
      // window, which is exactly the accept-then-drop server's behaviour.
      now: () => 1_700_000_000_000,
      scheduleRetry: (ms, run) => {
        delays.push(ms);
        pending.push(run);
      },
      connect: async () => d.connection,
    });
    await s.connect();
    expect(s.state).toBe("ready");

    for (let i = 0; i < 2; i += 1) {
      d.drop(nodeError("ECONNRESET"));
      expect(s.state).toBe("reconnecting");
      pending.shift()!();
      // The reconnect SUCCEEDS every time — that is the point.
      await vi.waitFor(() => expect(s.state).toBe("ready"));
    }

    d.drop(nodeError("ECONNRESET"));
    expect(delays).toEqual([1_000, 2_000]);
    expect(pending).toHaveLength(0);
    expect(s.state).toBe("unreachable");
    expect(s.health().reason).toBe("retries_exhausted");
  });

  /**
   * The other half of the same rule: a reconnect that HELD is a reconnect that
   * worked, and the budget comes back.
   *
   * MUTATION: delete the stability-window reset in `#onTransportClosed` →
   * this test goes red (the session settles on `unreachable` instead).
   */
  it("a reconnect that holds past the stability window gets the budget back", async () => {
    const delays: number[] = [];
    const pending: Array<() => void> = [];
    let clock = 1_700_000_000_000;
    const d = connectionDouble();
    const s = makeSession({
      maxReconnectAttempts: 1,
      reconnectStabilityWindowMs: 60_000,
      now: () => clock,
      scheduleRetry: (ms, run) => {
        delays.push(ms);
        pending.push(run);
      },
      connect: async () => d.connection,
    });
    await s.connect();

    d.drop(nodeError("ECONNRESET"));
    pending.shift()!();
    await vi.waitFor(() => expect(s.state).toBe("ready"));

    clock += 60_000; // the reconnected session held for the whole window

    d.drop(nodeError("ECONNRESET"));
    expect(s.state).toBe("reconnecting");
    expect(delays).toEqual([1_000, 1_000]);
  });
});

describe("close() racing an in-flight connect", () => {
  /**
   * ADR-043 §4's kill switch: `close()` landing mid-connect must not be
   * overwritten by the dial it interrupted. Without the post-await state
   * re-check the freshly built transport — CARRYING THE CUSTOMER'S BASIC
   * CREDENTIAL — is assigned to a session the caller has torn down, nothing
   * holds a reference to it, and the socket leaks.
   *
   * MUTATION: remove the `if (this.#state === "closed")` block after the
   * `await this.#connect(...)` → this test goes red.
   */
  it("closes the transport the interrupted dial produced and stays closed", async () => {
    const d = connectionDouble();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = makeSession({
      connect: async () => {
        await gate;
        return d.connection;
      },
    });

    const opening = s.connect();
    await s.close();
    expect(s.state).toBe("closed");

    release();
    const health = await opening;

    expect(health.state).toBe("closed");
    expect(s.state).toBe("closed");
    expect(d.close).toHaveBeenCalledOnce();
    await expect(s.callTool("jira_get_issue", {})).rejects.toBeInstanceOf(
      RemoteMcpSessionNotReadyError,
    );
  });

  /**
   * MUTATION: remove the `if (this.#state === "closed") return this.health();`
   * guard in the catch branch → this test goes red (the session lands on
   * `unreachable`, which `connect()` will happily re-dial).
   */
  it("a FAILED interrupted dial does not move the session out of closed", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = makeSession({
      connect: async () => {
        await gate;
        throw nodeError("ECONNREFUSED");
      },
    });

    const opening = s.connect();
    await s.close();
    release();

    expect((await opening).state).toBe("closed");
    expect(s.state).toBe("closed");
  });
});

describe("rule 19 — the credential never leaves the closure", () => {
  it("connect() hands the Basic header to the transport and nowhere else", async () => {
    const seen: Record<string, string>[] = [];
    const d = connectionDouble();
    const s = makeSession({
      connect: async (input) => {
        seen.push(input.headers);
        return d.connection;
      },
    });
    await s.connect();
    const expected = `Basic ${Buffer.from(`${FAKE_EMAIL}:${FAKE_TOKEN}`).toString("base64")}`;
    expect(seen[0].Authorization).toBe(expected);
  });

  it("health(), describeCredential() and a JSON dump of the session carry no token", async () => {
    const d = connectionDouble();
    const s = makeSession({ connect: async () => d.connection });
    await s.connect();
    await s.listTools();

    const encoded = Buffer.from(`${FAKE_EMAIL}:${FAKE_TOKEN}`).toString("base64");
    const surfaces = [
      JSON.stringify(s.health()),
      s.describeCredential(),
      JSON.stringify(s),
      // Everything a structured logger could reach by walking the instance.
      JSON.stringify(Object.entries(s)),
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain(FAKE_TOKEN);
      expect(surface).not.toContain(encoded);
    }
    // The identity half IS shown — an operator has to be able to answer
    // "connected as whom".
    expect(s.describeCredential()).toBe(`basic(${FAKE_EMAIL})`);
  });

  it("a failure state carries a fixed-vocabulary reason, never the server's text", async () => {
    const s = makeSession({
      connect: async () => {
        throw Object.assign(new Error(`rejected token ${FAKE_TOKEN}`), { code: 401 });
      },
    });
    const health = await s.connect();
    expect(JSON.stringify(health)).not.toContain(FAKE_TOKEN);
    expect(health.reason).toBe("credential_rejected");
  });

  it("refuses to build a Basic credential from an empty half", () => {
    expect(() => basicCredential("", FAKE_TOKEN)).toThrow();
    expect(() => basicCredential(FAKE_EMAIL, "")).toThrow();
  });
});
