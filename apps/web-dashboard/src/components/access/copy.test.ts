/**
 * WARP-1532 (RBAC v2 T8) — §12 copy block ships VERBATIM.
 *
 * Every string below is copied character-for-character from the design
 * brief (shared_brain content/brand/handoffs/access/DESIGN-BRIEF.md §12),
 * with exactly one resolved substitution: the `family` tier's display label
 * is "Staff" (founder decision O-1 / brief §0.1 — the enum value stays
 * `family`; only the label swaps). If one of these assertions fails, the
 * UI has drifted from the shipped copy — fix the component, not the test.
 */
import { describe, it, expect } from "vitest";
import { ACCESS_COPY } from "./copy";

describe("§12 Chrome", () => {
  it("tab + section headers", () => {
    expect(ACCESS_COPY.tab).toBe("Roles & access");
    expect(ACCESS_COPY.yourRoles).toBe("Your roles");
    expect(ACCESS_COPY.builtinRoles).toBe("Built-in roles");
    expect(ACCESS_COPY.peopleWithRole).toBe("People with this role");
  });

  it("member caption", () => {
    expect(ACCESS_COPY.memberCaption).toBe("Only owners and admins can manage access.");
  });

  it("empty states", () => {
    expect(ACCESS_COPY.emptyRoles).toBe(
      "No custom roles yet — the built-in roles cover everyone until you add one. Create a role to give a group of people exactly the access they need.",
    );
    expect(ACCESS_COPY.emptyPeopleInRole).toBe(
      "No one has this role yet — assign people to put it to work.",
    );
    expect(ACCESS_COPY.emptyConnectors).toBe(
      "No connectors set up yet — add one in Integrations.",
    );
  });
});

describe("§12 Starting points (Staff label per §0.1)", () => {
  it("segment captions", () => {
    expect(ACCESS_COPY.startAdmin).toBe("Admin — can manage the box");
    expect(ACCESS_COPY.startStaff).toBe("Staff — everyday staff access");
    expect(ACCESS_COPY.startGuest).toBe("Guest — view-mostly, limited");
  });
});

describe("§12 Builder helpers", () => {
  it("usage + files + locks + always-on", () => {
    expect(ACCESS_COPY.usageDefaults).toBe(
      "These are the defaults for everyone in this role. You can override them per person in People.",
    );
    expect(ACCESS_COPY.filesRow).toBe("Set file access per department →");
    expect(ACCESS_COPY.locksToggle).toBe("May operate locks");
    expect(ACCESS_COPY.chatAlwaysOn).toBe("Chat is always available.");
    expect(ACCESS_COPY.settingsAlwaysOn).toBe("Everyone can reach their own settings.");
  });

  it("dependency block (WARP-1585 — T9-authored, pending packet ratification)", () => {
    // No §12 string exists for a feature blocked by its declared parent; the
    // packet only covers floor-blocks (Lock) and tool auto-off. Authored on
    // the `inviteRolesDegraded` precedent and flagged in copy.ts.
    expect(ACCESS_COPY.docsNeedsFiles).toBe(
      "Documents open from your file libraries — turn Files on to include them.",
    );
  });

  it("tool auto-off + cloud consequence + floor-blocked", () => {
    expect(ACCESS_COPY.toolAutoOff("Cameras")).toBe("Turned off with Cameras.");
    expect(ACCESS_COPY.cloudConsequence).toBe(
      "This is the only setting that sends a person's chat with the assistant off this Droplet — to the cloud AI provider they choose. It's off by default.",
    );
    expect(ACCESS_COPY.floorBlockedNetwork).toBe("Network changes are for admins.");
  });
});

describe("§12 Guardrails", () => {
  it("owner — all three placements", () => {
    expect(ACCESS_COPY.ownerRowMeta).toBe("Full control · can't be changed");
    expect(ACCESS_COPY.ownerDetailNote).toBe(
      "The owner always has full control of this Droplet.",
    );
    expect(ACCESS_COPY.ownerTooltip).toBe(
      "The owner has full control and can't be changed here.",
    );
  });

  it("self + last admin + rank cap", () => {
    expect(ACCESS_COPY.selfLockout).toBe("You can't remove your own access to this panel.");
    expect(ACCESS_COPY.lastAdmin).toBe(
      "This is the last person who can manage access — give someone else an admin role first.",
    );
    expect(ACCESS_COPY.rankCap).toBe("You can only assign access at or below your own level.");
  });

  it("never-a-dead-end recovery links (§8)", () => {
    expect(ACCESS_COPY.manageRolesLink).toBe("Manage roles →");
    expect(ACCESS_COPY.reassignPeopleLink).toBe("Reassign people →");
  });

  it("confirm bodies (templates)", () => {
    expect(ACCESS_COPY.cloudConfirm("Finance")).toBe(
      "Let Finance's assistant use cloud models? This is the only setting that sends a person's chat messages off this Droplet. Turn it off any time.",
    );
    expect(ACCESS_COPY.sessionRevoke("Priya")).toBe(
      "Saved. Applying now — this signs Priya out of their other sessions and the new access takes effect immediately.",
    );
    expect(ACCESS_COPY.deleteRoleUnused("Finance")).toBe(
      "Delete the 'Finance' role? People can't be assigned to it afterwards. This doesn't change anyone's access right now.",
    );
    expect(ACCESS_COPY.deleteRoleInUse(4)).toBe("In use by 4 people — reassign them first.");
    expect(ACCESS_COPY.removePerson("Priya Nair")).toBe(
      "Remove Priya Nair? They lose access to this Droplet immediately and are signed out.",
    );
  });
});

