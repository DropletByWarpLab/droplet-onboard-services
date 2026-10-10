/**
 * WARP-2627 — ADR-043 §5 as an assertion, plus the drift gate on the wire
 * contract that assertion forces us to duplicate.
 *
 * ## The §5 tripwire
 *
 * ADR-043 §5 names it verbatim: *"a reviewer who sees
 * `StreamableHTTPClientTransport` or `SSEClientTransport` land in orchestrator
 * product code should treat it as a breach of this ADR."* Before WARP-2627 that
 * was a review instruction. Now the bridge exists, so it can be a test.
 *
 * SCOPE, stated precisely, because two nearby things are NOT breaches:
 *
 *   - `StdioClientTransport` (`mcp-client.service.ts`) is the LOCAL child
 *     process — in-process trusted, and §5's rule is about a session to a
 *     server we do not own.
 *   - `services/mcp-server/__tests__/http-roundtrip.test.ts` dials the box's
 *     OWN inbound MCP server over Streamable HTTP. It is a test, and its
 *     counterparty is us.
 *
 * So the gate is: a REMOTE client transport (`client/streamableHttp`,
 * `client/sse`) in PRODUCT code, anywhere but `services/mcp-bridge`.
 *
 * ## The wire-contract drift gate
 *
 * `mcp-bridge.client.ts` re-declares the bridge's session states and error
 * codes, and `remote-mcp-servers.ts` re-declares its server id, because
 * importing `@droplet/mcp-bridge` would drag exactly the transport above into
 * this workspace's module graph. That duplication is deliberate; leaving it
 * UNCHECKED would not be. These tests read the bridge's own source as text —
 * no import, so the tripwire above stays a grep — and fail when either side
 * moves.
 *
 * ## The per-server declarations gate (WARP-3703, ADR-043 TC-1.4)
 *
 * A server id, and what a session for it is opened with, is declared in several
 * places that can drift independently: the provider descriptor (`id`,
 * `mcpServerId` and its required `credentialFields`), the bridge's closed profile
 * registry (the id and the fields its `open` demands), and this process's
 * operator-domain map. The last two of those are what a second vendor's data PR
 * adds to. So the gate iterates EVERY provider on the mcp track instead of naming
 * Atlassian, and a vendor that forgets one declaration turns it red here rather
 * than at a customer's first connect.
 *
 * The bridge's registry is loaded by a computed path — the way
 * `remote-mcp-reconciler.bridge-contract.test.ts` loads its router — because it
 * is the ground truth and a regex over a TypeScript object literal would only
 * model it. That keeps the bridge out of `tsc`'s graph, and a TEST importing it
 * is outside the §5 rule, which greps PRODUCT code.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  mcpProviderIds,
  providerDescriptor,
  type ProviderDescriptor,
} from "@droplet/shared-types";
import { REMOTE_MCP_SESSION_STATES, BRIDGE_ERROR_CODES } from "./mcp-bridge.client.js";
import {
  ATLASSIAN_REMOTE_SERVER_ID,
  REMOTE_SERVER_DOMAINS,
  remoteServerDomain,
} from "./remote-mcp-servers.js";
import { ATLASSIAN_SERVER_ID } from "./atlassian-tool-policy.js";
import { REMOTE_TOOL_TABLES, REMOTE_TOOL_TABLE_DEFS } from "./remote-tool-tables.js";
import { REPO_ROOT } from "../__tests__/helpers/test-paths.js";

// Anchored to this test file, not to `process.cwd()` (WARP-2654).
const ROOT = REPO_ROOT;
const BRIDGE_SRC = join(ROOT, "services", "mcp-bridge", "src");

function read(...parts: string[]): string {
  return readFileSync(join(...parts), "utf8");
}

/** Every product `.ts`/`.tsx` under a workspace's source root. Tests and
 *  `dist` are excluded — the rule is about product code. */
