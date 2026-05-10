/**
 * WARP-279 — Jira adapter unit tests.
 *
 * Mocks global `fetch` for the Atlassian REST API. We exercise:
 *   - "unconfigured" (missing env) returns empty + configured=false
 *   - WARP-228 chain ordering is preserved even when Jira returns
 *     issues in a different order
 *   - missing tickets in the chain are surfaced as `unknown`, not dropped
 *   - status classification (Done / In Progress / Blocked / Open / etc.)
 *   - in-flight tickets call uses the right JQL
 *   - chain_progress aggregates correctly
 *   - graceful degradation on fetch failure
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const FETCH = global.fetch;
const ORIG_HOST = process.env.JIRA_HOST;
const ORIG_EMAIL = process.env.JIRA_EMAIL;
const ORIG_TOKEN = process.env.JIRA_API_TOKEN;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Force config to load with credentials. We re-import per-test to pick up
// fresh env (zod parses at module init).
async function loadAdapter() {
  vi.resetModules();
  return await import("../services/claude-activity/jira-adapter.js");
}

describe("jira-adapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = FETCH;
    if (ORIG_HOST === undefined) delete process.env.JIRA_HOST;
    else process.env.JIRA_HOST = ORIG_HOST;
    if (ORIG_EMAIL === undefined) delete process.env.JIRA_EMAIL;
    else process.env.JIRA_EMAIL = ORIG_EMAIL;
    if (ORIG_TOKEN === undefined) delete process.env.JIRA_API_TOKEN;
    else process.env.JIRA_API_TOKEN = ORIG_TOKEN;
  });

  it("returns empty + configured=false when credentials are missing", async () => {
    process.env.JIRA_HOST = "";
    process.env.JIRA_EMAIL = "";
    process.env.JIRA_API_TOKEN = "";
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const adapter = await loadAdapter();
    const snap = await adapter.getJiraSnapshot({ bypassCache: true });
    expect(snap.configured).toBe(false);
    expect(snap.chain).toEqual([]);
    expect(snap.in_flight).toEqual([]);
    expect(snap.chain_progress.total).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves WARP-228 chain ordering and fills gaps with unknown", async () => {
    process.env.JIRA_HOST = "warp-lab.atlassian.net";
    process.env.JIRA_EMAIL = "x@y.z";
    process.env.JIRA_API_TOKEN = "tok";

    // Jira returns 3 of 50 tickets in shuffled order; the rest are missing.
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        issues: [
          {
            key: "WARP-231",
            fields: {
              summary: "UEFI Secure Boot",
              status: { name: "In Progress" },
              updated: "2026-05-10T10:00:00Z",
              assignee: { displayName: "Alice" },
            },
          },
          {
            key: "WARP-229",
            fields: {
              summary: "FIPS provider",
              status: { name: "Done" },
              updated: "2026-05-09T10:00:00Z",
              assignee: null,
            },
          },
          {
            key: "WARP-230",
            fields: {
              summary: "TPM identity",
              status: { name: "Blocked" },
              updated: "2026-05-08T10:00:00Z",
              assignee: null,
            },
          },
        ],
      }),
    ) as unknown as typeof fetch;

    const adapter = await loadAdapter();
    const chain = await adapter.getCompliancePhaseChain({ bypassCache: true });
    expect(chain).toHaveLength(50);
    // Order is preserved (229 → 278) regardless of Jira response order.
    expect(chain[0]?.key).toBe("WARP-229");
    expect(chain[0]?.status).toBe("done");
    expect(chain[1]?.key).toBe("WARP-230");
    expect(chain[1]?.status).toBe("blocked");
    expect(chain[2]?.key).toBe("WARP-231");
    expect(chain[2]?.status).toBe("in_progress");
    // Tickets not returned by Jira become "unknown" placeholders so the
    // dashboard renders all 50 cells; they include a ticket-tracker URL.
    expect(chain[3]?.key).toBe("WARP-232");
    expect(chain[3]?.status).toBe("unknown");
    expect(chain[3]?.url).toContain("WARP-232");
  });

  it("aggregates chain_progress counts correctly", async () => {
    process.env.JIRA_HOST = "warp-lab.atlassian.net";
    process.env.JIRA_EMAIL = "x@y.z";
    process.env.JIRA_API_TOKEN = "tok";

    // Two done, one in progress, one blocked, rest missing (unknown).
    global.fetch = vi.fn().mockImplementation((url: string) => {
      // URLSearchParams encodes spaces as `+`, so the chain JQL appears
      // as `key+in+%28...%29` in the URL.
      if (url.includes("/rest/api/3/search") && url.includes("key+in")) {
        return Promise.resolve(
          jsonResponse({
            issues: [
              { key: "WARP-229", fields: { summary: "a", status: { name: "Done" } } },
              { key: "WARP-230", fields: { summary: "b", status: { name: "Done" } } },
              { key: "WARP-231", fields: { summary: "c", status: { name: "In Progress" } } },
              { key: "WARP-232", fields: { summary: "d", status: { name: "Blocked" } } },
            ],
          }),
        );
      }
      // in-flight call
      return Promise.resolve(jsonResponse({ issues: [] }));
    }) as unknown as typeof fetch;

    const adapter = await loadAdapter();
    const snap = await adapter.getJiraSnapshot({ bypassCache: true });
    expect(snap.chain_progress).toEqual({
      total: 50,
      done: 2,
      in_progress: 1,
      blocked: 1,
      not_started: 46,
      percent: Math.round((2 / 50) * 100),
    });
  });

  it("returns an empty array when fetch errors", async () => {
    process.env.JIRA_HOST = "warp-lab.atlassian.net";
    process.env.JIRA_EMAIL = "x@y.z";
    process.env.JIRA_API_TOKEN = "tok";

    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error("boom")) as unknown as typeof fetch;

    const adapter = await loadAdapter();
    const got = await adapter.getCompliancePhaseChain({ bypassCache: true });
    expect(got).toEqual([]);
  });

  it("returns an empty array on non-2xx", async () => {
    process.env.JIRA_HOST = "warp-lab.atlassian.net";
    process.env.JIRA_EMAIL = "x@y.z";
    process.env.JIRA_API_TOKEN = "tok";

    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 401 })) as unknown as typeof fetch;

    const adapter = await loadAdapter();
    const got = await adapter.getInFlightTickets({ bypassCache: true });
    expect(got).toEqual([]);
  });

  it("uses statusCategory != Done JQL for in-flight", async () => {
    process.env.JIRA_HOST = "warp-lab.atlassian.net";
    process.env.JIRA_EMAIL = "x@y.z";
    process.env.JIRA_API_TOKEN = "tok";

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        issues: [
          {
            key: "WARP-279",
            fields: {
              summary: "Dashboard",
              status: { name: "In Progress" },
              updated: "2026-05-10T18:00:00Z",
              assignee: { displayName: "Romain" },
            },
          },
        ],
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const adapter = await loadAdapter();
    const got = await adapter.getInFlightTickets({ bypassCache: true });
    expect(got).toHaveLength(1);
    expect(got[0]?.key).toBe("WARP-279");
    expect(got[0]?.assignee).toBe("Romain");
    expect(got[0]?.url).toContain("warp-lab.atlassian.net/browse/WARP-279");
    // Verify the JQL we sent. URLSearchParams encodes spaces as `+`, so
    // the JQL appears as `project+%3D+WARP+...` in the query string.
    const calledUrl = fetchMock.mock.calls[0]?.[0];
    expect(String(calledUrl)).toContain("project+%3D+WARP");
    expect(String(calledUrl)).toContain("statusCategory+%21%3D+Done");
  });
});
