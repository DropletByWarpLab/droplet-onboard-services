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
} from "./access";
import type { AccessRole } from "./types";
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
  it("docs requires files, crm requires projects; knowledge stands alone", () => {
    const docs = GATEABLE_FEATURES.find((f) => f.moduleId === "docs")!;
    expect(docs.requires).toBe("files");
    expect(docs.requiresReason).toBe(ACCESS_COPY.docsNeedsFiles);
    // WARP-2117 — the CRM renders as sub-tabs on the Projects page, so it has
    // no surface of its own without it. Same shape as docs/files, and it must
    // mirror the orchestrator registry's `requires` for the same reason.
    const crm = GATEABLE_FEATURES.find((f) => f.moduleId === "crm")!;
    expect(crm.requires).toBe("projects");
    expect(crm.requiresReason).toBe(ACCESS_COPY.crmNeedsProjects);
    // Knowledge reads the box's own chunk store behind the file indexer and
    // has its own page — it is NOT downstream of the file library, and its
    // toggle has to mean exactly what it says. Contacts likewise: WARP-2038
    // gives it its own /contacts page, and it works with the CRM off.
    expect(GATEABLE_FEATURES.find((f) => f.moduleId === "knowledge")!.requires).toBeUndefined();
    expect(GATEABLE_FEATURES.find((f) => f.moduleId === "contacts")!.requires).toBeUndefined();
    expect(
      ACCESS_FEATURES.filter((f) => f.requires).map((f) => f.moduleId).sort(),
    ).toEqual(["crm", "docs"]);
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
