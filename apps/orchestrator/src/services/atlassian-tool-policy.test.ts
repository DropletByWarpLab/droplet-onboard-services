/**
 * WARP-2360 / WARP-2346 — the classification table and the policy it drives.
 *
 * Nothing here dials. The table is data; the policy is a pure function over it.
 *
 * The two assertions worth reading first are the ABSENCE tests: that
 * `updateConfluencePage` is not in the allowed set (WARP-2346, shaped after
 * `storage-pool-tools.test.ts`), and that an unclassified name is refused
 * rather than passed through.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ATLASSIAN_DENY_CODES,
  ATLASSIAN_PRODUCT_AUTH_MODES,
  ATLASSIAN_SERVER_ID,
  ATLASSIAN_TOOL_CLASSIFICATIONS,
  ATLASSIAN_TOOL_INDEX,
  ATLASSIAN_V1_READ_TOOLS,
  CONFLUENCE_UPDATE_TOOL,
  classifyAtlassianCall,
  classifyAtlassianRow,
  createAtlassianRemoteCallPolicy,
  v1ReadToolsOf,
  type AtlassianAuthMode,
} from "./atlassian-tool-policy.js";
import { namespacedToolName, DENY_ALL_REMOTE_TOOLS } from "./mcp-multiplexer.service.js";

const API_TOKEN: AtlassianAuthMode = "api-token";

function decide(wireName: string, authMode: AtlassianAuthMode = API_TOKEN) {
  return classifyAtlassianCall(
    wireName,
    namespacedToolName(ATLASSIAN_SERVER_ID, wireName),
    authMode,
  );
}

describe("the table itself", () => {
  it("uses the server id the bridge namespaces under", () => {
    // Both halves assert the same literal; see the constant's comment for why
    // it is not imported across the ADR-043 §5 boundary.
    expect(ATLASSIAN_SERVER_ID).toBe("atlassian");
  });

  it("has no duplicate rows", () => {
    const names = ATLASSIAN_TOOL_CLASSIFICATIONS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every non-allowed row a note saying WHY", () => {
    // A refusal with no recorded reason is a refusal the next maintainer will
    // "fix" by deleting.
    for (const row of ATLASSIAN_TOOL_CLASSIFICATIONS) {
      if (row.v1 === "allowed") continue;
      expect(row.note, `${row.name} is not allowed and carries no note`).toBeTruthy();
    }
  });

  it("declares an auth mode for every product it classifies a tool under", () => {
    for (const row of ATLASSIAN_TOOL_CLASSIFICATIONS) {
      expect(ATLASSIAN_PRODUCT_AUTH_MODES[row.product].length).toBeGreaterThan(0);
    }
  });

  it("encodes the matrix the story states: JSM and Bitbucket API-token only, Compass OAuth only", () => {
    expect(ATLASSIAN_PRODUCT_AUTH_MODES.jsm).toEqual(["api-token"]);
    expect(ATLASSIAN_PRODUCT_AUTH_MODES.bitbucket).toEqual(["api-token"]);
    expect(ATLASSIAN_PRODUCT_AUTH_MODES.compass).toEqual(["oauth"]);
    expect(ATLASSIAN_PRODUCT_AUTH_MODES.jira).toEqual(["api-token", "oauth"]);
    expect(ATLASSIAN_PRODUCT_AUTH_MODES.confluence).toEqual(["api-token", "oauth"]);
  });

  it("enumerates no JSM or Bitbucket tool — the hole is deliberate and denied", () => {
    // We have no API-token credential to enumerate them with, and inventing
    // names would put fiction in a security artefact. Absent means denied.
    const products = new Set(ATLASSIAN_TOOL_CLASSIFICATIONS.map((t) => t.product));
    expect(products.has("jsm")).toBe(false);
    expect(products.has("bitbucket")).toBe(false);
  });

  it("derives the v1 read list from the table rather than repeating it", () => {
    const expected = ATLASSIAN_TOOL_CLASSIFICATIONS.filter(
      (t) => t.grade === "read" && t.v1 === "allowed",
    ).map((t) => t.name);
    expect([...ATLASSIAN_V1_READ_TOOLS].sort()).toEqual(expected.sort());
  });

  it("allows NO write or destructive tool in v1", () => {
    for (const row of ATLASSIAN_TOOL_CLASSIFICATIONS) {
      if (row.grade === "read") continue;
      expect(ATLASSIAN_V1_READ_TOOLS.has(row.name)).toBe(false);
    }
  });

  /**
   * The two assertions above are BOTH vacuous on today's table: no shipped row
   * is `v1: "allowed"` with a non-read grade, so dropping the `grade === "read"`
   * condition from the derivation produces the identical set and neither test
   * notices. A mutation proved it — it survived until these two were added.
   *
   * The case that needs pinning is the one a future EDIT introduces, so both
   * layers are exercised against a row the table does not contain.
   */
  describe("a write row mis-marked as allowed is still refused, twice over", () => {
    const misMarked = {
      name: "createJiraIssue",
      product: "jira",
      grade: "write",
      v1: "allowed",
      note: "synthetic fixture — a field edited by mistake",
    } as const;

    it("layer 1 — the derivation drops it, because grade is checked too", () => {
      expect(v1ReadToolsOf([misMarked]).has("createJiraIssue")).toBe(false);
    });

    it("layer 2 — dispatch refuses it as a write, whatever v1 says", () => {
      expect(
        classifyAtlassianRow(misMarked, "atlassian__createJiraIssue", API_TOKEN),
      ).toMatchObject({ kind: "deny", code: ATLASSIAN_DENY_CODES.writeBlocked });
    });

    it("the derivation still admits a genuine read row, so it is not just refusing everything", () => {
      const genuine = {
        name: "getJiraIssue",
        product: "jira",
        grade: "read",
        v1: "allowed",
      } as const;
      expect(v1ReadToolsOf([genuine]).has("getJiraIssue")).toBe(true);
    });
  });

  /**
   * The OTHER direction, and the one that was actually broken.
   *
   * `classifyAtlassianRow` refused `v1: "excluded"` and any non-read grade, and
   * nothing else — so the `blocked-write` disposition was ignored for a row
   * whose grade says `read`. The enforcement path never consulted
   * `ATLASSIAN_V1_READ_TOOLS` or `v1ReadToolsOf` at all; both were reachable
   * only from tests and `atlassian-tool-snapshot.ts`, while this file's own
   * docstrings claimed the read set was "the ONLY names
   * `createAtlassianRemoteCallPolicy` will allow" and that the grade check was
   * "the second of two independent layers". Neither was true.
   *
   * A row a future maintainer marks `{grade: "read", v1: "blocked-write"}` —
   * say a Jira tool whose read is fine in principle but is held back pending
   * WARP-2321 — was DISPATCHED TO THE VENDOR while
   * `docs/security/atlassian-mcp-tool-surface.json`, the reviewed security
   * artefact, said it was not.
   */
  describe("a read row the operator held back is refused (WARP-2300)", () => {
    const heldBack = {
      name: "getJiraIssue",
      product: "jira",
      grade: "read",
      v1: "blocked-write",
      note: "synthetic fixture — a read an operator deliberately held back",
    } as const;

    it("the derivation drops it, because the disposition is checked too", () => {
      expect(v1ReadToolsOf([heldBack]).has("getJiraIssue")).toBe(false);
    });

    it("dispatch refuses it — the disposition is enforced, not merely recorded", () => {
      expect(
        classifyAtlassianRow(heldBack, "atlassian__getJiraIssue", API_TOKEN),
      ).toMatchObject({ kind: "deny", code: ATLASSIAN_DENY_CODES.writeBlocked });
    });

    it("an excluded read row keeps its OWN code, so the two remedies stay apart", () => {
      const excludedRead = { ...heldBack, v1: "excluded" } as const;
      expect(
        classifyAtlassianRow(excludedRead, "atlassian__getJiraIssue", API_TOKEN),
      ).toMatchObject({ kind: "deny", code: ATLASSIAN_DENY_CODES.excluded });
    });

    it("fails CLOSED on a disposition nobody has taught it about yet", () => {
      // A fourth `AtlassianV1Disposition` added without touching the
      // enforcement switch must deny, not fall through to allow.
      const future = { ...heldBack, v1: "quarantined" } as unknown as
        (typeof ATLASSIAN_TOOL_CLASSIFICATIONS)[number];
      expect(
        classifyAtlassianRow(future, "atlassian__getJiraIssue", API_TOKEN),
      ).toMatchObject({ kind: "deny" });
    });
  });

  /**
   * The binding assertion: the set the security artefact is derived from and
   * the set dispatch actually allows are THE SAME SET.
   *
   * This is what makes the two stay in step without an operator reading both.
   * It runs over the shipped table in both auth modes, so no row can be
   * callable-but-undocumented or documented-but-refused.
   */
  it("allows exactly ATLASSIAN_V1_READ_TOOLS, on the reachable auth mode, and nothing else", () => {
    for (const row of ATLASSIAN_TOOL_CLASSIFICATIONS) {
      for (const authMode of ["api-token", "oauth"] as const) {
        const reachable = ATLASSIAN_PRODUCT_AUTH_MODES[row.product].includes(authMode);
        const decision = classifyAtlassianRow(row, `atlassian__${row.name}`, authMode);
        const shouldAllow = reachable && ATLASSIAN_V1_READ_TOOLS.has(row.name);
        expect(
          decision.kind === "allow",
          `${row.name} (${authMode}): dispatch says ${decision.kind}, the read set says ${shouldAllow}`,
        ).toBe(shouldAllow);
      }
    }
  });
});

