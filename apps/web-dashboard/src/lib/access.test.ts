/**
 * WARP-1532 (RBAC v2 T8) — pure access-domain logic for the Roles & access UI.
 *
 * Pins the floor-clamping model the role builder renders (design brief §3/§5,
 * ADR-032 §2/§3): starting point = the enforcement tier; levels above the
 * ADR-004 floor are BLOCKED (disabled-with-reason, never hidden); re-flooring
 * a draft pulls over-floor levels back and names the first dropped grant with
 * the §12 notice pattern. Also pins the touched-axis save model (review F2):
 * the GB/TB usage inputs and the grouped tool selects are LOSSY views over
 * the wire values (BigInt byte strings, per-domain rows), so any axis the
 * admin never touched re-emits the server's raw values VERBATIM — parsing
 * only happens for explicitly edited fields. Plus the grant-payload builder
 * (absent row = OFF; always-on chat/home/settings never produce grant rows;
 * connector write capped to Admin-based roles per O-2).
 */
import { describe, it, expect } from "vitest";
import {
  TIER_RANK,
  tierLabel,
  tierPlural,
  ACCESS_FEATURES,
  GATEABLE_FEATURES,
  TOOL_DOMAIN_GROUPS,
  isLevelBlocked,
  floorBlockedReason,
  defaultFeatureDraft,
  refloorFeatures,
  slugifyRoleName,
  formatStorageBytes,
  storageInputToBytes,
  connectorLevelsFor,
  dependencyBlockedReason,
  CONNECTOR_LEVELS,
  connectorFloorReason,
  draftToRolePayload,
  roleToDraft,
  blankRoleDraft,
  templateToDraft,
} from "./access";
import type { AccessRole, RoleTemplate } from "./types";
import { ACCESS_COPY } from "@/components/access/copy";

describe("tier ladder + display labels (§0.1 — family displays as Staff)", () => {
  it("ranks guest < family < admin < owner", () => {
    expect(TIER_RANK.guest).toBeLessThan(TIER_RANK.family);
    expect(TIER_RANK.family).toBeLessThan(TIER_RANK.admin);
    expect(TIER_RANK.admin).toBeLessThan(TIER_RANK.owner);
  });

  it("displays the family tier as Staff (enum value unchanged)", () => {
    expect(tierLabel("family")).toBe("Staff");
    expect(tierLabel("admin")).toBe("Admin");
    expect(tierLabel("guest")).toBe("Guest");
    expect(tierLabel("owner")).toBe("Owner");
    expect(tierLabel("service")).toBe("Service");
    expect(tierPlural("family")).toBe("staff");
    expect(tierPlural("admin")).toBe("admins");
  });
});

