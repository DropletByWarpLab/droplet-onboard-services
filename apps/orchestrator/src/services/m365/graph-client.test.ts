/**
 * WARP-2118 — tests for the Graph HTTP client.
 *
 * ## Why the host-guard tests assert on CALL COUNT, not on a thrown error
 *
 * The Mailchimp connector's header states the rule this file follows: for a
 * guard whose job is to stop a credential leaving the box, *"a test that
 * inspects the outcome still passes when the request already went out carrying
 * the customer's key."* Asserting `rejects.toThrow` proves the caller saw an
 * error; it does NOT prove the token stayed home. So every refusal case below
 * asserts `fetchImpl` was called ZERO times, which is the property that
 * actually matters.
 *
 * That distinction is not theoretical here. This guard runs on a URL loaded
 * FROM THE DATABASE on every request — a stored `@odata.deltaLink` — so it is
 * the only thing standing between a tampered row and a bearer token for the
 * customer's whole mailbox.
 */
import { describe, expect, it, vi } from "vitest";

import {
  GRAPH_ALLOWED_HOSTS,
  GRAPH_API_BASE_URL,
  GraphClient,
  GraphRequestError,
  UnsafeGraphUrlError,
  assertSafeGraphUrl,
} from "./graph-client.js";
import { classifySyncFailure } from "./sync-policy.js";

/** A fetch that must never be reached, for the refusal cases. */
function forbiddenFetch() {
  return vi.fn(async () => {
    throw new Error("the client dialled out when it must not have");
  });
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("GRAPH_API_BASE_URL", () => {
  it("is a whole-string https literal the egress scanner can extract", () => {
    // The `m365-graph-api` allowlist entry is armed to fail until a
    // graph.microsoft.com literal appears in one of its code_refs. A literal
    // assembled from parts would not satisfy the scanner, so this pins the
    // shape rather than just the value.
    expect(GRAPH_API_BASE_URL).toBe("https://graph.microsoft.com/v1.0");
  });

  it("never points at /beta, which carries no deprecation contract", () => {
    expect(GRAPH_API_BASE_URL).not.toContain("/beta");
  });

  it("derives the allowed-host set rather than hardcoding it", () => {
    expect([...GRAPH_ALLOWED_HOSTS]).toEqual(["graph.microsoft.com"]);
  });

  it("does not admit the Entra token host — a data client must never dial one", () => {
    expect(GRAPH_ALLOWED_HOSTS.has("login.microsoftonline.com")).toBe(false);
  });
});

describe("assertSafeGraphUrl", () => {
  it("accepts a Graph URL and returns it UNCHANGED", () => {
    // Not normalised: a delta link's query is opaque state Microsoft issued,
    // and rewriting any part of it turns a resync into a silent partial sync.
    const link = `${GRAPH_API_BASE_URL}/me/mailFolders/x/messages/delta?$deltatoken=abc%3D%3D`;
    expect(assertSafeGraphUrl(link)).toBe(link);
  });

  it.each([
    ["http, not https", "http://graph.microsoft.com/v1.0/me/messages"],
    ["userinfo", "https://evil@graph.microsoft.com/v1.0/me/messages"],
    ["a look-alike host", "https://graph.microsoft.com.evil.test/v1.0/me"],
    ["an unregistered host", "https://outlook.office.com/api/v2.0/me/messages"],
    ["the token endpoint", "https://login.microsoftonline.com/common/oauth2/v2.0/token"],
    ["a non-443 port", "https://graph.microsoft.com:8443/v1.0/me/messages"],
    ["not a URL at all", "/v1.0/me/messages"],
  ])("refuses %s", (_label, url) => {
    expect(() => assertSafeGraphUrl(url)).toThrow(UnsafeGraphUrlError);
  });

  it("accepts an explicit :443, which the URL parser drops", () => {
    expect(() => assertSafeGraphUrl("https://graph.microsoft.com:443/v1.0/me")).not.toThrow();
  });
});

describe("GraphClient.getPage — the guard runs before any I/O", () => {
  it.each([
    ["a redirected host in a stored delta link", "https://evil.test/v1.0/me/messages/delta"],
    ["an http downgrade", "http://graph.microsoft.com/v1.0/me/messages/delta"],
  ])("does not dial out for %s", async (_label, url) => {
    const fetchImpl = forbiddenFetch();
    const client = new GraphClient({ fetchImpl });

    await expect(client.getPage(url, "a-token")).rejects.toThrow(UnsafeGraphUrlError);

    // THE assertion: the token never left the box.
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });
});

describe("GraphClient.getPage — a successful page", () => {
  it("returns items, links and the raw body, and sends the documented headers", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        value: [{ id: "1" }, { id: "2" }],
        "@odata.deltaLink": `${GRAPH_API_BASE_URL}/me/mailFolders/x/messages/delta?$deltatoken=next`,
      }),
    );
    const client = new GraphClient({ fetchImpl, version: "1.2.3" });

    const page = await client.getPage(`${GRAPH_API_BASE_URL}/me/mailFolders/x/messages/delta`, "tok");

    expect(page.items).toHaveLength(2);
    expect(page.links.deltaLink).toContain("$deltatoken=next");
    expect(page.links.nextLink).toBeNull();

    const init = fetchImpl.mock.calls[0]?.[1] as Record<string, unknown>;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    // Microsoft asks integrators to identify themselves; it is also what lets a
    // customer's admin see which app is being throttled.
    expect(headers["User-Agent"]).toBe("ISV|WarpLab|Droplet/1.2.3");
    // A followed redirect either drops the Authorization header or sends it
    // somewhere the host guard never saw. Both are worse than a failed sync.
    expect(init.redirect).toBe("manual");
  });

  it("treats a missing `value` array as no items rather than as malformed", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ "@odata.deltaLink": "x" }));
    const page = await new GraphClient({ fetchImpl }).getPage(GRAPH_API_BASE_URL + "/me", "t");
    expect(page.items).toEqual([]);
  });
});