describe("WARP-2346 — updateConfluencePage is excluded from v1", () => {
  it("is ABSENT from the allowed set — the guarantee is implemented by absence", () => {
    // Same shape as storage-pool-tools.test.ts: the property is that the name
    // is not in the callable set, not that some branch happens to refuse it.
    expect(ATLASSIAN_V1_READ_TOOLS.has(CONFLUENCE_UPDATE_TOOL)).toBe(false);
  });

  it("is classified destructive, and says why", () => {
    const row = ATLASSIAN_TOOL_INDEX.get(CONFLUENCE_UPDATE_TOOL);
    expect(row?.grade).toBe("destructive");
    expect(row?.v1).toBe("excluded");
    expect(row?.note).toContain("WHOLE-BODY REPLACEMENT");
  });

  it("is refused with its OWN code, not as a generic write", () => {
    // An operator reading "writes are blocked" would expect it back once the
    // deny tier ships. This one does not come back on that event.
    const decision = decide(CONFLUENCE_UPDATE_TOOL);
    expect(decision).toMatchObject({
      kind: "deny",
      code: ATLASSIAN_DENY_CODES.excluded,
    });
    expect(decision.kind === "deny" && decision.message).toContain("Do not retry");
  });

  it("does not accidentally exclude the Jira field-level edit alongside it", () => {
    // editJiraIssue updates named fields; it is a write, not a page-eating
    // replacement, and conflating the two would over-block.
    expect(ATLASSIAN_TOOL_INDEX.get("editJiraIssue")?.grade).toBe("write");
  });
});