describe("feature catalog (one vocabulary — the App-Modules ModuleId enum)", () => {
  it("gateable features are exactly the gateable ModuleIds (no chat — always-on)", () => {
    const ids = GATEABLE_FEATURES.map((f) => f.moduleId).sort();
    expect(ids).toEqual(
      [
        "calendar",
        "cameras",
        // WARP-2018 / WARP-2117. Kept in step with the orchestrator's
        // GATEABLE_MODULE_IDS pin in access-catalog.test.ts — the two lists
        // are the same vocabulary and drift between them is the bug this pin
        // exists to catch.
        "contacts",
        "crm",
        "docs",
        "email",
        "files",
        "knowledge",
        "managed_switch",
        // WARP-2581 — money, on the same terms.
        "money",
        "network",
        "projects",
        "smart_home",
        "team_chat",
        "voice",
      ].sort(),
    );
  });

  it("pins the three always-on rows (chat/home/settings) as non-gateable", () => {
    const pinned = ACCESS_FEATURES.filter((f) => f.alwaysOn).map((f) => f.moduleId);
    expect(pinned).toEqual(["home", "chat", "settings"]);
  });

  it("network act + manage carry the admin floor; view does not", () => {
    const network = GATEABLE_FEATURES.find((f) => f.moduleId === "network")!;
    const view = network.levels.find((l) => l.value === "view")!;
    const act = network.levels.find((l) => l.value === "act")!;
    const manage = network.levels.find((l) => l.value === "manage")!;
    expect(view.minTier).toBeUndefined();
    expect(act.minTier).toBe("admin");
    expect(manage.minTier).toBe("admin");
  });

  it("files is the deep-link reference row (per-library rights owned by Departments)", () => {
    const files = GATEABLE_FEATURES.find((f) => f.moduleId === "files")!;
    expect(files.filesReference).toBe(true);
  });

  // ── WARP-1585 — declared dependencies mirror the orchestrator registry ──
  //
  // The server's `ModuleDef.requires` is the authority (the §3 resolver drops
  // a feature whose parent the person does not hold). This copy exists only so
  // the builder can say so before they save, so the two MUST agree: docs
  // requires files, and nothing else declares a parent.
  it("docs requires files; crm, knowledge and contacts stand alone", () => {
    const docs = GATEABLE_FEATURES.find((f) => f.moduleId === "docs")!;
    expect(docs.requires).toBe("files");
    expect(docs.requiresReason).toBe(ACCESS_COPY.docsNeedsFiles);
    // WARP-2558 (ADR-044) — the CRM used to declare `requires: "projects"`
    // because it rendered as sub-tabs on the Projects page and had no surface
    // of its own. /customers is that surface, so the edge is gone here exactly
    // as it is in the orchestrator registry. A stale edge on this side is the
    // worse failure of the two: it would tell a builder to switch on a module
    // the surface does not need, and the server would grant the CRM anyway.
    const crm = GATEABLE_FEATURES.find((f) => f.moduleId === "crm")!;
    expect(crm.requires).toBeUndefined();
    expect(crm.requiresReason).toBeUndefined();
    // Knowledge reads the box's own chunk store behind the file indexer and
    // has its own page — it is NOT downstream of the file library, and its
    // toggle has to mean exactly what it says. Contacts likewise: WARP-2038
    // gives it its own /contacts page, and it works with the CRM off.
    expect(GATEABLE_FEATURES.find((f) => f.moduleId === "knowledge")!.requires).toBeUndefined();
    expect(GATEABLE_FEATURES.find((f) => f.moduleId === "contacts")!.requires).toBeUndefined();
    expect(
      ACCESS_FEATURES.filter((f) => f.requires).map((f) => f.moduleId).sort(),
    ).toEqual(["docs"]);
  });

  it("every declared parent is a real gateable feature, never self-referential", () => {
    for (const f of ACCESS_FEATURES) {
      if (!f.requires) continue;
      expect(f.requires).not.toBe(f.moduleId);
      expect(GATEABLE_FEATURES.some((g) => g.moduleId === f.requires)).toBe(true);
      // A dependency without a reason is a hidden block, which is the thing
      // WARP-1585 exists to remove.
      expect(f.requiresReason && f.requiresReason.length > 0).toBe(true);
    }
  });

  it("dependencyBlockedReason reads the draft and never writes it", () => {
    const docs = GATEABLE_FEATURES.find((f) => f.moduleId === "docs")!;
    const knowledge = GATEABLE_FEATURES.find((f) => f.moduleId === "knowledge")!;
    const off = { files: { on: false, level: "view" as const }, docs: { on: true, level: "manage" as const } };
    expect(dependencyBlockedReason(off, docs)).toBe(ACCESS_COPY.docsNeedsFiles);
    // The operator's stored Documents intent is untouched — blocking is a
    // rendering decision, not an edit (the T8 untouched-axis convention).
    expect(off.docs).toEqual({ on: true, level: "manage" });
    const on = { ...off, files: { on: true, level: "view" as const } };
    expect(dependencyBlockedReason(on, docs)).toBeNull();
    // A feature with no declared parent is never blocked by this path.
    expect(dependencyBlockedReason(off, knowledge)).toBeNull();
  });

  it("every tools-core domain except erp appears in exactly one on-box group", () => {
    const all = TOOL_DOMAIN_GROUPS.flatMap((g) => g.domains);
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain("erp");
    // The design's grouped calendar row expands to the three real domains.
    const cal = TOOL_DOMAIN_GROUPS.find((g) => g.id === "calendar")!;
    expect(cal.domains).toEqual(["calendar", "reminders", "notifications"]);
  });

  it("business is its own on-box row, and System no longer carries it (WARP-2583)", () => {
    // ADR-045 collapsed every PM and CRM tool into the `business` domain. The
    // Projects row used to write the `pm` grant — empty since — while
    // `business` sat under System: withholding Projects changed nothing and
    // the System toggle handed out project-creating tools. MUTATION: move
    // `business` back under `system`, or bring the `projects` row back -> red.
    const business = TOOL_DOMAIN_GROUPS.find((g) => g.id === "business")!;
    expect(business).toMatchObject({ label: "Business", feature: null });
    expect(business.domains).toEqual(["business", "pm", "crm"]);
    expect(TOOL_DOMAIN_GROUPS.find((g) => g.id === "system")!.domains).not.toContain("business");
    expect(TOOL_DOMAIN_GROUPS.find((g) => g.id === "projects")).toBeUndefined();
    // And the payload proves it: Business at `view` next to System at `use`
    // grants `use` on nothing business-shaped.
    const draft = blankRoleDraft("admin");
    draft.tools.business = "view";
    draft.tools.system = "use";
    const grants = draftToRolePayload(draft).toolGrants;
    expect(grants).toContainEqual({ domain: "business", level: "view" });
    expect(grants).toContainEqual({ domain: "system", level: "use" });
    expect(grants.filter((g) => g.level === "use").map((g) => g.domain)).not.toContain("business");
  });
});

describe("floor clamping (§5.2 — blocked levels shown, never hidden)", () => {
  it("blocks network act/manage on a family (Staff) starting point", () => {
    expect(isLevelBlocked("family", "network", "act")).toBe(true);
    expect(isLevelBlocked("family", "network", "manage")).toBe(true);
    expect(isLevelBlocked("family", "network", "view")).toBe(false);
    expect(isLevelBlocked("admin", "network", "manage")).toBe(false);
  });

  it("blocks write levels (act/manage) on a guest starting point for family-floored features", () => {
    expect(isLevelBlocked("guest", "files", "act")).toBe(true);
    expect(isLevelBlocked("guest", "cameras", "manage")).toBe(true);
    expect(isLevelBlocked("guest", "cameras", "view")).toBe(false);
    expect(isLevelBlocked("family", "cameras", "manage")).toBe(false);
  });

  it("names the §12 floor-blocked reason for network verbatim", () => {
    expect(floorBlockedReason("network", "manage")).toBe("Network changes are for admins.");
  });
});

describe("re-flooring a draft (§5.1 — never a silent change)", () => {
  it("keeps an in-floor draft untouched and returns no notice", () => {
    const draft = defaultFeatureDraft("admin");
    const { features, notice } = refloorFeatures(draft, "admin");
    expect(features).toEqual(draft);
    expect(notice).toBeNull();
  });

  it("drops an over-floor level and names the dropped grant (§12 pattern, network example verbatim)", () => {
    const draft = defaultFeatureDraft("admin");
    draft.network = { on: true, level: "manage" };
    const { features, notice } = refloorFeatures(draft, "guest");
    expect(features.network.level).toBe("view");
    expect(notice).toBe(
      "Switching to Guest turns off Configure network — guests can't change the network.",
    );
  });

  it("uses the Staff display label in notices about the family tier", () => {
    const draft = defaultFeatureDraft("admin");
    draft.network = { on: true, level: "manage" };
    const { notice } = refloorFeatures(draft, "family");
    expect(notice).toBe(
      "Switching to Staff turns off Configure network — staff can't change the network.",
    );
  });
});

