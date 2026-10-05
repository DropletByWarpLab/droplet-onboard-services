/**
 * WARP-3535 — the fetch seam on a declarative-REST connector.
 *
 * `ConnectorSelector.fetchImpl` is how the development panel puts the owner's
 * `work_integrations` switch and a pinned socket under the connector's own host
 * guard. What matters, and is pinned here, is that it is OPT-IN: every existing
 * caller (the credential probe, the assistant's reads, the ERP poller) builds
 * its connector with no `fetchImpl` and must keep dialling exactly as it did.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RestProfileConnector } from "@droplet/erp-connector";
import { connectorForProvider } from "./erp-provider.js";

const base = {
  provider: "github",
  host: "",
  cloudTokens: { resolveSaasSecret: async () => "github_pat_test" },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ConnectorSelector.fetchImpl", () => {
  it("is the fetch a REST connector dials through, and still behind its own host guard", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ login: "octocat" }), { status: 200 }));
    const connector = connectorForProvider({ ...base, fetchImpl });
    expect(connector).toBeInstanceOf(RestProfileConnector);

    await connector.health();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/user");
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer github_pat_test");
  });

  it("leaves a connector with no fetchImpl on globalThis.fetch, exactly as before", async () => {
    // Mutation: make the factory default to a gated fetch -> every existing caller
    // is silently put behind the switch and this goes red.
    const global = vi.fn(async () => new Response(JSON.stringify({ login: "octocat" }), { status: 200 }));
    vi.stubGlobal("fetch", global);
    await connectorForProvider(base).health();
    expect(global).toHaveBeenCalledTimes(1);
  });

  it("does not let the injected fetch past the connector's host guard: it never sees a refused URL", async () => {
    const fetchImpl = vi.fn();
    const connector = connectorForProvider({ ...base, fetchImpl });
    if (!(connector instanceof RestProfileConnector)) throw new Error("expected a REST connector");
    await expect(connector.readDevelopment({ feed: "commits", repo: "acme/../../admin" })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
