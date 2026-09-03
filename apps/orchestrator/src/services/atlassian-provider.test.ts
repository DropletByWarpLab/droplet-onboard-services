/**
 * WARP-2650 — the `atlassian` provider descriptor, and the connect flow that
 * finally produces the row #1964's remote gate requires.
 *
 * ## What was missing, precisely
 *
 * #1964 attaches the Atlassian remote behind three fail-closed gates, the third
 * being *a CONNECTED `IntegrationConnection` row for provider `atlassian`
 * holding an ADR-042-sealed credential*. Nothing could create one. There was no
 * descriptor, so `configurableDescriptors()` never offered the provider,
 * `requireDescriptor()` 404'd the PATCH that writes credentials, and #1964's own
 * Gaps list said the row *"must be created by hand"*.
 *
 * `remote-mcp-attach.test.ts` (#1964) already proves the multiplexer half from a
 * HAND-WRITTEN row. This file's contribution is the other half: the row is
 * produced by the shipped connect path — the real descriptor, the real
 * `resolveCredentialUpdate`, the real ADR-042 seal — and only then handed to the
 * real gate, the real `McpBridgeClient` and the real multiplexer. The join
 * between the two halves is what did not exist.
 *
 * ## Fixtures
 *
 * The credential is `ATATT-FAKE-000000000000`, the site id is an all-zero UUID
 * and every host is RFC 2606 reserved. The bridge is a fixture served by an
 * INJECTED fetch, never a globally patched one, so "refused before the network"
 * is asserted as zero calls rather than inferred from a missing result.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildableProviderIds,
  cloudProviderIds,
  credentialExpiryVerdict,
  mcpProviderIds,
  parseProviderConfigWith,
  providerDescriptor,
  setupGuideHrefFor,
  type ProviderDescriptor,
} from "@droplet/shared-types";

import {
  ATLASSIAN_TOKEN_EXPIRY_WARNING_DAYS,
  ATLASSIAN_TOKEN_MAX_LIFETIME_DAYS,
  atlassianTokenExpiryStatus,
} from "./atlassian-token-expiry.js";
import { __setColumnCryptoKeyForTest } from "./column-crypto.service.js";
import { isCloudErpProvider, isKnownErpProvider } from "./erp-provider.js";
import { McpBridgeClient } from "./mcp-bridge.client.js";
import { McpToolMultiplexer, type RemoteCallPolicy } from "./mcp-multiplexer.service.js";
import type { McpClientPort, McpToolDescriptor } from "./mcp-client.port.js";
import {
  ATLASSIAN_REMOTE_SERVER_ID,
  attachAtlassianRemote,
} from "./remote-mcp-servers.js";
import { RuntimeToolRegistry } from "./runtime-tool-registry.service.js";
import {
  buildCredentialView,
  openSaasCredentials,
  requireDescriptor,
  resolveCredentialUpdate,
  sealSaasCredentials,
  statusAfterCredentialUpdate,
  SaasCredentialValidationError,
  type SaasConnectionRow,
} from "./saas-credential.service.js";

vi.mock("./activity.singleton.js", () => ({
  recordActivity: vi.fn(async () => null),
  getActivitySigner: () => null,
}));

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const ROW_ID = "conn_atlassian_0000000001";
const FAKE_API_TOKEN = "ATATT-FAKE-000000000000";
const FAKE_EMAIL = "ops@vendor.example";
const FAKE_CLOUD_ID = "00000000-0000-4000-8000-000000000000";
const BRIDGE_URL = "http://mcp-bridge.test:9096";
const BRIDGE_TOKEN = "bridge-token-FAKE-0000000000000000";

beforeEach(() => {
  vi.clearAllMocks();
  __setColumnCryptoKeyForTest(TEST_KEY);
});

function atlassian(): ProviderDescriptor {
  const d = providerDescriptor("atlassian");
  expect(d, "the atlassian descriptor is not registered").toBeDefined();
  return d!;
}

/** An empty row, exactly as the PATCH route creates one before sealing. */
function emptyRow(): SaasConnectionRow {
  return {
    id: ROW_ID,
    provider: "atlassian",
    status: "NOT_CONFIGURED",
    providerTokensEnc: null,
    apiCredentialsEnc: null,
    providerConfig: null,
  };
}