describe("slug + storage formatting (BigInt strings never lossy)", () => {
  it("slugifies a role name like the server (preview only)", () => {
    expect(slugifyRoleName("Front desk")).toBe("front-desk");
    expect(slugifyRoleName("  Finance & Billing  ")).toBe("finance-billing");
    expect(slugifyRoleName("")).toBe("");
  });

  it("formats storage byte-strings for display and returns — for unknown", () => {
    expect(formatStorageBytes("26843545600")).toBe("25 GB");
    expect(formatStorageBytes("1099511627776")).toBe("1 TB");
    expect(formatStorageBytes(null)).toBe("—");
    expect(formatStorageBytes("not-a-number")).toBe("—");
  });

  it("round-trips an admin-typed limit through the string encoding", () => {
    expect(storageInputToBytes("25", "GB")).toBe("26843545600");
    expect(storageInputToBytes("1", "TB")).toBe("1099511627776");
    expect(storageInputToBytes("", "GB")).toBeNull();
    expect(storageInputToBytes("0", "GB")).toBeNull();
    expect(storageInputToBytes("-3", "GB")).toBeNull();
  });
});

describe("connector levels (O-2 — Read & write only on Admin-based roles)", () => {
  it("caps Family-based starting points at Read", () => {
    expect(connectorLevelsFor("family")).toEqual(["none", "read"]);
    expect(connectorLevelsFor("admin")).toEqual(["none", "read", "read_write"]);
  });

  // WARP-1578 — the Guest floor. O-2's read floor is family-and-UP and
  // routes/erp.ts refuses a guest at the tier floor BEFORE the resolver is
  // even read, so a connector grant on a Guest-based role can never take
  // effect. Offering it lets an operator save a setting that silently does
  // nothing. Mirrors the server's clampConnectorLevel().
  it("offers Guest-based roles no connector level at all", () => {
    expect(connectorLevelsFor("guest")).toEqual(["none"]);
  });

  it("names the floor honestly — shown disabled, never hidden (§5.2)", () => {
    // Every level stays RENDERABLE; `connectorLevelsFor` says which are
    // SELECTABLE, and the builder disables the rest with this reason.
    expect(CONNECTOR_LEVELS).toEqual(["none", "read", "read_write"]);
    expect(connectorFloorReason("guest")).toBe("Connectors are for staff and admins.");
    expect(connectorFloorReason("family")).toBe("Read & write is for admins.");
    expect(connectorFloorReason("admin")).toBeNull();
  });
});

describe("draft → API payload (absent row = OFF; always-on rows never sent)", () => {
  it("emits grants only for enabled gateable features and clamps to the floor", () => {
    const draft = blankRoleDraft("family");
    draft.name = "Front desk";
    draft.features.cameras = { on: true, level: "view" };
    draft.features.network = { on: false, level: "view" };
    const payload = draftToRolePayload(draft);
    expect(payload.name).toBe("Front desk");
    expect(payload.startingPoint).toBe("family");
    const moduleIds = payload.featureGrants.map((g) => g.moduleId);
    expect(moduleIds).not.toContain("chat");
    expect(moduleIds).not.toContain("home");
    expect(moduleIds).not.toContain("settings");
    expect(moduleIds).not.toContain("network"); // toggled off → no row
    expect(payload.featureGrants.find((g) => g.moduleId === "cameras")!.level).toBe("view");
  });

  it("create mode: every group is explicit (touched), fans out, and drops feature-off domains", () => {
    // A blank draft marks all groups touched — the builder's selects ARE the
    // source of truth for a brand-new role, so what the UI shows is what
    // saves. (Edit mode is the opposite: see the untouched-groups suite.)
    const draft = blankRoleDraft("family");
    draft.features.cameras = { on: false, level: "view" };
    draft.tools.calendar = "use";
    draft.tools.cameras = "use"; // feature off → dropped
    const payload = draftToRolePayload(draft);
    const domains = payload.toolGrants.map((g) => g.domain);
    expect(domains).toEqual(expect.arrayContaining(["calendar", "reminders", "notifications"]));
    expect(domains).not.toContain("cameras");
    for (const d of ["calendar", "reminders", "notifications"]) {
      expect(payload.toolGrants.find((g) => g.domain === d)!.level).toBe("use");
    }
  });

  it("caps connector write grants to Admin-based drafts (server re-clamps anyway)", () => {
    const draft = blankRoleDraft("family");
    draft.connectors.eaglesoft = "read_write";
    const payload = draftToRolePayload(draft);
    expect(payload.connectorGrants).toEqual([{ provider: "eaglesoft", level: "read" }]);
  });

  it("drops connector grants entirely on a Guest-based draft (WARP-1578)", () => {
    // Not a client-side policy call: the server's normalizeGrants drops these
    // unconditionally, so emitting them would make the builder show a value
    // the very next GET contradicts. The sheet discloses the removal.
    const draft = blankRoleDraft("guest");
    draft.connectors.eaglesoft = "read";
    draft.connectors["eaglesoft-api"] = "read_write";
    expect(draftToRolePayload(draft).connectorGrants).toEqual([]);
  });

  it("string-encodes storage and leaves empty usage fields null", () => {
    const draft = blankRoleDraft("admin");
    draft.usage.storageValue = "25";
    draft.usage.storageUnit = "GB";
    const payload = draftToRolePayload(draft);
    expect(payload.storageQuotaBytes).toBe("26843545600");
    expect(payload.maxUploadSizeMb).toBeNull();
    expect(payload.llmDailyMessageCap).toBeNull();
  });
});

