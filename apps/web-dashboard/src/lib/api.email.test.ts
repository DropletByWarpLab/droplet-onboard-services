/**
 * WARP-837 — the Email API client.
 *
 * The load-bearing case is `sendDraft`: the orchestrator answers 451
 * `off_lan_blocked` when outbound email is disabled by the off-LAN allowlist.
 * The client MUST map that to a typed `{ status: "off_lan_blocked", message }`
 * result — never a thrown raw error — so the UI can render a calm, actionable
 * message instead of crashing. The happy path (202) maps to
 * `{ status: "queued" }`. Other non-2xx still throw.
 *
 * The read calls + draft create/patch follow the existing api.ts contract:
 * authFetch + throw-on-non-2xx, with the filter query param wired through.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  fetchEmailAccounts,
  fetchEmailThreads,
  fetchEmailThread,
  fetchThreadAnalysis,
  createDraft,
  patchDraft,
  sendDraft,
} from "./api";
import { authFetch } from "./auth";

vi.mock("./auth", () => ({
  authFetch: vi.fn(),
}));

const authFetchMock = vi.mocked(authFetch);

function res(init: { ok?: boolean; status: number; json?: unknown }): Response {
  return {
    ok: init.ok ?? (init.status >= 200 && init.status < 300),
    status: init.status,
    json: vi.fn().mockResolvedValue(init.json ?? {}),
  } as unknown as Response;
}

beforeEach(() => {
  authFetchMock.mockReset();
});

describe("fetchEmailAccounts", () => {
  it("returns the accounts array on 200", async () => {
    authFetchMock.mockResolvedValue(
      res({
        status: 200,
        json: { accounts: [{ id: "a1", address: "me@home.net" }] },
      }),
    );
    await expect(fetchEmailAccounts()).resolves.toEqual([
      { id: "a1", address: "me@home.net" },
    ]);
    expect(authFetchMock).toHaveBeenCalledWith("/api/email/accounts");
  });

  it("throws on a non-2xx", async () => {
    authFetchMock.mockResolvedValue(res({ status: 500 }));
    await expect(fetchEmailAccounts()).rejects.toThrow();
  });
});

describe("fetchEmailThreads", () => {
  it("wires the filter into the query string and returns the threads array", async () => {
    authFetchMock.mockResolvedValue(
      res({ status: 200, json: { filter: "triaged", threads: [{ id: "t1" }] } }),
    );
    await expect(fetchEmailThreads("acc-1", "triaged")).resolves.toEqual([
      { id: "t1" },
    ]);
    const url = authFetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/api/email/acc-1/threads");
    expect(url).toContain("filter=triaged");
  });

  it("encodes the accountId path segment", async () => {
    authFetchMock.mockResolvedValue(
      res({ status: 200, json: { filter: "inbox", threads: [] } }),
    );
    await fetchEmailThreads("acc/../evil", "inbox");
    const url = authFetchMock.mock.calls[0][0] as string;
    expect(url).toContain("acc%2F..%2Fevil");
  });

  it("throws on a non-2xx", async () => {
    authFetchMock.mockResolvedValue(res({ status: 404 }));
    await expect(fetchEmailThreads("acc-1", "inbox")).rejects.toThrow();
  });
});

describe("fetchEmailThread", () => {
  it("returns the full thread (with messages) on 200", async () => {
    const thread = { id: "t1", subject: "Hi", messages: [{ id: "m1" }] };
    authFetchMock.mockResolvedValue(res({ status: 200, json: thread }));
    await expect(fetchEmailThread("acc-1", "t1")).resolves.toEqual(thread);
    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/email/acc-1/threads/t1",
    );
  });

  it("throws on a 404 (foreign / missing thread)", async () => {
    authFetchMock.mockResolvedValue(res({ status: 404 }));
    await expect(fetchEmailThread("acc-1", "nope")).rejects.toThrow();
  });
});

describe("fetchThreadAnalysis", () => {
  it("returns the analysis payload on 200", async () => {
    const analysis = {
      summary: "A summary.",
      callouts: [{ label: "deadline Friday" }],
      suggestedActions: [{ label: "Reply", safety: "Write · confirm" }],
      related: { files: [], threads: [], cameras: [], tools: [] },
    };
    authFetchMock.mockResolvedValue(res({ status: 200, json: analysis }));
    await expect(fetchThreadAnalysis("acc-1", "t1")).resolves.toEqual(analysis);
    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/email/acc-1/threads/t1/analysis",
    );
  });

  it("throws on a 503 (analysis service not wired) so SWR can retry", async () => {
    authFetchMock.mockResolvedValue(res({ status: 503 }));
    await expect(fetchThreadAnalysis("acc-1", "t1")).rejects.toThrow();
  });
});

describe("createDraft", () => {
  it("POSTs the body and returns the created draft on 201", async () => {
    const draft = { id: "d1", status: "draft", subject: "Re: Hi" };
    authFetchMock.mockResolvedValue(res({ status: 201, json: draft }));
    const input = { toAddrs: ["x@y.z"], subject: "Re: Hi", body: "hello" };
    await expect(createDraft("acc-1", input)).resolves.toEqual(draft);
    const [url, opts] = authFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/email/acc-1/drafts");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body as string)).toEqual(input);
  });

  it("throws on a 400 (invalid draft)", async () => {
    authFetchMock.mockResolvedValue(res({ status: 400 }));
    await expect(
      createDraft("acc-1", { toAddrs: [], subject: "" }),
    ).rejects.toThrow();
  });
});

describe("patchDraft", () => {
  it("PATCHes the body and returns the updated draft on 200", async () => {
    const draft = { id: "d1", status: "draft", subject: "edited" };
    authFetchMock.mockResolvedValue(res({ status: 200, json: draft }));
    await expect(patchDraft("d1", { subject: "edited" })).resolves.toEqual(
      draft,
    );
    const [url, opts] = authFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/email/drafts/d1");
    expect(opts.method).toBe("PATCH");
  });

  it("throws on a 409 (draft no longer editable)", async () => {
    authFetchMock.mockResolvedValue(res({ status: 409 }));
    await expect(patchDraft("d1", { subject: "too late" })).rejects.toThrow();
  });
});

describe("sendDraft", () => {
  it("maps a 202 to a queued result", async () => {
    authFetchMock.mockResolvedValue(
      res({ status: 202, json: { id: "d1", status: "queued" } }),
    );
    await expect(sendDraft("d1")).resolves.toEqual({
      status: "queued",
      id: "d1",
    });
    const [url, opts] = authFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/email/drafts/d1/send");
    expect(opts.method).toBe("POST");
  });

  it("maps a 451 to a typed off_lan_blocked result (NOT a throw)", async () => {
    authFetchMock.mockResolvedValue(
      res({
        status: 451,
        json: {
          error: "off_lan_blocked",
          channel: "outbound_email",
          message:
            "Outbound email is disabled by the off-LAN allowlist. An admin can enable outbound_email from Settings → Off-LAN allowlist with a reason.",
        },
      }),
    );
    const result = await sendDraft("d1");
    expect(result.status).toBe("off_lan_blocked");
    if (result.status === "off_lan_blocked") {
      expect(result.channel).toBe("outbound_email");
      expect(result.message).toContain("off-LAN");
    }
  });

  it("falls back to a friendly default message on a 451 with no body message", async () => {
    authFetchMock.mockResolvedValue(res({ status: 451, json: {} }));
    const result = await sendDraft("d1");
    expect(result.status).toBe("off_lan_blocked");
    if (result.status === "off_lan_blocked") {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("throws on a genuine error (409 already dispatched)", async () => {
    authFetchMock.mockResolvedValue(
      res({ status: 409, json: { error: "Draft already dispatched" } }),
    );
    await expect(sendDraft("d1")).rejects.toThrow();
  });

  it("throws on a 404 (draft not found)", async () => {
    authFetchMock.mockResolvedValue(res({ status: 404 }));
    await expect(sendDraft("nope")).rejects.toThrow();
  });
});