/**
 * Run the SHIPPED connect path over a submitted field map and return the row
 * it would persist.
 *
 * A transcription of `routes/saas-credentials.ts`'s PATCH handler, minus
 * Express and Prisma: same descriptor, same `resolveCredentialUpdate`, same
 * `statusAfterCredentialUpdate`, same three columns. Deliberately not a
 * hand-written row — the whole point of this file is that the row the gate
 * accepts is one the product can produce.
 */
function connect(submitted: Record<string, string>): SaasConnectionRow {
  const descriptor = requireDescriptor("atlassian");
  const row = emptyRow();
  const resolved = resolveCredentialUpdate(descriptor, null, submitted, row.id);
  return {
    ...row,
    status: statusAfterCredentialUpdate(descriptor, row.status, resolved.hasSecret),
    providerTokensEnc:
      resolved.providerTokensEnc === undefined ? null : resolved.providerTokensEnc,
    providerConfig:
      resolved.providerConfig === undefined ? null : resolved.providerConfig,
  };
}

const GOOD_SUBMISSION = {
  email: FAKE_EMAIL,
  apiToken: FAKE_API_TOKEN,
  cloudId: FAKE_CLOUD_ID,
  tokenExpiresAt: "2027-06-01",
};

// ===========================================================================
// The descriptor's shape — what an `mcp` track is and, more usefully, is not
// ===========================================================================

describe("the atlassian descriptor is an mcp track, not a cloud one", () => {
  it("is registered, and every derived list places it correctly", () => {
    expect(atlassian().track).toBe("mcp");
    expect(mcpProviderIds()).toContain("atlassian");
    // The three exclusions that keep an MCP row out of machinery it has no
    // business in. Mutation: flip `buildableProviderIds`/`isKnownErpProvider`
    // back to `track !== "catalog"` → the first two go red, and a real row
    // would reach `connectorForProvider` and throw.
    expect(buildableProviderIds()).not.toContain("atlassian");
    expect(isKnownErpProvider("atlassian")).toBe(false);
    expect(cloudProviderIds()).not.toContain("atlassian");
    expect(isCloudErpProvider("atlassian")).toBe(false);
  });

  it("serves no dataset, so `cloud_query_dataset` can never resolve to it", () => {
    // Two independent reasons, and both are asserted because either alone
    // would be enough today and neither would survive the other being edited:
    // `cloudRowForDataset` filters `cloudProviderIds()` FIRST (above), and the
    // descriptor's `datasets` is the empty tuple by construction.
    expect(atlassian().datasets).toEqual([]);
  });

  it("declares no LAN provisioning, no rate limit and no poll floor", () => {
    // Not stylistic: the type refuses all three on this arm, and these
    // assertions are what a reader sees when asking why. A poll floor of `0`
    // would read as "no floor, poll as fast as you like"; there is no
    // scheduled sync for this track at all.
    const d = atlassian();
    expect(d.lanProvisioning).toBeUndefined();
    expect(d.rateLimit).toBeUndefined();
    expect(d.pollIntervalFloorMs).toBeUndefined();
  });

  it("puts no card on the Integrations hub", () => {
    // Stated, not discovered. The hub's card ids are a closed union in the
    // dashboard and its connect flow is the ERP wizard, which probes a
    // transport and starts a dataset sync — none of which exists here.
    expect(atlassian().catalog).toBeUndefined();
  });

  it("carries the setup guide the customer cannot connect without", () => {
    expect(setupGuideHrefFor(atlassian())).toBe("/help/integrations/atlassian");
  });

  it("registers the ONE host the integration dials, and only that one", () => {
    // `auth.atlassian.com` (OAuth — a v1 non-goal) and `api.atlassian.com` are
    // absent on purpose: nothing dials them, and a registered host nothing
    // dials is a permanent unfalsifiable hole in a default-deny registry.
    expect(atlassian().egressHosts).toEqual(["mcp.atlassian.com"]);
  });
});

// ===========================================================================
// The field names are a wire contract with `readAtlassianCredential`
// ===========================================================================