describe("tool grants — untouched groups never widen or invent (QA send-back)", () => {
  function grantRole(
    toolGrants: AccessRole["toolGrants"],
    featureGrants: AccessRole["featureGrants"],
  ): AccessRole {
    return {
      id: "r1",
      name: "Finance",
      slug: "finance",
      description: null,
      startingPoint: "family",
      state: "active",
      storageQuotaBytes: null,
      maxUploadSizeMb: null,
      llmDailyMessageCap: null,
      cloudModelsAllowed: false,
      mayOperateLocks: false,
      createdBy: "u0",
      createdAt: "2026-07-24T00:00:00Z",
      updatedAt: "2026-07-24T00:00:00Z",
      peopleCount: 0,
      featureGrants,
      toolGrants,
      connectorGrants: [],
    };
  }
  const sortRows = (rows: Array<{ domain: string; level: string }>) =>
    [...rows].sort((a, b) => a.domain.localeCompare(b.domain));

  it("an untouched save round-trips MIXED per-domain grants verbatim (no widening)", () => {
    const original = [
      { domain: "calendar", level: "use" as const },
      { domain: "reminders", level: "view" as const },
      { domain: "notifications", level: "view" as const },
    ];
    const draft = roleToDraft(
      grantRole(original, [{ moduleId: "calendar", level: "view" }]),
    );
    // Name-only edit — the tool axis was never touched.
    draft.name = "Finance renamed";
    const payload = draftToRolePayload(draft);
    expect(sortRows(payload.toolGrants)).toEqual(sortRows(original));
  });

  it("a feature-on group with ZERO grant rows stays zero on an untouched save (absent row = OFF)", () => {
    const draft = roleToDraft(grantRole([], [{ moduleId: "cameras", level: "view" }]));
    draft.name = "Renamed";
    const payload = draftToRolePayload(draft);
    expect(payload.toolGrants).toEqual([]);
  });

  it("touching a group fans out THAT group only and supersedes its original rows", () => {
    const draft = roleToDraft(
      grantRole(
        [
          { domain: "calendar", level: "use" },
          { domain: "reminders", level: "view" },
          { domain: "files", level: "use" },
        ],
        [
          { moduleId: "calendar", level: "view" },
          { moduleId: "files", level: "act" },
        ],
      ),
    );
    draft.tools.calendar = "view";
    draft.touchedToolGroups = ["calendar"];
    const payload = draftToRolePayload(draft);
    expect(sortRows(payload.toolGrants)).toEqual(
      sortRows([
        { domain: "calendar", level: "view" },
        { domain: "reminders", level: "view" },
        { domain: "notifications", level: "view" },
        { domain: "files", level: "use" }, // untouched original, verbatim
      ]),
    );
  });

  it("rows for domains outside the grouped list (erp) pass through untouched", () => {
    const draft = roleToDraft(
      grantRole([{ domain: "erp", level: "use" }], [{ moduleId: "files", level: "view" }]),
    );
    const payload = draftToRolePayload(draft);
    expect(payload.toolGrants).toEqual([{ domain: "erp", level: "use" }]);
  });

  it("toggling a feature OFF drops its group's original rows (auto-off still real)", () => {
    const draft = roleToDraft(
      grantRole(
        [{ domain: "cameras", level: "use" }],
        [{ moduleId: "cameras", level: "view" }],
      ),
    );
    draft.features.cameras = { on: false, level: "view" };
    const payload = draftToRolePayload(draft);
    expect(payload.toolGrants).toEqual([]);
  });
});

describe("usage — untouched fields never drift or drop (review F2)", () => {
  function usageRole(overrides: Partial<AccessRole>): AccessRole {
    return {
      id: "r1",
      name: "Finance",
      slug: "finance",
      description: null,
      startingPoint: "family",
      state: "active",
      storageQuotaBytes: null,
      maxUploadSizeMb: null,
      llmDailyMessageCap: null,
      cloudModelsAllowed: false,
      mayOperateLocks: false,
      createdBy: "u0",
      createdAt: "2026-07-24T00:00:00Z",
      updatedAt: "2026-07-24T00:00:00Z",
      peopleCount: 0,
      featureGrants: [],
      toolGrants: [],
      connectorGrants: [],
      ...overrides,
    };
  }

  it("a non-whole-GB quota round-trips verbatim on a name-only save (no float drift)", () => {
    const draft = roleToDraft(
      usageRole({ storageQuotaBytes: "1234567890123", maxUploadSizeMb: 123, llmDailyMessageCap: 7 }),
    );
    draft.name = "Finance renamed";
    const payload = draftToRolePayload(draft);
    expect(payload.storageQuotaBytes).toBe("1234567890123");
    expect(payload.maxUploadSizeMb).toBe(123);
    expect(payload.llmDailyMessageCap).toBe(7);
  });

  it("a sub-0.05-GB quota (20 MB) round-trips verbatim — never nulled into no-limit", () => {
    const draft = roleToDraft(usageRole({ storageQuotaBytes: "20971520" }));
    draft.name = "Renamed";
    const payload = draftToRolePayload(draft);
    expect(payload.storageQuotaBytes).toBe("20971520");
  });

  it("a TOUCHED storage field emits the newly typed value", () => {
    const draft = roleToDraft(usageRole({ storageQuotaBytes: "1234567890123" }));
    draft.usage.storageValue = "25";
    draft.usage.storageUnit = "GB";
    draft.usageTouched = true;
    const payload = draftToRolePayload(draft);
    expect(payload.storageQuotaBytes).toBe("26843545600");
  });
});

