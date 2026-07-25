/**
 * WARP-1532 (RBAC v2 T8) — pure access-domain logic for the Roles & access UI.
 *
 * Pins the floor-clamping model the role builder renders (design brief §3/§5,
 * ADR-032 §2/§3): starting point = the enforcement tier; levels above the
 * ADR-004 floor are BLOCKED (disabled-with-reason, never hidden); re-flooring
 * a draft pulls over-floor levels back and names the first dropped grant with
 * the §12 notice pattern. Also pins the BigInt-string display formatting
 * (storageQuotaBytes travels as a decimal string — never parsed into a lossy
 * float round-trip) and the grant-payload builder (absent row = OFF; always-on
 * chat/home/settings never produce grant rows; connector write capped to
 * Admin-based roles per O-2).
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
  draftToRolePayload,
  roleToDraft,
  blankRoleDraft,
} from "./access";
import type { AccessRole } from "./types";

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
        "docs",
        "email",
        "files",
        "knowledge",
        "managed_switch",
        "network",
        "projects",
        "smart_home",
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
  it("caps non-admin starting points at Read", () => {
    expect(connectorLevelsFor("family")).toEqual(["none", "read"]);
    expect(connectorLevelsFor("guest")).toEqual(["none", "read"]);
    expect(connectorLevelsFor("admin")).toEqual(["none", "read", "read_write"]);
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

  it("expands tool groups into per-domain grant rows and drops feature-off domains", () => {
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
  });
});