describe("the credential fields match what the attach path reads", () => {
  it("puts email and cloudId in providerConfig and apiToken in the sealed blob", () => {
    // `readAtlassianCredential` (`remote-mcp-servers.ts`) reads exactly these
    // three names, out of exactly these two homes, with no fallback between
    // them. A rename on either side produces a row the attach path reports as
    // `credential_incomplete`, which reads to an operator as their own typo.
    const byName = new Map(atlassian().credentialFields.map((f) => [f.name, f]));
    expect([...byName.keys()]).toEqual(["email", "apiToken", "cloudId", "tokenExpiresAt"]);

    expect(byName.get("email")).toMatchObject({
      required: true,
      secret: false,
      storage: "providerConfig",
    });
    expect(byName.get("cloudId")).toMatchObject({
      required: true,
      secret: false,
      storage: "providerConfig",
    });
    expect(byName.get("apiToken")).toMatchObject({
      required: true,
      secret: true,
      storage: "encrypted",
    });
    // Optional by design — Atlassian does not tell the box the date, so this is
    // the customer transcribing it. A connection without it is EXPIRY_UNKNOWN,
    // never VALID.
    expect(byName.get("tokenExpiresAt")).toMatchObject({
      required: false,
      secret: false,
      storage: "providerConfig",
    });
  });

  it("declares no `secretRef` field — WARP-2028 is not reopened", () => {
    // `secretRef` is a pointer into a secret store that does not exist. The row
    // keeps its `<provider>:pending` convention; nothing here writes one.
    expect(atlassian().credentialFields.map((f) => f.name)).not.toContain("secretRef");
  });
});

// ===========================================================================
// The expiry window, and the duplication it is gated against
// ===========================================================================

describe("the credential expiry policy agrees with WARP-2353's module", () => {
  it("mirrors the warning window and the vendor's maximum lifetime", () => {
    // `atlassian-token-expiry.ts` is orchestrator-only and this descriptor is
    // bundled into the dashboard, so the numbers are duplicated by necessity —
    // and CHECKED rather than trusted, the same deal `ATLASSIAN_SERVER_ID` gets.
    expect(atlassian().credentialExpiry).toEqual({
      field: "tokenExpiresAt",
      warningDays: ATLASSIAN_TOKEN_EXPIRY_WARNING_DAYS,
      maxLifetimeDays: ATLASSIAN_TOKEN_MAX_LIFETIME_DAYS,
    });
  });

  it("names a field the descriptor actually declares, in providerConfig", () => {
    const policy = atlassian().credentialExpiry!;
    const field = atlassian().credentialFields.find((f) => f.name === policy.field);
    expect(field, `credentialExpiry.field "${policy.field}" is not a declared field`)
      .toBeDefined();
    expect(field?.storage).toBe("providerConfig");
    expect(field?.secret).toBe(false);
  });

  it("classifies the boundary exactly as atlassianTokenExpiryStatus does", () => {
    // The generic verdict and the vendor module must not disagree about the day
    // a connection stops being green. The vendor module is handed the SAME
    // instant the generic one derives from the date string — midnight UTC, the
    // start of the stated day — because that is the choice under test, not an
    // accident of how the fixture was written.
    const now = new Date("2026-09-02T00:00:00Z");
    const cases: Array<[string, "VALID" | "EXPIRING_SOON" | "EXPIRED", number]> = [
      ["2027-09-02", "VALID", 365],
      ["2026-10-03", "VALID", 31],
      // The exact edge: 30 days out is INSIDE a 30-day window (`<=`).
      ["2026-10-02", "EXPIRING_SOON", 30],
      ["2026-09-03", "EXPIRING_SOON", 1],
      // Expires today. Still working, still not CONNECTED.
      ["2026-09-02", "EXPIRING_SOON", 0],
      ["2026-09-01", "EXPIRED", -1],
    ];
    for (const [date, expected, days] of cases) {
      const config = parseProviderConfigWith(atlassian(), {
        email: FAKE_EMAIL,
        cloudId: FAKE_CLOUD_ID,
        tokenExpiresAt: date,
      });
      const generic = credentialExpiryVerdict(atlassian(), config, now);
      expect(generic, date).toEqual({ status: expected, daysRemaining: days });

      const vendor = atlassianTokenExpiryStatus({
        hasToken: true,
        expiresAt: new Date(`${date}T00:00:00Z`),
        now,
      });
      // The vendor module says CONNECTED where the generic one says VALID —
      // the same verdict in two vocabularies, because one answers "what is
      // this connection's status" and the other "how long has it got".
      expect(vendor.status === "CONNECTED" ? "VALID" : vendor.status, date).toBe(expected);
      expect(vendor.daysRemaining, date).toBe(generic?.daysRemaining);
    }
  });

  it("FLOORS the day count — 30 days and 14 hours is inside a 30-day window", () => {
    // The case that separates floor from round, and the only one that does:
    // 30.58 days floors to 30 (warn) and rounds to 31 (green). Rounding would
    // keep a connection green on the first day it owed the owner notice.
    // Mutation: `Math.round` in `credentialExpiryVerdict` → red.
    const config = parseProviderConfigWith(atlassian(), {
      email: FAKE_EMAIL,
      cloudId: FAKE_CLOUD_ID,
      tokenExpiresAt: "2026-10-02",
    });
    const verdict = credentialExpiryVerdict(
      atlassian(),
      config,
      new Date("2026-09-01T10:00:00Z"),
    );
    expect(verdict).toEqual({ status: "EXPIRING_SOON", daysRemaining: 30 });
  });

  it("reports EXPIRY_UNKNOWN — never VALID — when no date was recorded", () => {
    const config = parseProviderConfigWith(atlassian(), {
      email: FAKE_EMAIL,
      cloudId: FAKE_CLOUD_ID,
    });
    expect(credentialExpiryVerdict(atlassian(), config, new Date())?.status).toBe(
      "EXPIRY_UNKNOWN",
    );
  });

  it("gives a provider with no expiry policy no verdict at all", () => {
    // `undefined` is "this credential cannot expire", which is a different
    // answer from EXPIRY_UNKNOWN. Collapsing them would put every Stripe
    // connection in a warning state it can never leave.
    const stripe = providerDescriptor("stripe");
    expect(credentialExpiryVerdict(stripe, undefined, new Date())).toBeUndefined();
  });
});