function productSources(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      productSources(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

const REMOTE_TRANSPORT = /@modelcontextprotocol\/sdk\/client\/(streamableHttp|sse)/;

describe("ADR-043 §5 — the orchestrator holds no outbound MCP socket", () => {
  it("no product file outside services/mcp-bridge imports a REMOTE client transport", () => {
    const roots = [
      join(ROOT, "apps", "orchestrator", "src"),
      join(ROOT, "apps", "web-dashboard"),
      join(ROOT, "packages", "tools-core", "src"),
      join(ROOT, "packages", "shared-types", "src"),
      join(ROOT, "services", "mcp-server", "src"),
      join(ROOT, "services", "erp-connector", "src"),
      join(ROOT, "services", "matter-controller", "src"),
    ];
    const offenders = roots
      .flatMap((r) => productSources(r))
      .filter((f) => REMOTE_TRANSPORT.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1).replace(/\\/g, "/"));
    expect(offenders).toEqual([]);
  });

  it("the ONE permitted importer is the bridge's single transport module", () => {
    const importers = productSources(BRIDGE_SRC)
      .filter((f) => REMOTE_TRANSPORT.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1).replace(/\\/g, "/"));
    // Exactly one, so "keep the SDK import to one file" stays a fact rather
    // than an intention. A second one here is a real finding, not noise.
    expect(importers).toEqual(["services/mcp-bridge/src/streamable-http.ts"]);
  });

  it("the orchestrator does not depend on @droplet/mcp-bridge", () => {
    const pkg = JSON.parse(read(ROOT, "apps", "orchestrator", "package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("@droplet/mcp-bridge");
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain("@droplet/mcp-bridge");
  });
});

/** Pull the quoted string literals out of one declaration block. */
function literalsIn(source: string, startMarker: string, endMarker: string): string[] {
  const from = source.indexOf(startMarker);
  expect(from, `"${startMarker}" not found in the bridge's source`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(endMarker, from);
  expect(to, `"${endMarker}" not found after "${startMarker}"`).toBeGreaterThan(from);
  const block = source.slice(from, to);
  return [...block.matchAll(/"([a-z_][a-z0-9_]*)"/gi)].map((m) => m[1]!);
}

describe("wire-contract drift gate (the duplication §5 forces)", () => {
  it("the session-state vocabulary matches the bridge's", () => {
    const bridge = literalsIn(
      read(BRIDGE_SRC, "session-state.ts"),
      "export const REMOTE_MCP_SESSION_STATES",
      "] as const;",
    );
    expect([...REMOTE_MCP_SESSION_STATES]).toEqual(bridge);
  });

  it("the error-code vocabulary matches the bridge's", () => {
    const bridge = literalsIn(
      read(BRIDGE_SRC, "http-api.ts"),
      "export type BridgeErrorCode =",
      ";\n",
    );
    expect([...BRIDGE_ERROR_CODES]).toEqual(bridge);
  });

  it("the orchestrator's own Atlassian constants agree with the bridge's literal", () => {
    // `services/mcp-bridge/src/atlassian.ts` (the wire path segment),
    // `remote-mcp-servers.ts` (what this process attaches) and
    // `atlassian-tool-policy.ts` (the classification table's scope) each carry
    // the literal, because the bridge may not be imported by the orchestrator
    // (ADR-043 §5) and the policy table is orchestrator-owned by ADR-043 §2.
    // This is what stops them drifting silently into an empty tool list. The
    // provider descriptor's copy, and the registry the bridge serves it from,
    // are gated for EVERY mcp server in the next block.
    const bridgeSource = read(BRIDGE_SRC, "atlassian.ts");
    const match = /export const ATLASSIAN_SERVER_ID = "([a-z0-9-]+)";/.exec(bridgeSource);
    expect(match, "ATLASSIAN_SERVER_ID literal not found in the bridge").not.toBeNull();
    expect(ATLASSIAN_REMOTE_SERVER_ID).toBe(match![1]);
    expect(ATLASSIAN_SERVER_ID).toBe(match![1]);
  });

  it("every path this client calls is a route the bridge serves", () => {
    const api = read(BRIDGE_SRC, "http-api.ts");
    const client = read(ROOT, "apps", "orchestrator", "src", "services", "mcp-bridge.client.ts");
    // The actions the client builds into `/sessions/${serverId}/<action>`.
    const actions = [...client.matchAll(/\/sessions\/\$\{this\.serverId\}\/([a-z-]+)/g)].map(
      (m) => m[1]!,
    );
    // `call` twice (the base session and `callToolFor` on a per-connection one) and
    // `close` (one connection's session), WARP-2409.
    expect(actions.sort()).toEqual(["acknowledge-catalog", "call", "call", "close", "open", "state", "tools"]);
    for (const action of actions) {
      expect(api, `bridge has no "${action}" route`).toContain(`case "${action}":`);
    }
  });
});

// ===========================================================================
// WARP-3703 (ADR-043 TC-1.4) — every MCP server, declared consistently
// ===========================================================================

/** What the bridge's registry says about one server — only what is gated here. */
interface BridgeProfile {
  readonly requiredFields: readonly string[];
  /** WARP-2409 - the accepted open bodies when the server also takes a sign-in: the
   *  API-token set, and a bearer set. Absent means `[requiredFields]`. */
  readonly requiredFieldSets?: readonly (readonly string[])[];
}

/** Everything one server id is declared as, in the places that can drift. */
interface DeclaredServer {
  descriptor: ProviderDescriptor | undefined;
  profile: BridgeProfile | undefined;
  domain: string | undefined;
}

/**
 * Every way one server's declarations disagree, as sentences. Empty means they
 * agree.
 *
 * A function that RETURNS the problems rather than asserting, so the test that
 * runs it over every provider on the track and the tests that feed it a
 * declaration built to be wrong are the same code: a check nobody has seen fail
 * is a check nobody knows is live.
 */
function declarationProblems(id: string, declared: DeclaredServer): string[] {
  const out: string[] = [];
  const { descriptor, profile, domain } = declared;

  if (!descriptor) {
    out.push(`no provider descriptor for "${id}"`);
  } else {
    if (descriptor.track !== "mcp") {
      out.push(`the descriptor is on the "${descriptor.track}" track, not "mcp"`);
    } else if (descriptor.mcpServerId !== id) {
      // Narrowed rather than cast: only the `mcp` arm carries `mcpServerId`, so
      // this cannot survive the track being changed out from under it.
      out.push(`descriptor.mcpServerId is "${descriptor.mcpServerId}", not "${id}"`);
    }
    // The id the gate reads is the PROVIDER key on the row, which the credential
    // route writes from `descriptor.id` — `remoteMcpGate` looks the row up with
    // `provider: serverId`. `mcpServerId` and `id` are free to differ in the
    // type, and a divergence here means the operator connects an account under
    // one id and the gate looks for a row under another, which reads as "no
    // account connected" with a perfectly good credential in the database. It is
    // also why a vendor that already has a REST descriptor needs its OWN id for
    // the MCP one: the REST connection's row would otherwise be the one opened.
    if (descriptor.id !== id) out.push(`descriptor.id is "${descriptor.id}", not "${id}"`);

    // What the attach path reads and what the bridge's `open` demands are the two
    // halves of one wire contract, declared in two places because the bridge
    // cannot be imported across the §5 line. A mismatch would present as "could
    // not open a session", which sends an operator to the bridge.
    const required = descriptor.credentialFields.filter((f) => f.required);
    const declaredNames = new Set(descriptor.credentialFields.map((f) => f.name));
    const signsIn = descriptor.track === "mcp" && descriptor.signIn !== undefined;
    if (profile && !signsIn) {
      const wanted = required.map((f) => f.name).sort();
      const served = [...profile.requiredFields].sort();
      if (wanted.join(",") !== served.join(",")) {
        out.push(
          `the descriptor's required fields are [${wanted.join(", ")}] but the bridge's open ` +
            `demands [${served.join(", ")}]`,
        );
      }
    }
    if (profile && signsIn) {
      // WARP-2409 - with web sign-in the credential fields are alternatives: the API
      // token path (email + apiToken + site) OR a sign-in (bearer + site). So the
      // descriptor requires only what EVERY path needs, and the bridge accepts
      // exactly its field sets: each descriptor-required field is in every set, and
      // one set is entirely descriptor fields (the API-token path a form can fill).
      const sets = profile.requiredFieldSets ?? [profile.requiredFields];
      for (const f of required) {
        for (const set of sets) {
          if (!set.includes(f.name)) {
            out.push(`required field "${f.name}" is missing from the bridge's open set [${[...set].sort().join(", ")}]`);
          }
        }
      }
      if (!sets.some((set) => set.every((n) => declaredNames.has(n)))) {
        out.push("no bridge open set is made only of descriptor credential fields, so the API-token path cannot be filled in");
      }
      for (const set of sets) {
        const outside = set.filter((n) => !declaredNames.has(n));
        if (outside.length > 1) out.push(`a bridge open set names fields no sign-in supplies: [${outside.join(", ")}]`);
      }
    }
    // The attach path reads two homes and a string from each; a required field
    // it cannot read is one a customer could fill in and the box would never use.
    for (const f of required) {
      if (f.type !== "string") out.push(`required field "${f.name}" is a "${f.type}", not a string`);
      if (f.storage !== "encrypted" && f.storage !== "providerConfig") {
        out.push(
          `required field "${f.name}" is stored as "${f.storage}", a home the attach path cannot read`,
        );
      }
    }
    // With a sign-in the secret fields are optional (the API-token path), so the
    // sealed secret is looked for among every declared field.
    if (!(signsIn ? descriptor.credentialFields : required).some((f) => f.secret && f.storage === "encrypted")) {
      out.push("no required field is a sealed secret — a vendor credential is one");
    }
    for (const f of descriptor.credentialFields) {
      if (f.secret && f.storage !== "encrypted") {
        out.push(`secret field "${f.name}" is not stored encrypted (rule 19)`);
      }
    }
  }

  if (!profile) out.push(`the bridge's registry has no profile for "${id}"`);
  if (domain === undefined) out.push(`REMOTE_SERVER_DOMAINS has no operator domain for "${id}"`);
  return out;
}

const own = (record: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

describe("every MCP server is declared consistently everywhere it is declared (TC-1.4)", () => {
  let bridgeProfiles: Readonly<Record<string, BridgeProfile>>;

  beforeAll(async () => {
    // A computed specifier: `tsc` sees `Promise<any>` and resolves nothing, which
    // is the point (see the header). vitest resolves it at run time.
    const mod = (await import(pathToFileURL(join(BRIDGE_SRC, "session-profiles.ts")).href)) as {
      SESSION_PROFILES: Readonly<Record<string, BridgeProfile>>;
    };
    bridgeProfiles = mod.SESSION_PROFILES;
  });

  const declared = (id: string): DeclaredServer => ({
    descriptor: providerDescriptor(id),
    profile: own(bridgeProfiles, id) ? bridgeProfiles[id] : undefined,
    domain: remoteServerDomain(id),
  });

  it("agrees across the descriptor, the bridge's registry and contract, and the operator domain — for EVERY provider on the track", () => {
    const ids = mcpProviderIds();
    expect(ids.length, "no provider is registered on the mcp track").toBeGreaterThan(0);
    for (const id of ids) {
      expect(declarationProblems(id, declared(id)), id).toEqual([]);
    }
  });

  it("serves no server nobody can connect: every id the bridge's registry holds is a provider on the track", () => {
    const providers = new Set(mcpProviderIds());
    for (const id of Object.keys(bridgeProfiles)) {
      expect(providers.has(id), `the bridge serves "${id}" and no provider declares it`).toBe(true);
    }
  });

  it("declares no operator domain and no compiled table for a server that is not a provider on the track", () => {
    const providers = new Set(mcpProviderIds());
    for (const id of Object.keys(REMOTE_SERVER_DOMAINS)) {
      expect(providers.has(id), `REMOTE_SERVER_DOMAINS names "${id}", which is not an mcp provider`).toBe(true);
    }
    for (const id of Object.keys(REMOTE_TOOL_TABLES)) {
      expect(providers.has(id), `a classification table speaks for "${id}", which is not an mcp provider`).toBe(true);
    }
    for (const def of REMOTE_TOOL_TABLE_DEFS) {
      expect(providers.has(def.serverId), `${def.serverId} has a table and no provider`).toBe(true);
    }
  });

  /**
   * The gate has to be seen to fail, or "agrees for every provider" is a claim
   * and not a check. Each case below is a declaration built from the shipped
   * Atlassian one with exactly one thing wrong.
   */
  describe("the gate itself can go red", () => {
    const base = (): DeclaredServer & { descriptor: ProviderDescriptor; profile: BridgeProfile } => {
      const descriptor = providerDescriptor("atlassian");
      if (!descriptor) throw new Error("the atlassian descriptor is not registered");
      return { descriptor, profile: bridgeProfiles.atlassian!, domain: "pm" };
    };
    const withFields = (fields: ProviderDescriptor["credentialFields"]): ProviderDescriptor => ({
      ...base().descriptor,
      credentialFields: fields,
    });

    it("is clean for the shipped Atlassian declarations", () => {
      expect(declarationProblems("atlassian", base())).toEqual([]);
    });

    it("is red when the descriptor's mcpServerId is not the id", () => {
      const d = { ...base().descriptor, mcpServerId: "atlassian-x" } as ProviderDescriptor;
      expect(declarationProblems("atlassian", { ...base(), descriptor: d }).join("\n")).toMatch(
        /mcpServerId is "atlassian-x"/,
      );
    });

    it("is red when the descriptor's PROVIDER id is not the id — the row would be written under one key and read under another", () => {
      const d = { ...base().descriptor, id: "atlassian-mcp" } as ProviderDescriptor;
      expect(declarationProblems("atlassian", { ...base(), descriptor: d }).join("\n")).toMatch(
        /descriptor\.id is "atlassian-mcp"/,
      );
    });

    it("is red when the provider is not on the mcp track", () => {
      const d = { ...base().descriptor, track: "cloud" } as unknown as ProviderDescriptor;
      expect(declarationProblems("atlassian", { ...base(), descriptor: d }).join("\n")).toMatch(/track/);
    });

    it("is red when there is no descriptor, no bridge profile or no operator domain", () => {
      expect(declarationProblems("atlassian", { ...base(), descriptor: undefined }).join("\n")).toMatch(
        /no provider descriptor/,
      );
      expect(declarationProblems("atlassian", { ...base(), profile: undefined }).join("\n")).toMatch(
        /no profile/,
      );
      expect(declarationProblems("atlassian", { ...base(), domain: undefined }).join("\n")).toMatch(
        /no operator domain/,
      );
    });

    // A server with no web sign-in: its credential fields are all required, and the
    // bridge's single open set must equal them exactly.
    const legacy = (): ProviderDescriptor =>
      ({
        ...base().descriptor,
        signIn: undefined,
        credentialFields: base().descriptor.credentialFields.map((f) =>
          ["email", "apiToken", "cloudId"].includes(f.name) ? { ...f, required: true } : f,
        ),
      }) as ProviderDescriptor;

    it("is red when the bridge demands different fields than the descriptor requires", () => {
      const wrongNames = { requiredFields: ["email", "apiKey", "cloudId"] };
      expect(declarationProblems("atlassian", { ...base(), descriptor: legacy(), profile: wrongNames }).join("\n")).toMatch(
        /required fields are \[apiToken, cloudId, email\] but the bridge's open demands \[apiKey, cloudId, email\]/,
      );
      const fewer = { requiredFields: ["apiToken"] };
      expect(declarationProblems("atlassian", { ...base(), descriptor: legacy(), profile: fewer }).join("\n")).toMatch(
        /bridge's open demands \[apiToken\]/,
      );
    });

    it("with a sign-in, the descriptor requires only what every path needs, and the bridge accepts exactly its sets", () => {
      // The API-token path and the bearer path both need the site id.
      const noSite = { ...base().profile, requiredFieldSets: [["email", "apiToken", "cloudId"], ["accessToken"]] };
      expect(declarationProblems("atlassian", { ...base(), profile: noSite }).join("\n")).toMatch(
        /required field "cloudId" is missing from the bridge's open set \[accessToken\]/,
      );
      // A descriptor that requires the API-token fields would block sign-in-only boxes.
      const strict = withFields(base().descriptor.credentialFields.map((f) => ({ ...f, required: true })));
      expect(declarationProblems("atlassian", { ...base(), descriptor: strict }).join("\n")).toMatch(
        /required field "email" is missing from the bridge's open set \[accessToken, cloudId\]/,
      );
      // No set a form can fill: the API-token path is gone.
      const onlyBearer = { requiredFields: ["accessToken", "cloudId"], requiredFieldSets: [["accessToken", "cloudId"]] };
      expect(declarationProblems("atlassian", { ...base(), profile: onlyBearer }).join("\n")).toMatch(/API-token path cannot be filled in/);
    });

    it("is red when no required field is a sealed secret, or a secret is stored in the clear", () => {
      const clear = withFields([
        {
          name: "apiToken",
          label: "Token",
          type: "string",
          required: true,
          secret: true,
          storage: "providerConfig",
        },
      ]);
      const problems = declarationProblems("atlassian", {
        ...base(),
        descriptor: clear,
        profile: { requiredFields: ["apiToken"] },
      }).join("\n");
      expect(problems).toMatch(/no required field is a sealed secret/);
      expect(problems).toMatch(/secret field "apiToken" is not stored encrypted/);
    });

    it("is red when a required field is not a string, or lives where the attach path cannot read it", () => {
      const odd = withFields([
        ...base().descriptor.credentialFields,
        {
          name: "callCeiling",
          label: "Ceiling",
          type: "positiveInteger",
          required: true,
          secret: false,
          storage: "column",
        },
      ]);
      const problems = declarationProblems("atlassian", {
        ...base(),
        descriptor: odd,
        profile: { requiredFields: ["apiToken", "callCeiling", "cloudId", "email"] },
      }).join("\n");
      expect(problems).toMatch(/required field "callCeiling" is a "positiveInteger"/);
      expect(problems).toMatch(/required field "callCeiling" is stored as "column"/);
    });
  });
});