describe("role wire shape → editable draft", () => {
  it("hydrates a draft from an AccessRole and survives a payload round-trip", () => {
    const role: AccessRole = {
      id: "r1",
      name: "Finance",
      slug: "finance",
      description: "Bookkeeping",
      startingPoint: "family",
      state: "active",
      storageQuotaBytes: "26843545600",
      maxUploadSizeMb: 200,
      llmDailyMessageCap: null,
      cloudModelsAllowed: false,
      mayOperateLocks: false,
      createdBy: "u0",
      createdAt: "2026-07-24T00:00:00Z",
      updatedAt: "2026-07-24T00:00:00Z",
      peopleCount: 2,
      syncState: "synced",
      featureGrants: [
        { moduleId: "files", level: "act" },
        { moduleId: "cameras", level: "view" },
      ],
      toolGrants: [{ domain: "files", level: "use" }],
      connectorGrants: [{ provider: "eaglesoft", level: "read" }],
    };
    const draft = roleToDraft(role);
    expect(draft.features.files).toEqual({ on: true, level: "act" });
    expect(draft.features.network.on).toBe(false); // absent row = OFF
    expect(draft.usage.storageValue).toBe("25");
    expect(draft.usage.storageUnit).toBe("GB");
    expect(draft.tools.files).toBe("use");
    expect(draft.connectors.eaglesoft).toBe("read");
    const payload = draftToRolePayload(draft);
    expect(payload.storageQuotaBytes).toBe("26843545600");
    expect(payload.featureGrants).toEqual(
      expect.arrayContaining([{ moduleId: "files", level: "act" }]),
    );
    // QA send-back: an untouched tool axis round-trips the server rows
    // EXACTLY — one files:use row, nothing fanned out, nothing invented.
    expect(payload.toolGrants).toEqual([{ domain: "files", level: "use" }]);
  });
});

