/**
 * The REAL `confirmNetworkCommand` against a refused confirm (WARP-1907).
 *
 * 🔴 This file exists because the router-port write tests tested *around* the
 * gap rather than through it. `RouterPortWrite.test.tsx` mocks the hook's
 * `setPortEnabled` to reject with a ready-made `RouterPortRefusedError`, and
 * `useRouterPorts.test.tsx` mocks `@/lib/api` wholesale — so every assertion
 * about "a 409 becomes the escalated second confirm" was really an assertion
 * about a `vi.fn()`. Nothing anywhere drove the real `confirmNetworkCommand`,
 * and the real one discarded the response body: `throw new Error(\`Failed to
 * confirm command: ${res.status}\`)`.
 *
 * That mattered because a jack write is ALWAYS classified Tier 2. The mint POST
 * returns 202, so the guard refusal can only ever land on the confirm — the one
 * path no test touched. The feature was documented, reviewed and green while
 * being unreachable in production.
 *
 * So this file mocks one layer LOWER than any of them — `global.fetch` — and
 * runs the genuine `authFetch` → `confirmNetworkCommand` → `useRouterPorts`
 * chain. Responses are routed by URL, not by call order, so the hook's SWR read
 * cannot silently eat the response meant for the write.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import React from "react";

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { confirmNetworkCommand, RouterPortRefusedError } from "@/lib/api";
import { useRouterPorts } from "@/lib/hooks/useRouterPorts";

/** A `Response` double good enough for `authFetch` (it only reads ok/status/json). */
function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    clone() {
      return this;
    },
  };
}

/** The shape a proxy returns when it never reached the orchestrator at all. */
function htmlResponse(status: number) {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON")),
    clone() {
      return this;
    },
  };
}

const WAN_REFUSAL = {
  code: "PORT_WRITE_REFUSED",
  detail: { code: "WAN_PORT", reason: "wan is the household's internet uplink" },
};

beforeEach(() => {
  mockFetch.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("confirmNetworkCommand — a refused confirm keeps its code and detail", () => {
  it("turns a 409 PORT_WRITE_REFUSED into RouterPortRefusedError carrying the guard", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(409, WAN_REFUSAL));

    const err = await confirmNetworkCommand("tok", "router_port_disable").catch((e) => e);

    // The whole point of the escalation: the panel narrows on the class, then
    // renders the server's own reason as the destructive confirm's body.
    expect(err).toBeInstanceOf(RouterPortRefusedError);
    expect(err.guard).toEqual({
      code: "WAN_PORT",
      reason: "wan is the household's internet uplink",
    });
    expect(err.message).toBe("wan is the household's internet uplink");
  });

  it("does the same for a live management jack", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(409, {
        code: "PORT_WRITE_REFUSED",
        detail: { code: "MANAGEMENT_PORT", reason: "lan1 is carrying this session" },
      }),
    );

    const err = await confirmNetworkCommand("tok", "router_port_disable").catch((e) => e);

    expect(err).toBeInstanceOf(RouterPortRefusedError);
    expect(err.guard.code).toBe("MANAGEMENT_PORT");
  });

  it("refuses to invent a guard from a detail it does not recognise", async () => {
    // Narrowing must hold at the boundary: an unknown `detail.code` is NOT a
    // guard the panel knows how to escalate, so it must stay a plain error
    // rather than open a destructive confirm with a reason nobody wrote.
    mockFetch.mockResolvedValueOnce(
      jsonResponse(409, {
        code: "PORT_WRITE_REFUSED",
        detail: { code: "SOMETHING_ELSE", reason: "nope" },
      }),
    );

    const err = await confirmNetworkCommand("tok", "router_port_disable").catch((e) => e);

    expect(err).not.toBeInstanceOf(RouterPortRefusedError);
    expect(err.code).toBe("PORT_WRITE_REFUSED");
  });

  it("preserves code and status on any other refusal so translateError can speak", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(409, { code: "STALE_TOKEN", message: "that confirmation expired" }),
    );

    const err = await confirmNetworkCommand("tok", "router_port_disable").catch((e) => e);

    expect(err.message).toBe("that confirmation expired");
    expect(err.code).toBe("STALE_TOKEN");
    expect(err.status).toBe(409);
  });

  it("degrades to the generic error when the body is not JSON at all", async () => {
    // A 502 from the proxy never reached the orchestrator, so there is no
    // `code` to preserve. The error path must not throw the parse failure over
    // the top of the real one.
    mockFetch.mockResolvedValueOnce(htmlResponse(502));

    const err = await confirmNetworkCommand("tok", "router_port_disable").catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Failed to confirm command: 502");
    expect(err.status).toBe(502);
  });

  it("still returns the operationId on the success path", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { operationId: "op-7" }));

    await expect(confirmNetworkCommand("tok", "router_port_disable")).resolves.toEqual({
      operationId: "op-7",
    });
  });
});

describe("the escalation reaches the hook the panel actually calls", () => {
  /** Route by URL — the hook's SWR read and the write share one mock. */
  function routeFetch(onConfirm: () => unknown) {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/api/network/command/confirm")) {
        return Promise.resolve(onConfirm());
      }
      if (url.includes("/enable")) {
        // The mint ALWAYS classifies Tier 2 — this is why the 409 can only
        // ever arrive on the confirm.
        return Promise.resolve(
          jsonResponse(202, {
            requiresConfirmation: true,
            confirmationToken: "tok-abc",
            operation: "router_port_disable",
          }),
        );
      }
      return Promise.resolve(jsonResponse(200, {}));
    });
  }

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );

  it("surfaces RouterPortRefusedError out of setPortEnabled when the confirm is refused", async () => {
    routeFetch(() => jsonResponse(409, WAN_REFUSAL));
    const { result } = renderHook(() => useRouterPorts(), { wrapper });
    await waitFor(() => expect(result.current.setPortEnabled).toBeTypeOf("function"));

    let caught: unknown;
    await act(async () => {
      caught = await result.current.setPortEnabled("wan", false).catch((e) => e);
    });

    // `RouterPortsPanel.applyAction` narrows with `err instanceof
    // RouterPortRefusedError` to raise its second confirm. Before this fix the
    // hook handed it a bare Error and the branch was dead on the real path.
    expect(caught).toBeInstanceOf(RouterPortRefusedError);
    expect((caught as RouterPortRefusedError).guard.code).toBe("WAN_PORT");
  });

  it("resolves when the confirm succeeds — the refusal path is not the default", async () => {
    routeFetch(() => jsonResponse(200, { operationId: "op-1" }));
    const { result } = renderHook(() => useRouterPorts(), { wrapper });
    await waitFor(() => expect(result.current.setPortEnabled).toBeTypeOf("function"));

    let caught: unknown = "not-thrown";
    await act(async () => {
      caught = await result.current.setPortEnabled("lan4", false).catch((e) => e);
    });

    expect(caught).toBeUndefined();
  });
});
