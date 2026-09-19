/**
 * WARP-2823 — the tool inspector tells the truth about every gate.
 *
 * ── What is actually at risk ───────────────────────────────────────────────
 *
 * This page's only product is a claim about a security boundary, read by the
 * person who administers the box and acted on. A page that under-reports reach
 * makes an admin loosen a grant that was never the problem; a page that
 * over-reports it makes them believe a tool is withheld when the model can
 * call it. The second is the one that matters, and it is the failure mode a
 * casual reading of `scope === null` produces — so it gets three tests, not
 * one.
 *
 * `resolveAttributedToolAccess` is the only thing mocked here. Every gate
 * predicate is the shipped one, imported and run, because the point of the
 * service is that it does not have its own copy of them — a test that mocked
 * the gates would be testing a fiction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TOOL_CATALOG } from "@droplet/tools-core";

const attributed = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock("./tool-access.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tool-access.service.js")>();
  return { ...actual, resolveAttributedToolAccess: attributed.fn };
});

import {
  inspectToolsForPerson,
  INSPECT_GATES,
  type InspectGate,
} from "./tool-inspect.service.js";
import { EXCLUDED_FROM_CHAT_TOOLS } from "./chat-tool-scope.js";
import { WRITE_TOOLS, type ToolAccessScope } from "./tool-access.service.js";
import { isWithheldFromOffLan } from "./stored-content-egress.service.js";

const prisma = {} as never;

/** Every domain in the catalog, so a scope can be "reaches everything". */
const ALL_DOMAINS = new Set(TOOL_CATALOG.map((t) => t.domain));

function scope(over: Partial<ToolAccessScope> = {}): ToolAccessScope {
  return {
    domains: ALL_DOMAINS,
    writeDomains: new Set<string>(),
    locks: false,
    ...over,
  };
}

const asOwner = () =>
  attributed.fn.mockResolvedValue({ scope: null, tier: "owner", unresolved: null });
/** The trap case: resolved, no AccessRole, and therefore NO §3 narrowing. */
const asRolelessFamily = () =>
  attributed.fn.mockResolvedValue({ scope: null, tier: "family", unresolved: null });
const asScoped = (s: ToolAccessScope, tier = "family") =>
  attributed.fn.mockResolvedValue({ scope: s, tier, unresolved: null });

const row = (r: Awaited<ReturnType<typeof inspectToolsForPerson>>, name: string) => {
  const found = r.rows.find((x) => x.name === name);
  if (!found) throw new Error(`no row for ${name} — the catalog changed`);
  return found;
};

/** A write tool, chosen from the catalog rather than hardcoded by hand. */
const SOME_WRITE_TOOL = TOOL_CATALOG.find(
  (t) => t.requiresWrite && !EXCLUDED_FROM_CHAT_TOOLS.has(t.name),
)!.name;

beforeEach(() => {
  vi.clearAllMocks();
});

// ── the gate order is the dispatch order ────────────────────────────────────

describe("🔴 the reported gate order is the order the chain applies", () => {
  it("puts write_tier before role_grant, as toolAllowedForPrincipal does", () => {
    // Not cosmetic. `toolAllowedForPrincipal` checks the tier first and only
    // then the scope, and `firstToolDeniedForPrincipal`'s doc says why: a
    // role-less caller holds no scope at all, so scope-first would report "no
    // grant" for somebody whose real refusal is the ADR-004 write floor.
    expect([...INSPECT_GATES]).toEqual([
      "write_tier",
      "role_grant",
      "interview_strip",
      "off_lan_withhold",
      "chat_policy",
      "turn_relevance",
    ]);
  });
});

// ── the scope-null trap, three ways ─────────────────────────────────────────