// ── WARP-2738 — role templates ────────────────────────────────────────────
//
// ADR-032 shipped the RBAC engine and nothing to start from. The eight
// starting points live in the ORCHESTRATOR
// (`apps/orchestrator/src/services/access-role-templates.ts`) and reach this
// app only over the wire, so the fixtures below are a HAND MIRROR — there is
// no shared access types package, and nothing here can detect server drift.
// That is deliberate, and it is why these tests assert the FUNCTION rather
// than the catalogue: every claim is "this template SHAPE survives the round
// trip", which stays true whatever the server ships. The server's own
// `access-role-templates.test.ts` re-runs the real clamps against the real
// catalogue; that is the drift alarm.
//
// The round trip is the whole risk. `POST { templateId }` never touches this
// module — but the "start from this, then adjust" path does, and it saves
// through `draftToRolePayload`. A template whose grants quietly change shape
// on the way to the wire produces a role narrower (or wider) than the card the
// operator clicked, with nothing on screen saying so.
describe("WARP-2738 — role template → draft → payload round trip", () => {
  /** One shape per shipped template, in presentation order. Mirrors the
   *  orchestrator catalogue; see the note above on why that is acceptable. */
  const ROLE_TEMPLATES: RoleTemplate[] = [
    {
      id: "front-desk",
      name: "Front Desk",
      description: "Reception and front-of-house.",
      startingPoint: "family",
      featureGrants: [
        { moduleId: "files", level: "act" },
        { moduleId: "docs", level: "act" },
        { moduleId: "calendar", level: "manage" },
        { moduleId: "contacts", level: "act" },
        { moduleId: "crm", level: "act" },
        { moduleId: "email", level: "act" },
        { moduleId: "knowledge", level: "view" },
        { moduleId: "team_chat", level: "act" },
        { moduleId: "voice", level: "act" },
      ],
      toolGrants: [
        { domain: "files", level: "view" },
        { domain: "calendar", level: "view" },
        { domain: "reminders", level: "view" },
        { domain: "notifications", level: "view" },
        { domain: "email", level: "view" },
        { domain: "crm", level: "view" },
        { domain: "memory", level: "view" },
      ],
      connectorGrants: [],
      cloudModelsAllowed: false,
      mayOperateLocks: false,
      storageQuotaBytes: null,
      maxUploadSizeMb: null,
      llmDailyMessageCap: null,
    },
    {
      id: "clinical-staff",
      name: "Clinical Staff",
      description: "The hands-on team.",
      startingPoint: "family",
      featureGrants: [
        { moduleId: "files", level: "view" },
        { moduleId: "docs", level: "view" },
        { moduleId: "calendar", level: "act" },
        { moduleId: "contacts", level: "view" },
        { moduleId: "knowledge", level: "act" },
        { moduleId: "team_chat", level: "act" },
        { moduleId: "voice", level: "act" },
      ],
      toolGrants: [
        { domain: "files", level: "view" },
        { domain: "calendar", level: "view" },
        { domain: "reminders", level: "view" },
        { domain: "notifications", level: "view" },
        { domain: "memory", level: "view" },
      ],
      connectorGrants: [],
      cloudModelsAllowed: false,
      mayOperateLocks: false,
      storageQuotaBytes: null,
      maxUploadSizeMb: null,
      llmDailyMessageCap: null,
    },
    {
      id: "office-manager",
      name: "Office Manager",
      description: "Runs the practice end to end.",
      startingPoint: "admin",
      featureGrants: [
        { moduleId: "files", level: "manage" },
        { moduleId: "docs", level: "manage" },
        { moduleId: "email", level: "manage" },
        { moduleId: "calendar", level: "manage" },
        { moduleId: "contacts", level: "manage" },
        { moduleId: "crm", level: "manage" },
        { moduleId: "money", level: "manage" },
        { moduleId: "projects", level: "manage" },
        { moduleId: "knowledge", level: "manage" },
        { moduleId: "voice", level: "manage" },
        { moduleId: "cameras", level: "view" },
        { moduleId: "network", level: "view" },
        { moduleId: "team_chat", level: "act" },
      ],
      toolGrants: [
        { domain: "files", level: "use" },
        { domain: "email", level: "use" },
        { domain: "calendar", level: "use" },
        { domain: "reminders", level: "use" },
        { domain: "notifications", level: "use" },
        { domain: "crm", level: "use" },
        { domain: "pm", level: "use" },
        { domain: "memory", level: "use" },
        { domain: "money", level: "use" },
        { domain: "team_chat", level: "use" },
        { domain: "business", level: "use" },
        { domain: "data", level: "use" },
      ],
      connectorGrants: [],
      cloudModelsAllowed: false,
      mayOperateLocks: false,
      storageQuotaBytes: null,
      maxUploadSizeMb: null,
      llmDailyMessageCap: null,
    },
    {
      id: "bookkeeper",
      name: "Bookkeeper",
      description: "The books, not the practice.",
      startingPoint: "admin",
      featureGrants: [
        { moduleId: "money", level: "manage" },
        { moduleId: "files", level: "act" },
        { moduleId: "docs", level: "act" },
        { moduleId: "crm", level: "view" },
        { moduleId: "contacts", level: "view" },
        { moduleId: "calendar", level: "view" },
        { moduleId: "team_chat", level: "act" },
      ],
      toolGrants: [
        { domain: "money", level: "use" },
        { domain: "files", level: "view" },
        { domain: "crm", level: "view" },
        { domain: "business", level: "view" },
        { domain: "data", level: "view" },
      ],
      connectorGrants: [],
      cloudModelsAllowed: false,
      mayOperateLocks: false,
      storageQuotaBytes: null,
      maxUploadSizeMb: null,
      llmDailyMessageCap: null,
    },
    {
      id: "it-facilities",
      name: "IT & Facilities",
      description: "The router, the switch, the cameras and the locks.",
      startingPoint: "admin",
      featureGrants: [
        { moduleId: "network", level: "manage" },
        { moduleId: "managed_switch", level: "manage" },
        { moduleId: "cameras", level: "manage" },
        { moduleId: "smart_home", level: "manage" },
        { moduleId: "files", level: "view" },
        { moduleId: "voice", level: "view" },
        { moduleId: "team_chat", level: "act" },
      ],
      toolGrants: [
        { domain: "network", level: "use" },
        { domain: "switch", level: "use" },
        { domain: "cameras", level: "use" },
        { domain: "smart-home", level: "use" },
        { domain: "files", level: "view" },
        { domain: "system", level: "use" },
        { domain: "data", level: "view" },
      ],
      connectorGrants: [],
      cloudModelsAllowed: false,
      mayOperateLocks: true,
      storageQuotaBytes: null,
      maxUploadSizeMb: null,
      llmDailyMessageCap: null,
    },
    {
      id: "marketing-outreach",
      name: "Marketing & Outreach",
      description: "Campaigns, recalls and the pipeline.",
      startingPoint: "family",
      featureGrants: [
        { moduleId: "crm", level: "act" },
        { moduleId: "contacts", level: "act" },
        { moduleId: "email", level: "act" },
        { moduleId: "files", level: "act" },
        { moduleId: "docs", level: "act" },
        { moduleId: "calendar", level: "act" },
        { moduleId: "knowledge", level: "view" },
        { moduleId: "team_chat", level: "act" },
      ],
      toolGrants: [
        { domain: "crm", level: "view" },
        { domain: "email", level: "view" },
        { domain: "files", level: "view" },
        { domain: "calendar", level: "view" },
        { domain: "reminders", level: "view" },
        { domain: "notifications", level: "view" },
        { domain: "memory", level: "view" },
      ],
      connectorGrants: [],
      cloudModelsAllowed: false,
      mayOperateLocks: false,
      storageQuotaBytes: null,
      maxUploadSizeMb: null,
      llmDailyMessageCap: null,
    },
    {
      id: "read-only-auditor",
      name: "Read-only Auditor",
      description: "An outside accountant, compliance reviewer or consultant.",
      startingPoint: "guest",
      featureGrants: [
        { moduleId: "files", level: "view" },
        { moduleId: "docs", level: "view" },
        { moduleId: "crm", level: "view" },
        { moduleId: "calendar", level: "view" },
        { moduleId: "contacts", level: "view" },
        { moduleId: "knowledge", level: "view" },
        { moduleId: "projects", level: "view" },
        { moduleId: "team_chat", level: "view" },
      ],
      toolGrants: [
        { domain: "files", level: "view" },
        { domain: "crm", level: "view" },
        { domain: "calendar", level: "view" },
        { domain: "reminders", level: "view" },
        { domain: "notifications", level: "view" },
        { domain: "memory", level: "view" },
        { domain: "pm", level: "view" },
      ],
      connectorGrants: [],
      cloudModelsAllowed: false,
      mayOperateLocks: false,
      storageQuotaBytes: null,
      maxUploadSizeMb: null,
      llmDailyMessageCap: null,
    },
    {
      id: "contractor-temp",
      name: "Contractor / Temp",
      description: "The smallest surface that is still useful.",
      startingPoint: "guest",
      featureGrants: [
        { moduleId: "files", level: "view" },
        { moduleId: "calendar", level: "view" },
        { moduleId: "team_chat", level: "act" },
        { moduleId: "voice", level: "act" },
      ],
      toolGrants: [
        { domain: "files", level: "view" },
        { domain: "calendar", level: "view" },
        { domain: "reminders", level: "view" },
        { domain: "notifications", level: "view" },
      ],
      connectorGrants: [],
      cloudModelsAllowed: false,
      mayOperateLocks: false,
      storageQuotaBytes: null,
      maxUploadSizeMb: null,
      llmDailyMessageCap: null,
    },
  ];

  const byTemplateId = (id: string) => ROLE_TEMPLATES.find((t) => t.id === id)!;
  const sortFeatures = (rows: ReadonlyArray<{ moduleId: string; level: string }>) =>
    [...rows].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  const sortTools = (rows: ReadonlyArray<{ domain: string; level: string }>) =>
    [...rows].sort((a, b) => a.domain.localeCompare(b.domain));
  /** Domains TOOL_DOMAIN_GROUPS knows about — the group fan-out's whole reach. */
  const GROUPED_DOMAINS = new Set(TOOL_DOMAIN_GROUPS.flatMap((g) => g.domains));

  // ── The bar: one test per template, named by id, so a failure says WHICH
  //    profile lost grants rather than "round trip failed".
  for (const template of ROLE_TEMPLATES) {
    it(template.id + ": every feature AND tool grant survives draft → payload", () => {
      const payload = draftToRolePayload(templateToDraft(template));
      expect(sortFeatures(payload.featureGrants)).toEqual(sortFeatures(template.featureGrants));
      expect(sortTools(payload.toolGrants)).toEqual(sortTools(template.toolGrants));
    });

    it(template.id + ": no grant is clamped by the client floor model", () => {
      // The server re-clamps authoritatively and SILENTLY — over-asking stores
      // a smaller grant than the card advertises. The templates are authored so
      // that clamp is a no-op; this asserts the client's copy of the floors
      // agrees, which is what makes the round trip above exact rather than
      // lucky.
      for (const grant of template.featureGrants) {
        expect(
          isLevelBlocked(template.startingPoint, grant.moduleId, grant.level),
          template.id + " asks for " + grant.moduleId + "@" + grant.level,
        ).toBe(false);
      }
    });

    it(template.id + ": carries no connector grant and no usage cap", () => {
      const payload = draftToRolePayload(templateToDraft(template));
      // Provider slugs are per-box: a template naming one this box has not
      // configured would store dead config the roles list advertises as reach.
      expect(payload.connectorGrants).toEqual([]);
      // The daily message cap is stored and rendered but never enforced, so no
      // template advertises a limit the box does not keep.
      expect(payload.storageQuotaBytes).toBeNull();
      expect(payload.maxUploadSizeMb).toBeNull();
      expect(payload.llmDailyMessageCap).toBeNull();
      expect(payload.cloudModelsAllowed).toBe(false);
    });
  }

  it("hydrates the identity fields and leaves the slug to the server", () => {
    const draft = templateToDraft(byTemplateId("front-desk"));
    expect(draft.id).toBeNull(); // no row yet — this draft CREATES one
    expect(draft.name).toBe("Front Desk");
    expect(draft.startingPoint).toBe("family");
    // Client-side preview only; the server derives the authoritative slug and
    // uniquifies it ("front-desk", then "front-desk-2" on the second click).
    expect(draft.slug).toBe("front-desk");
    const payload = draftToRolePayload(draft);
    expect(payload.name).toBe("Front Desk");
    expect(payload.description).toBe("Reception and front-of-house.");
  });

  it("locks ride only on IT & Facilities, and only while Devices is granted", () => {
    const itf = byTemplateId("it-facilities");
    expect(draftToRolePayload(templateToDraft(itf)).mayOperateLocks).toBe(true);
    // The payload builder ANDs locks against a live smart_home grant exactly as
    // the server does, so turning Devices off in the builder turns locks off
    // with it rather than saving a setting that silently does nothing.
    const draft = templateToDraft(itf);
    draft.features.smart_home = { on: false, level: "view" };
    expect(draftToRolePayload(draft).mayOperateLocks).toBe(false);

    for (const t of ROLE_TEMPLATES.filter((x) => x.id !== "it-facilities")) {
      expect(draftToRolePayload(templateToDraft(t)).mayOperateLocks).toBe(false);
    }
  });

  // ── Trap: the four domains no UI group covers ───────────────────────────
  describe("ungrouped tool domains (the silent-drop trap)", () => {
    it("TOOL_DOMAIN_GROUPS covers neither crm, money, team_chat nor agent_runs", () => {
      // The premise the whole seeding strategy rests on. If a group ever adopts
      // one of these, this pin fails and `templateToDraft` needs re-reading — a
      // grouped domain is fanned out, not passed through.
      for (const ungrouped of ["crm", "money", "team_chat", "agent_runs"]) {
        expect(GROUPED_DOMAINS.has(ungrouped)).toBe(false);
      }
    });

    it("seeds originalToolGrants with the template's rows VERBATIM, ungrouped included", () => {
      const draft = templateToDraft(byTemplateId("office-manager"));
      expect(sortTools(draft.originalToolGrants)).toEqual(
        sortTools(byTemplateId("office-manager").toolGrants),
      );
      expect(draft.originalToolGrants.map((t) => t.domain)).toEqual(
        expect.arrayContaining(["crm", "money", "team_chat"]),
      );
    });

    it("REGRESSION: dropping the ungrouped rows loses crm, money and team_chat silently", () => {
      // The defect this seeding exists to prevent. A draft that trusted the
      // groups to cover the tool axis — seeding originalToolGrants with only
      // the domains TOOL_DOMAIN_GROUPS knows — ships an Office Manager with no
      // CRM, no Money and no Messages tools, and nothing anywhere says so.
      const draft = templateToDraft(byTemplateId("office-manager"));
      draft.originalToolGrants = draft.originalToolGrants.filter((t) =>
        GROUPED_DOMAINS.has(t.domain),
      );
      const domains = draftToRolePayload(draft).toolGrants.map((t) => t.domain);
      expect(domains).not.toContain("crm");
      expect(domains).not.toContain("money");
      expect(domains).not.toContain("team_chat");
    });

    it("a domain this build's groups do not know rides through untouched", () => {
      // Forward compatibility: a tool domain added to the server after this
      // build shipped belongs to no group here, so it can only survive via the
      // pass-through path — the same path `erp` already uses.
      const future: RoleTemplate = {
        ...byTemplateId("contractor-temp"),
        toolGrants: [
          { domain: "files", level: "view" },
          { domain: "agent_runs", level: "view" },
        ],
      };
      expect(sortTools(draftToRolePayload(templateToDraft(future)).toolGrants)).toEqual(
        sortTools(future.toolGrants),
      );
    });
  });

  // ── Trap: the group fan-out ─────────────────────────────────────────────
  describe("touchedToolGroups (the fan-out trap)", () => {
    it("starts empty — a template's rows are per-domain, like a server role's", () => {
      expect(templateToDraft(byTemplateId("office-manager")).touchedToolGroups).toEqual([]);
    });

    it("REGRESSION: seeding every group (the blank-draft shape) INVENTS grants", () => {
      // blankRoleDraft marks every group touched, because on a brand-new role
      // the selects are the only truth. A template is not a brand-new role: its
      // rows are already per-domain, and a touched group fans its single
      // display level across ALL of its domains. Front Desk grants no System
      // and no Cloud tools at all — but neither group is gated by a feature, so
      // a fully-touched draft emits them anyway.
      const draft = templateToDraft(byTemplateId("front-desk"));
      draft.touchedToolGroups = TOOL_DOMAIN_GROUPS.map((g) => g.id);
      const domains = draftToRolePayload(draft).toolGrants.map((t) => t.domain);
      expect(domains).toContain("system");
      expect(domains).toContain("cloud");
      expect(domains).toContain("business");
      // …none of which the template holds.
      expect(byTemplateId("front-desk").toolGrants.map((t) => t.domain)).not.toContain("system");
    });

    it("REGRESSION: seeding every group also WIDENS a partially-granted group", () => {
      // IT & Facilities holds system@use and data@view and no business row at
      // all — three different answers inside one group. The select can only
      // hold one, so fanning it out widens data to `use` and invents business.
      const draft = templateToDraft(byTemplateId("it-facilities"));
      draft.touchedToolGroups = TOOL_DOMAIN_GROUPS.map((g) => g.id);
      const rows = draftToRolePayload(draft).toolGrants;
      expect(rows).toContainEqual({ domain: "data", level: "use" });
      expect(byTemplateId("it-facilities").toolGrants).toContainEqual({
        domain: "data",
        level: "view",
      });
    });

    it("touching a group afterwards fans out THAT group only", () => {
      // The operator's own edit still works exactly as it does in edit mode:
      // the touched group supersedes its original rows, everything else passes
      // through verbatim.
      const draft = templateToDraft(byTemplateId("contractor-temp"));
      draft.tools.calendar = "use";
      draft.touchedToolGroups = ["calendar"];
      expect(sortTools(draftToRolePayload(draft).toolGrants)).toEqual(
        sortTools([
          { domain: "calendar", level: "use" },
          { domain: "reminders", level: "use" },
          { domain: "notifications", level: "use" },
          { domain: "files", level: "view" }, // untouched, verbatim
        ]),
      );
    });

    it("the group selects show the WIDEST granted level without granting it", () => {
      const draft = templateToDraft(byTemplateId("it-facilities"));
      expect(draft.tools.system).toBe("use"); // widest of system@use, data@view
      // Display only — the save path ignores it while the group is untouched.
      expect(sortTools(draftToRolePayload(draft).toolGrants)).toEqual(
        sortTools(byTemplateId("it-facilities").toolGrants),
      );
    });
  });

  // ── Trap: the lossy usage inputs ────────────────────────────────────────
  it("usage values re-emit verbatim rather than through the lossy GB/TB input", () => {
    // Every shipped template leaves all three caps null, so both paths agree
    // today. They stop agreeing the moment one carries a non-whole-GB quota:
    // `usageTouched: false` re-emits the raw byte string, where re-parsing the
    // display value drifts it (~20 MB on a ~1.1 TB value) and nulls anything
    // under 0.05 GB — the T8 bug, in a new place.
    const quota: RoleTemplate = {
      ...byTemplateId("contractor-temp"),
      storageQuotaBytes: "1234567890123",
      maxUploadSizeMb: 123,
      llmDailyMessageCap: 7,
    };
    const draft = templateToDraft(quota);
    expect(draft.usageTouched).toBe(false);
    const payload = draftToRolePayload(draft);
    expect(payload.storageQuotaBytes).toBe("1234567890123");
    expect(payload.maxUploadSizeMb).toBe(123);
    expect(payload.llmDailyMessageCap).toBe(7);
  });

  it("turning a feature off in the builder drops its grant AND its tool rows", () => {
    const draft = templateToDraft(byTemplateId("front-desk"));
    draft.features.email = { on: false, level: "view" };
    const payload = draftToRolePayload(draft);
    expect(payload.featureGrants.map((g) => g.moduleId)).not.toContain("email");
    expect(payload.toolGrants.map((t) => t.domain)).not.toContain("email");
  });

  // ── The known hole, pinned so a change to it is deliberate ──────────────
  it("KNOWN: a grant on a module this build's catalog lacks is dropped from the draft", () => {
    // `features` is built by walking ACCESS_FEATURES — the only way to render
    // "absent row = OFF" as an explicit off entry — so a module added to the
    // server's vocabulary after this build shipped has no row to land in. The
    // direct `POST { templateId }` path is unaffected (the server never
    // consults this module), and the tool axis has no equivalent hole. If this
    // ever needs to be visible rather than silent, the fix is to surface the
    // unmatched moduleIds, not to invent a row for them.
    const future: RoleTemplate = {
      ...byTemplateId("contractor-temp"),
      featureGrants: [
        { moduleId: "files", level: "view" },
        // A ModuleId this dashboard build does not know:
        {
          moduleId: "receipts" as RoleTemplate["featureGrants"][number]["moduleId"],
          level: "view",
        },
      ],
    };
    const modules = draftToRolePayload(templateToDraft(future)).featureGrants.map(
      (g) => g.moduleId,
    );
    expect(modules).toEqual(["files"]);
  });

  it("mirrors the eight shipped templates in presentation order", () => {
    // Documents the mirror; it cannot detect server drift (nothing here reads
    // the server). The array order IS the product order — the panel renders it
    // as served and never sorts.
    expect(ROLE_TEMPLATES.map((t) => t.id)).toEqual([
      "front-desk",
      "clinical-staff",
      "office-manager",
      "bookkeeper",
      "it-facilities",
      "marketing-outreach",
      "read-only-auditor",
      "contractor-temp",
    ]);
    expect(ROLE_TEMPLATES.map((t) => t.startingPoint)).toEqual([
      "family",
      "family",
      "admin",
      "admin",
      "admin",
      "family",
      "guest",
      "guest",
    ]);
  });
});
