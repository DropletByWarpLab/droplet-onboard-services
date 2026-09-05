/**
 * WARP-2500 — the ERP lifecycle helpers address ONE provider.
 *
 * The orchestrator's `POST /api/integrations/eaglesoft/{disconnect,
 * write-enable,write-disable}` were the only spellings that existed, and
 * `disconnect()` / `setWriteEnabled()` behind them took no provider at all.
 * `connect()` meanwhile admits every provider `isKnownErpProvider` allows, so
 * WARP-2466 can create a Stripe / HubSpot / Mailchimp / QuickBooks row — and
 * nothing could purge one.
 *
 * The server half is fixed in `integrations.service.ts` +
 * `routes/integrations.ts`. This file pins the CLIENT half: that the URL these
 * two helpers build carries the provider they were handed, for every provider
 * the box can hold, rather than the `eaglesoft` literal they used to hardcode.
 *
 * There was no `api.erp.test.ts` before this ticket — the two helpers it
 * covers had no test of any kind, which is part of how the hardcoded path
 * survived the arrival of five cloud providers.
 *
 * `apiFetch` is mocked and the assertions are on the CALLS MADE, per the house
 * pattern (`api.access.test.ts`): what is under test is the request, and a
 * helper that returned the right shape while posting to the wrong URL is
 * exactly the defect being fixed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiFetch } from "./hooks/apiFetch";
import { disconnectProvider, setProviderWrites } from "./api.erp";

vi.mock("./hooks/apiFetch", () => ({ apiFetch: vi.fn() }));

const apiFetchMock = vi.mocked(apiFetch);

/**
 * Every provider a connection row can name, per
 * `packages/shared-types/src/provider-registry.ts` (`track !== "catalog"`).
 *
 * Written out rather than imported from the registry, deliberately and
 * unlike the orchestrator-side table: importing it would make this test agree
 * with the registry by construction, and what is being pinned here is the
 * WIRE — that the dashboard sends the key it was given, whatever it is. The
 * `eaglesoft` entry is what makes the deprecation observable: it must now
 * take the parameterised path too, not the legacy literal alias.
 */
const PROVIDERS = [
  "eaglesoft",
  "eaglesoft-api",
  "quickbooks-online",
  "dentrix-ascend",
  "stripe",
  "hubspot",
  "mailchimp",
] as const;

/** The URL of the Nth `apiFetch` call. */
function calledUrl(n = 0): string {
  const call = apiFetchMock.mock.calls[n];
  if (!call) throw new Error("apiFetch was never called");
  return call[0] as string;
}

/** The RequestInit of the Nth `apiFetch` call. */
function calledInit(n = 0): RequestInit {
  return (apiFetchMock.mock.calls[n]?.[1] ?? {}) as RequestInit;
}

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({} as never);
});

describe.each(PROVIDERS)("disconnectProvider(%s)", (provider) => {
  it("POSTs to that provider's own disconnect route", async () => {
    // Mutation: restore the hardcoded
    // `"/api/integrations/eaglesoft/disconnect"` → every row of this table
    // except `eaglesoft` goes red, which is the client-side statement of the
    // same defect the service-side table asserts.
    await disconnectProvider(provider);

    expect(calledUrl()).toBe(`/api/integrations/${provider}/disconnect`);
    expect(calledInit().method).toBe("POST");
  });
});

/**
 * There is deliberately NO assertion that the client has stopped using the
 * deprecated `eaglesoft` literal aliases.
 *
 * For `provider === "eaglesoft"` the parameterised URL and the alias are the
 * SAME STRING — `/api/integrations/eaglesoft/disconnect` — so no client-side
 * assertion can tell them apart, and one that claimed to would be measuring
 * nothing. What distinguishes them is which Express layer matches, which is
 * a server-side fact and is covered by `integrations-prefix.mount.test.ts`.
 * The aliases' removal is gated on the route enumeration in that file, not on
 * anything here.
 */

describe.each(PROVIDERS)("setProviderWrites(%s, …)", (provider) => {
  it("POSTs write-enable to that provider's own route", async () => {
    await setProviderWrites(provider, true);

    expect(calledUrl()).toBe(`/api/integrations/${provider}/write-enable`);
    expect(calledInit().method).toBe("POST");
  });

  it("POSTs write-disable to that provider's own route", async () => {
    // The kill-switch and the opt-in must not diverge: a mutation that scopes
    // only the enable branch leaves the disable branch flipping some other
    // connector's flag, which is the worse of the two directions to get wrong.
    await setProviderWrites(provider, false);

    expect(calledUrl()).toBe(`/api/integrations/${provider}/write-disable`);
  });
});

describe("a provider key is URL-encoded, not interpolated raw", () => {
  it("escapes a key that would otherwise change the path shape", async () => {
    // No shipped provider key contains a slash. This is not about today's
    // registry: `isKnownErpProvider` reads a LIVE registry that an operator
    // profile can extend at runtime, so the key reaching this helper is not
    // drawn from a closed set. Raw interpolation would let one add a path
    // segment — `a/b` posting to `/api/integrations/a/b/disconnect`, three
    // segments, which is the drift router's shape.
    //
    // Mutation: drop `encodeURIComponent` → red.
    await disconnectProvider("weird/key");

    expect(calledUrl()).toBe("/api/integrations/weird%2Fkey/disconnect");
    expect(calledUrl()).not.toContain("/weird/key/");
  });
});