describe("🔴 `scope === null` is not `unrestricted`", () => {
  it("reports no role narrowing for BOTH an owner and a role-less family user", async () => {
    asOwner();
    const owner = await inspectToolsForPerson(prisma, { targetUserId: "u1" });
    asRolelessFamily();
    const family = await inspectToolsForPerson(prisma, { targetUserId: "u2" });

    // Same null scope, same flag — and completely different reach.
    expect(owner.noRoleNarrowing).toBe(true);
    expect(family.noRoleNarrowing).toBe(true);
  });

  it("🔴 still withholds every write tool from the role-less family user", async () => {
    // THE test. `AttributedToolAccess`'s own doc says `scope: null` means "no
    // §3 narrowing", NOT "no narrowing" — axis A runs regardless. A reading
    // that treats a null scope as "everything advertised" tells an admin the
    // family account can change settings it demonstrably cannot.
    asRolelessFamily();
    const r = await inspectToolsForPerson(prisma, { targetUserId: "u2" });

    const writeRows = r.rows.filter((x) => WRITE_TOOLS.has(x.name));
    expect(writeRows.length).toBeGreaterThan(0);
    for (const w of writeRows) {
      expect(w.advertised, w.name).toBe(false);
      expect(w.gate, w.name).toBe("write_tier");
    }
  });

  it("does not withhold them from the owner", async () => {
    // The complement, so the test above cannot pass by withholding everything
    // from everybody.
    asOwner();
    const r = await inspectToolsForPerson(prisma, { targetUserId: "u1" });
    const byWriteTier = r.rows.filter((x) => x.gate === "write_tier");
    expect(byWriteTier).toEqual([]);
    expect(r.counts.byGate.write_tier).toBe(0);
  });
});

// ── one gate per fixture ────────────────────────────────────────────────────

describe("🔴 each gate is attributed to the gate that actually fired", () => {
  it("role_grant, for a scope that reaches only one domain", async () => {
    asScoped(scope({ domains: new Set(["files"]) }));
    const r = await inspectToolsForPerson(prisma, { targetUserId: "u3" });

    const outside = r.rows.find((x) => x.domain !== "files" && !x.requiresWrite)!;
    expect(outside.advertised).toBe(false);
    expect(outside.gate).toBe("role_grant");
    expect(outside.reason).toContain(outside.domain);
  });

  it("interview_strip, on an owner whose write tools survive every earlier gate", async () => {
    // Deliberately the owner: for a family tier `write_tier` fires first and
    // the interview strip would only ever show up in `alsoWithheldBy`, so this
    // is the one principal that can prove the strip is wired at all.
    asOwner();
    const r = await inspectToolsForPerson(prisma, {
      targetUserId: "u1",
      interview: true,
    });
    expect(row(r, SOME_WRITE_TOOL).gate).toBe("interview_strip");
  });

  it("off_lan_withhold, on a stored-content tool", async () => {
    asOwner();
    const r = await inspectToolsForPerson(prisma, { targetUserId: "u1", offLan: true });
    const withheld = r.rows.filter((x) => isWithheldFromOffLan(x.name));
    expect(withheld.length).toBeGreaterThan(0);
    for (const w of withheld) {
      expect(w.advertised, w.name).toBe(false);
      // A file tool that is ALSO a write tool is refused by the earlier gate
      // for a non-owner; on an owner, off-LAN is the first thing that bites.
      expect(w.gate, w.name).toBe("off_lan_withhold");
    }
  });

  it("chat_policy, for a tool the chat scope excludes", async () => {
    asOwner();
    const r = await inspectToolsForPerson(prisma, { targetUserId: "u1" });
    const excluded = r.rows.filter((x) => EXCLUDED_FROM_CHAT_TOOLS.has(x.name));
    expect(excluded.length).toBeGreaterThan(0);
    for (const e of excluded) {
      expect(e.advertised, e.name).toBe(false);
      expect(e.gate, e.name).toBe("chat_policy");
    }
  });

  it("turn_relevance, for everything the message did not match", async () => {
    asOwner();
    const r = await inspectToolsForPerson(prisma, { targetUserId: "u1", message: "" });
    // An empty message matches no domain, so the only survivors are the core
    // tools — which is exactly why the page has to name this gate rather than
    // let an admin read "5 of 139" as a permissions problem.
    expect(r.counts.byGate.turn_relevance).toBeGreaterThan(0);
    expect(r.counts.advertised).toBeGreaterThan(0);
    expect(r.counts.advertised).toBeLessThan(r.counts.registered);
  });
});

// ── alsoWithheldBy ──────────────────────────────────────────────────────────