// ===========================================================================
// The connect flow produces the row the remote gate requires
// ===========================================================================

describe("the connect flow writes the row #1964's third gate looks for", () => {
  it("seals the token under the ADR-042 key and lands the row at CONNECTED", () => {
    const row = connect(GOOD_SUBMISSION);

    // Gate 3's two explicit reads, both satisfied by the shipped path.
    expect(row.status).toBe("CONNECTED");
    expect(row.providerTokensEnc).not.toBeNull();

    // Sealed under `deriveSaasCredentialKey()` with AAD `saas-credential:<id>`.
    // Opening it with the row's own id is the whole ADR-042 contract.
    expect(openSaasCredentials(row.id, row.providerTokensEnc!)).toEqual({
      apiToken: FAKE_API_TOKEN,
    });
  });

  it("keeps the token OUT of the unencrypted column, and out of the view", () => {
    // #1964's M10 guard from the other end: `readAtlassianCredential` reads the
    // secret from exactly one home, so a token that reached `providerConfig`
    // would not work — but it would still be sitting in plaintext in Postgres.
    const row = connect(GOOD_SUBMISSION);
    const config = row.providerConfig as Record<string, unknown>;
    // Exactly the three `providerConfig` fields the descriptor declares, and
    // no fourth. (`resolveCredentialUpdate` writes no `provider` key — that is
    // emitted by `parseProviderConfigResult` on the READ path.)
    expect(config).toEqual({
      email: FAKE_EMAIL,
      cloudId: FAKE_CLOUD_ID,
      tokenExpiresAt: "2027-06-01",
    });
    expect(JSON.stringify(config)).not.toContain(FAKE_API_TOKEN);

    const view = buildCredentialView(atlassian(), row, new Date("2026-09-02T00:00:00Z"));
    expect(JSON.stringify(view)).not.toContain(FAKE_API_TOKEN);
    // The one thing the browser learns about the secret.
    expect(view.fields.find((f) => f.name === "apiToken")?.hasValue).toBe(true);
    expect(view.state).toBe("CONNECTED");
    expect(view.setupGuideHref).toBe("/help/integrations/atlassian");
    expect(view.credentialExpiry).toEqual({ status: "VALID", daysRemaining: 272 });
  });

  it("refuses a submission missing cloudId rather than storing half a connection", () => {
    // The token is not site-bound, so a connection that cannot name its site
    // cannot be dialled at all. Refused at the write, not at dial time.
    expect(() => connect({ email: FAKE_EMAIL, apiToken: FAKE_API_TOKEN })).toThrow(
      SaasCredentialValidationError,
    );
  });

  it("refuses a malformed expiry date instead of silently dropping it", () => {
    // `tokenExpiresAt` is optional, but a value that fails the descriptor's
    // pattern must not be discarded into "no expiry recorded" — that would
    // turn a typo into a connection that can never be warned about.
    expect(() => connect({ ...GOOD_SUBMISSION, tokenExpiresAt: "June 2027" })).toThrow(
      SaasCredentialValidationError,
    );
  });

  it("clears back to NOT_CONFIGURED when the token is removed", () => {
    // The honesty rule: CONNECTED is only ever written alongside a credential.
    const descriptor = requireDescriptor("atlassian");
    const connected = connect(GOOD_SUBMISSION);
    const resolved = resolveCredentialUpdate(
      descriptor,
      connected,
      { apiToken: "" },
      connected.id,
    );
    expect(resolved.cleared).toBe(true);
    expect(
      statusAfterCredentialUpdate(descriptor, connected.status, resolved.hasSecret),
    ).toBe("NOT_CONFIGURED");
  });

  it("leaves a cloud track on PROVISIONING — CONNECTED is the mcp track's rule", () => {
    // The claim `mcp`'s CONNECTED makes is weaker than a cloud track's, and it
    // is scoped to the track rather than applied to every paste.
    const stripe = requireDescriptor("stripe");
    expect(statusAfterCredentialUpdate(stripe, "NOT_CONFIGURED", true)).toBe(
      "PROVISIONING",
    );
    expect(statusAfterCredentialUpdate(atlassian(), "NOT_CONFIGURED", true)).toBe(
      "CONNECTED",
    );
  });

  it("keeps a DISABLED row disabled — pasting a key is not turning it back on", () => {
    expect(statusAfterCredentialUpdate(atlassian(), "DISABLED", true)).toBe("DISABLED");
  });
});