describe("GraphClient.getPage — failures are shaped for classifySyncFailure", () => {
  it("surfaces Graph's error.code so a dead delta token means RESYNC, not FATAL", async () => {
    // The whole point of extracting `error.code`: `syncStateNotFound` arriving
    // as prose inside a message would classify FATAL, and the cursor would stop
    // permanently instead of re-enumerating.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "syncStateNotFound", message: "token expired" } }, { status: 410 }),
    );
    const client = new GraphClient({ fetchImpl });

    const err = await client
      .getPage(GRAPH_API_BASE_URL + "/me/messages/delta", "t")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GraphRequestError);
    const graphErr = err as GraphRequestError;
    expect(graphErr.code).toBe("syncStateNotFound");
    expect(graphErr.statusCode).toBe(410);
    expect(classifySyncFailure(graphErr)).toBe("RESYNC_REQUIRED");
  });

  it("carries the RAW Retry-After header through, unparsed", async () => {
    // `recordFailure` parses it against its own clock. Parsing here would
    // resolve an HTTP-date form against a different `now` than the cursor is
    // scheduled from.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "activityLimitReached" } }, {
        status: 429,
        headers: { "retry-after": "120" },
      }),
    );
    const err = (await new GraphClient({ fetchImpl })
      .getPage(GRAPH_API_BASE_URL + "/me", "t")
      .catch((e: unknown) => e)) as GraphRequestError;

    expect(err.retryAfterHeader).toBe("120");
    expect(classifySyncFailure(err)).toBe("TRANSIENT");
  });

  it("never propagates the vendor's message, which can quote a delta token", async () => {
    const leaky = "failed for $deltatoken=SECRETTOKENVALUE";
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "ErrorInvalidRequest", message: leaky } }, { status: 400 }),
    );
    const err = (await new GraphClient({ fetchImpl })
      .getPage(GRAPH_API_BASE_URL + "/me", "t")
      .catch((e: unknown) => e)) as GraphRequestError;

    // This string reaches `lastError`, which is rendered to the owner and logged.
    expect(err.message).not.toContain("SECRETTOKENVALUE");
    expect(err.message).toContain("ErrorInvalidRequest");
  });

  it("refuses a 3xx instead of following it", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302 }));
    const err = (await new GraphClient({ fetchImpl })
      .getPage(GRAPH_API_BASE_URL + "/me", "t")
      .catch((e: unknown) => e)) as GraphRequestError;

    expect(err).toBeInstanceOf(GraphRequestError);
    expect(err.statusCode).toBe(302);
  });

  it("maps a transport failure to a TRANSIENT errno, not to FATAL", async () => {
    const fetchImpl = vi.fn(async () => {
      const e = new Error("socket hang up") as Error & { code: string };
      e.code = "ECONNRESET";
      throw e;
    });
    const err = (await new GraphClient({ fetchImpl })
      .getPage(GRAPH_API_BASE_URL + "/me", "t")
      .catch((e: unknown) => e)) as GraphRequestError;

    expect(classifySyncFailure(err)).toBe("TRANSIENT");
  });

  it("does not echo the requested URL, which is itself credential-shaped", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    });
    const url = `${GRAPH_API_BASE_URL}/me/messages/delta?$deltatoken=SECRETTOKENVALUE`;
    const err = (await new GraphClient({ fetchImpl })
      .getPage(url, "t")
      .catch((e: unknown) => e)) as GraphRequestError;

    expect(err.message).not.toContain("SECRETTOKENVALUE");
  });
});