describe("the policy", () => {
  const policy = createAtlassianRemoteCallPolicy({ authMode: API_TOKEN });

  function call(wireName: string, serverId = ATLASSIAN_SERVER_ID) {
    return policy({
      serverId,
      wireName,
      namespacedName: namespacedToolName(serverId, wireName),
      args: {},
    });
  }

  it("allows a classified read", () => {
    expect(call("getJiraIssue")).toEqual({ kind: "allow" });
    expect(call("searchJiraIssuesUsingJql")).toEqual({ kind: "allow" });
  });

  it("denies a classified write with the ADR-043 §3 code", () => {
    expect(call("createJiraIssue")).toMatchObject({
      kind: "deny",
      code: ATLASSIAN_DENY_CODES.writeBlocked,
    });
  });

  it("denies an UNCLASSIFIED name fail-closed", () => {
    // Covers a hallucinated name, a tool Atlassian shipped after this table was
    // recorded, and every JSM/Bitbucket tool.
    expect(call("deleteEverything")).toMatchObject({
      kind: "deny",
      code: ATLASSIAN_DENY_CODES.notClassified,
    });
  });

  it("tells the model not to retry, in every refusal", () => {
    for (const name of ["createJiraIssue", "deleteEverything", CONFLUENCE_UPDATE_TOOL]) {
      const d = call(name);
      expect(d.kind).toBe("deny");
      expect(d.kind === "deny" && d.message.toLowerCase()).toContain("do not retry");
    }
  });

  it("speaks only for its own server — another server falls through", () => {
    const fallback = vi.fn(() => ({ kind: "deny" as const, code: "OTHER", message: "no" }));
    const scoped = createAtlassianRemoteCallPolicy({ authMode: API_TOKEN, fallback });
    const decision = scoped({
      serverId: "slack",
      // Deliberately a name Atlassian DOES classify as a read: if the server id
      // were ignored, this would come back `allow` and a second vendor's tool
      // would inherit Atlassian's clearance.
      wireName: "getJiraIssue",
      namespacedName: "slack__getJiraIssue",
      args: {},
    });
    expect(decision).toMatchObject({ kind: "deny", code: "OTHER" });
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("defaults an unknown server to deny, with no fallback supplied", () => {
    expect(call("getJiraIssue", "slack")).toMatchObject({
      kind: "deny",
      code: ATLASSIAN_DENY_CODES.notClassified,
    });
  });

  it("is strictly narrower than the shipping deny-all default", () => {
    // Everything DENY_ALL_REMOTE_TOOLS denies for a non-Atlassian server, this
    // policy denies too — installing it may only widen Atlassian reads.
    const input = {
      serverId: "somewhere",
      wireName: "anything",
      namespacedName: "somewhere__anything",
      args: {},
    };
    expect(DENY_ALL_REMOTE_TOOLS(input).kind).toBe("deny");
    expect(policy(input).kind).toBe("deny");
  });
});

describe("the auth-mode matrix produces a typed refusal, never an empty result", () => {
  it("refuses a Compass tool on an API-token connection", () => {
    const decision = decide("getCompassComponents", "api-token");
    expect(decision).toMatchObject({
      kind: "deny",
      code: ATLASSIAN_DENY_CODES.authMode,
    });
    expect(decision.kind === "deny" && decision.message).toContain(
      "do not report the result as empty",
    );
  });

  it("allows the same Compass tool on an OAuth connection", () => {
    expect(decide("getCompassComponents", "oauth")).toEqual({ kind: "allow" });
  });

  it("checks the auth mode BEFORE the grade, so the reason is the true one", () => {
    // createCompassComponent is both a write AND unreachable on api-token.
    // Reporting "writes are blocked" would send the operator to the wrong fix.
    expect(decide("createCompassComponent", "api-token")).toMatchObject({
      code: ATLASSIAN_DENY_CODES.authMode,
    });
    expect(decide("createCompassComponent", "oauth")).toMatchObject({
      code: ATLASSIAN_DENY_CODES.writeBlocked,
    });
  });

  it("names the product, so the message says which credential is needed", () => {
    const d = decide("getCompassComponent", "api-token");
    expect(d.kind === "deny" && d.message).toContain("compass");
    expect(d.kind === "deny" && d.message).toContain("api-token");
  });
});