// ===========================================================================
// End to end: connect flow → gate → bridge → multiplexer
// ===========================================================================

const READY_STATE = {
  serverId: ATLASSIAN_REMOTE_SERVER_ID,
  state: "ready",
  toolCount: 2,
  consecutiveFailures: 0,
  lastReadyAt: 1,
  reason: null,
};

const WIRE_TOOLS: McpToolDescriptor[] = [
  { name: "getJiraIssue", description: "Read one Jira issue", inputSchema: { type: "object" } },
  { name: "searchConfluenceUsingCql", description: "Search", inputSchema: { type: "object" } },
];

function localPort(): McpClientPort {
  return {
    isStarted: true,
    listTools: async () => [
      { name: "list_files", description: "local", inputSchema: { type: "object" } },
    ],
    callTool: async () => ({ content: [], isError: false }),
  };
}

/** The fixture bridge, behind an INJECTED fetch. Records every call, and the
 *  credential body it was handed, so "the right token reached the session" and
 *  "nothing was dialled" are both assertable. */
function fixtureBridge() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace(BRIDGE_URL, "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method: init?.method ?? "GET", path, body });
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (path.endsWith("/open")) return json(200, { state: READY_STATE });
    if (path.endsWith("/tools")) return json(200, { tools: WIRE_TOOLS, state: READY_STATE });
    return json(404, { error: { code: "NOT_FOUND", message: path } });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const allowAllReads: RemoteCallPolicy = () => ({ kind: "allow" });

/** The whole stack, from the persisted row down to the injected fetch. Only
 *  the bridge and the local stdio child are doubles. */
function stack(row: SaasConnectionRow | null, allowlist: string[]) {
  const bridge = fixtureBridge();
  const mux = new McpToolMultiplexer(localPort(), {
    isServerAllowed: (id) => allowlist.includes(id),
    remoteCallPolicy: allowAllReads,
  });
  const prisma = {
    integrationConnection: { findFirst: vi.fn(async () => row) },
  };
  return {
    bridge,
    mux,
    prisma,
    attach: () =>
      attachAtlassianRemote({
        mux,
        prisma,
        allowlist: new Set(allowlist),
        registry: new RuntimeToolRegistry(),
        createClient: () =>
          new McpBridgeClient({
            baseUrl: BRIDGE_URL,
            serviceToken: BRIDGE_TOKEN,
            serverId: ATLASSIAN_REMOTE_SERVER_ID,
            fetchImpl: bridge.fetchImpl,
          }),
        // The REAL opener, against the row the connect flow sealed. Passing a
        // stub here would skip the AAD binding that is the point of ADR-042.
        openCredentials: openSaasCredentials,
      }),
  };
}

describe("end to end — the row the connect flow wrote reaches the vendor's tools", () => {
  it("attaches and advertises atlassian__* once the operator opts in", async () => {
    // REMOTE_MCP_SERVER_ALLOWLIST=atlassian, and a row produced by the shipped
    // credential write rather than by hand. This is the join #1964's Gap 1 said
    // did not exist.
    const row = connect(GOOD_SUBMISSION);
    const h = stack(row, ["atlassian"]);

    const result = await h.attach();
    expect(result).toMatchObject({ attached: true, serverId: "atlassian" });

    const tools = await h.mux.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "list_files",
      "atlassian__getJiraIssue",
      "atlassian__searchConfluenceUsingCql",
    ]);

    // The session was opened with the three facts read out of the row's two
    // homes — the sealed token and the two `providerConfig` values.
    const open = h.bridge.calls.find((c) => c.path.endsWith("/open"));
    expect(open?.body).toEqual({
      email: FAKE_EMAIL,
      apiToken: FAKE_API_TOKEN,
      cloudId: FAKE_CLOUD_ID,
    });
  });

  it("refuses with ZERO bridge calls when no connection row exists", async () => {
    // The state a missing descriptor leaves the box in: the credential route
    // 404s, no row is ever written, and the gate's second explicit read finds
    // nothing. Asserted as zero calls, not as an empty tool list.
    const h = stack(null, ["atlassian"]);

    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "gate_refused" });
    expect(h.bridge.fetchImpl).not.toHaveBeenCalled();
    expect(h.bridge.calls).toHaveLength(0);

    const tools = await h.mux.listTools();
    expect(tools.some((t) => t.name.startsWith("atlassian__"))).toBe(false);
  });

  it("refuses with ZERO bridge calls while the row is not yet CONNECTED", async () => {
    // A row mid-write — the credential cleared, or an operator having disabled
    // it. `status` is read as the explicit enum, never as "a row exists".
    const row = { ...connect(GOOD_SUBMISSION), status: "DISABLED" };
    const h = stack(row, ["atlassian"]);

    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "gate_refused" });
    expect(h.bridge.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses with ZERO bridge calls when the credential was purged", async () => {
    const row = { ...connect(GOOD_SUBMISSION), providerTokensEnc: null };
    const h = stack(row, ["atlassian"]);

    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "gate_refused" });
    expect(h.bridge.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a credential sealed for a DIFFERENT row — the AAD binding holds", async () => {
    // A blob copied between connections fails GCM's tag check, and the attach
    // path reports a missing credential rather than reaching Atlassian with
    // nothing and collecting an opaque 401.
    const row = {
      ...connect(GOOD_SUBMISSION),
      providerTokensEnc: sealSaasCredentials("conn_some_other_row", {
        apiToken: FAKE_API_TOKEN,
      }),
    };
    const h = stack(row, ["atlassian"]);

    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "credential_incomplete" });
    expect(h.bridge.fetchImpl).not.toHaveBeenCalled();
  });

  it("stays empty-by-default: a CONNECTED row alone attaches nothing", async () => {
    // The allowlist is the operator's opt-in and it is still empty on a box
    // nobody configured, however good the credential is.
    const h = stack(connect(GOOD_SUBMISSION), []);

    const result = await h.attach();
    expect(result).toMatchObject({ attached: false, reason: "not_allowlisted" });
    expect(h.bridge.fetchImpl).not.toHaveBeenCalled();
    expect(h.prisma.integrationConnection.findFirst).not.toHaveBeenCalled();
  });
});