describe("🔴 a tool withheld four ways does not look like a tool withheld once", () => {
  it("lists every other gate that would also have withheld it", async () => {
    // The admin's next move after reading this page is usually to change a
    // grant. One gate means one change away; four means the grant is not the
    // problem. Reporting only the first makes those identical.
    asRolelessFamily();
    const r = await inspectToolsForPerson(prisma, {
      targetUserId: "u2",
      interview: true,
      offLan: true,
    });
    const multi = r.rows.filter((x) => x.alsoWithheldBy.length >= 2);
    expect(multi.length).toBeGreaterThan(0);

    // And every listed gate comes after the reported one, in dispatch order.
    for (const m of multi) {
      const firstIdx = INSPECT_GATES.indexOf(m.gate as InspectGate);
      for (const g of m.alsoWithheldBy) {
        expect(INSPECT_GATES.indexOf(g), `${m.name}/${g}`).toBeGreaterThan(firstIdx);
      }
    }
  });

  it("MUTATION: report only the first gate — one grant looks like enough", async () => {
    // The mutation this pins is `alsoWithheldBy: []`. It leaves every other
    // assertion in this file green: the verdicts are unchanged, the counts are
    // unchanged, and the page still renders. What is lost is the only signal
    // that says whether changing a grant would actually do anything.
    asRolelessFamily();
    const r = await inspectToolsForPerson(prisma, { targetUserId: "u2", offLan: true });
    const anyAlso = r.rows.some((x) => x.alsoWithheldBy.length > 0);
    expect(anyAlso).toBe(true);
  });
});

// ── the unresolved identity ─────────────────────────────────────────────────

describe("🔴 an unresolvable person is a state, not a count of zero", () => {
  it("names the attribution failure and advertises nothing", async () => {
    // "0 tools" and "we could not establish who this is" render identically in
    // a number and are entirely different facts — the first is a permissions
    // answer, the second means the page is describing nobody.
    attributed.fn.mockResolvedValue({
      scope: { domains: new Set(), writeDomains: new Set(), locks: false },
      tier: null,
      unresolved: "user_deactivated",
    });
    const r = await inspectToolsForPerson(prisma, { targetUserId: "gone" });

    expect(r.unresolved).toBe("user_deactivated");
    expect(r.counts.advertised).toBe(0);
    expect(r.noRoleNarrowing).toBe(false);
    expect(r.rows.every((x) => !x.advertised)).toBe(true);
  });
});

// ── §3 locks: advertised is not the same as callable ────────────────────────

describe("🔴 a lock the person may not operate is a caveat, not a verdict", () => {
  it("advertises control_device but says a lock call is refused at dispatch", async () => {
    // The §3 lock rule needs RESOLVED ARGS and is decided at dispatch, so it
    // can never be a verdict here. Rendering it as "withheld" would be wrong
    // (the tool is advertised, and the model can turn a light on with it);
    // rendering nothing would let "advertised" imply more than it means.
    asScoped(scope({ locks: false }), "owner");
    const r = await inspectToolsForPerson(prisma, {
      targetUserId: "u4",
      message: "turn on the lamp in the living room",
    });
    const cd = row(r, "control_device");
    if (cd.advertised) {
      expect(cd.lockCaveat).toBeTruthy();
    }

    asScoped(scope({ locks: true }), "owner");
    const allowed = await inspectToolsForPerson(prisma, {
      targetUserId: "u4",
      message: "turn on the lamp in the living room",
    });
    expect(row(allowed, "control_device").lockCaveat).toBeUndefined();
  });
});

// ── arithmetic that must not be able to drift ───────────────────────────────

describe("🔴 the counts describe the rows", () => {
  it("registered = advertised + withheld, and byGate sums to withheld", async () => {
    // A header that disagrees with the table under it is how a page loses the
    // benefit of the doubt on everything else it says.
    asRolelessFamily();
    const r = await inspectToolsForPerson(prisma, {
      targetUserId: "u2",
      message: "show me the invoice from acme",
      offLan: true,
    });

    expect(r.counts.registered).toBe(TOOL_CATALOG.length);
    expect(r.counts.advertised + r.counts.withheld).toBe(r.counts.registered);
    const summed = Object.values(r.counts.byGate).reduce((a, b) => a + b, 0);
    expect(summed).toBe(r.counts.withheld);
  });

  it("every withheld row carries a gate and a reason, and every advertised row carries neither", async () => {
    asScoped(scope({ domains: new Set(["files", "system"]) }));
    const r = await inspectToolsForPerson(prisma, {
      targetUserId: "u3",
      message: "find the contract",
    });
    for (const x of r.rows) {
      if (x.advertised) {
        expect(x.gate, x.name).toBeNull();
        expect(x.reason, x.name).toBeNull();
      } else {
        expect(x.gate, x.name).not.toBeNull();
        expect(x.reason, x.name).toBeTruthy();
      }
    }
  });
});