describe("§12 Archive / restore (WARP-1560)", () => {
  it("the archive body ships the packet's SECOND sentence again", () => {
    // T8 shipped this string with "You can restore them any time." cut,
    // because at the time no restore surface existed and §12 never promises
    // an affordance you can't reach. The surface exists now, so the packet's
    // own sentence (prototype access-app.jsx) goes back in — verbatim.
    expect(ACCESS_COPY.archiveRole).toBe(
      "Archived roles can't be assigned but keep their settings. You can restore them any time.",
    );
  });

  it("the restore side is authored, and honest that archive was never a revoke", () => {
    // WARP-1560-authored — no §12 string covers restore (same footing as
    // `docsNeedsFiles` / `inviteRolesDegraded`; flagged for packet
    // ratification). Mirrors the archive + delete bodies: consequence first,
    // then the reassurance. The last sentence is load-bearing, not filler —
    // `effective-access.service.ts` deliberately never reads `state`, so
    // people holding an archived role never lost access and cannot "regain"
    // it (the Departments restore body says the opposite, correctly, for
    // Departments).
    expect(ACCESS_COPY.restoreRole).toBe(
      "Restored roles can be assigned again, and their usage defaults start applying again. This doesn't change anyone's access right now.",
    );
    expect(ACCESS_COPY.archivedRoles).toBe("Archived roles");
    expect(ACCESS_COPY.archived).toBe("Archived");
    expect(ACCESS_COPY.archivedNotAssignable).toBe(
      "Archived roles can't be assigned — restore this one to put it back to work.",
    );
    expect(ACCESS_COPY.emptyRolesAllArchived).toBe(
      "Every custom role is archived — restore one, or create a new role.",
    );
  });
});

describe("§12 Sync + §10 system states", () => {
  it("sync vocabulary", () => {
    expect(ACCESS_COPY.applying).toBe("Applying…");
    expect(ACCESS_COPY.applied).toBe("Applied");
    expect(ACCESS_COPY.needsAttention).toBe("Needs attention");
    expect(ACCESS_COPY.unknownValue).toBe("—");
  });

  it("offline banner + roles error", () => {
    expect(ACCESS_COPY.offlineBanner).toBe(
      "This Droplet is offline — access changes will apply when it's back. Current access still holds.",
    );
    expect(ACCESS_COPY.rolesErrorTitle).toBe("Couldn't reach your Droplet");
    expect(ACCESS_COPY.retry).toBe("Retry");
  });

  it("invite modal degraded picker (§7 / WARP-1533 — T9-authored, pending packet ratification)", () => {
    expect(ACCESS_COPY.inviteRolesDegraded).toBe(
      "Couldn't load your custom roles — you can invite with the built-in roles for now.",
    );
  });

  it("role-picker optgroup label (WARP-1533 N3 — distinct from Surface A's 'Built-in roles')", () => {
    expect(ACCESS_COPY.builtIn).toBe("Built-in");
    expect(ACCESS_COPY.builtinRoles).toBe("Built-in roles");
  });

  it("built-in detail + off-box block copy (§4.2 / §5.4 quoted strings)", () => {
    expect(ACCESS_COPY.builtinFixed).toBe(
      "Built-in roles are fixed. Create a custom role to change what a group can do.",
    );
    expect(ACCESS_COPY.offBoxHeader).toBe("Reaching outside your Droplet");
    expect(ACCESS_COPY.connectorsPHI).toBe(
      "Some connectors include protected health information.",
    );
    expect(ACCESS_COPY.connectorHint).toBe(
      "Read shows the assistant patient and schedule data; write lets it make changes, always with a confirmation step.",
    );
    expect(ACCESS_COPY.serviceMeta).toBe("System identities — not assignable");
    expect(ACCESS_COPY.cloudModelsToggle).toBe("Let this role's assistant use cloud models");
    expect(ACCESS_COPY.builderSubline).toBe(
      "What people with this role can see, do, and use.",
    );
    expect(ACCESS_COPY.addException).toBe("+ Add an exception");
  });
});

describe("§12 Retained quota (WARP-1576)", () => {
  it("states the consequence of clearing a role's storage default", () => {
    // WARP-1576-authored from the ticket's own phrasing. Calm,
    // consequence-stating, no exclamation; singular gets its own form
    // because "1 people" is the kind of thing this surface never ships.
    expect(ACCESS_COPY.retainedQuota(1)).toBe(
      "1 person keeps their current storage limit until it's changed.",
    );
    expect(ACCESS_COPY.retainedQuota(4)).toBe(
      "4 people keep their current storage limit until it's changed.",
    );
  });
});
