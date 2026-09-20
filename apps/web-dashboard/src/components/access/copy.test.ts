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

// ── WARP-2738: the role-template catalogue ───────────────────────────
//
// All WARP-2738-authored (§12 predates templates entirely; flagged for packet
// ratification in copy.ts). Pinned character-for-character like the rest, plus
// three PROPERTIES that are the actual point of the ticket:
//
//   1. no string claims the person is TOLD they lack permission — the refusal
//      is a 404 byte-identical to the box-wide module toggle, so "will not see
//      it" is the only honest verb;
//   2. the enforced/nav-only split is described as a real difference, not
//      smoothed over;
//   3. the retry sentence says NOTHING WAS CREATED, because a 409
//      CONCURRENT_MUTATION applied nothing and an operator who doubts that
//      will not press the button again.
describe("§12 Role templates (WARP-2738 — authored, pending packet ratification)", () => {
  it("chrome + affordances", () => {
    expect(ACCESS_COPY.templatesTitle).toBe("Start from a template");
    expect(ACCESS_COPY.templatesOpen).toBe("Start from a template");
    expect(ACCESS_COPY.templatesUse).toBe("Use this template");
    expect(ACCESS_COPY.templatesCustomize).toBe("Customize first");
    expect(ACCESS_COPY.templatesLead).toBe(
      "Ready-made starting points for the jobs a practice actually hires for. Picking one creates an ordinary role — edit, rename or delete it afterwards, exactly like one you built by hand.",
    );
  });

  it("states the narrowing a role performs — grants are additive from zero", () => {
    // `fullCatalogFeatures(tier)` runs ONLY on the resolver's no-role branch,
    // so assigning a role is not "a tier minus some things".
    expect(ACCESS_COPY.templatesNarrowing).toBe(
      "Giving someone one of these narrows what they reach: they get chat plus exactly what the template grants, and nothing else. Someone left on a plain built-in role keeps everything that role allows.",
    );
  });

  it("splits genuinely-enforced modules from nav-only ones, in both directions", () => {
    expect(ACCESS_COPY.templatesEnforcedLegend).toBe("Checked per person");
    expect(ACCESS_COPY.templatesEnforcedLegendBody).toBe(
      "Withholding these really withholds them. Anyone without the grant will not see the page — it answers exactly as it does when the whole box has that feature switched off.",
    );
    expect(ACCESS_COPY.templatesNavOnlyLegend).toBe("Menu only");
    expect(ACCESS_COPY.templatesNavOnlyLegendBody).toBe(
      "These only change the menu. The API behind them still answers, so treat them as tidying what someone sees rather than withholding the data.",
    );
  });

  it("never says a person is TOLD they lack permission — no such message exists", () => {
    // The denial is `404 {"error":"module_disabled"}`, identical to the
    // box-wide toggle. "You don't have permission" would describe a screen
    // this box never renders.
    const strings: string[] = [];
    for (const value of Object.values(ACCESS_COPY)) {
      if (typeof value === "string") strings.push(value);
    }
    for (const s of strings) {
      expect(s).not.toMatch(/lack\s+permission|don'?t have permission|not permitted|access denied/i);
    }
    // …and the honest verb IS present where the split is explained.
    expect(ACCESS_COPY.templatesEnforcedLegendBody).toMatch(/will not see/);
  });

  it("discloses the two things the payload cannot carry", () => {
    // Every registry-driven gate mounts at "view"; three camera routes at
    // "manage" are the only exception, and they are named rather than waved at.
    expect(ACCESS_COPY.templatesLevelsNote).toBe(
      "Levels are recorded, but the per-person checks nearly all run at view — so edit and manage shape this builder more than they shape what the box holds back. Cameras is the exception: three of its routes check for manage.",
    );
    expect(ACCESS_COPY.templatesNoExtras).toBe(
      "No template carries connector access or a usage cap. Add connector access in the builder after you create the role; the storage, upload and daily-message limits are left unset on purpose.",
    );
  });

  it("says a Staff- or Guest-based role's assistant tools are read-only", () => {
    // `tierKeepsWriteTools` admits owner and admin only — `use` and `view` are
    // the same grant below admin, so the card must not imply otherwise.
    expect(ACCESS_COPY.toolsReadOnlyBelowAdmin).toBe(
      "Staff- and Guest-based roles get read-only assistant tools, whatever the tool level says.",
    );
    expect(ACCESS_COPY.toolsAxis).toBe("Assistant tools");
    expect(ACCESS_COPY.noToolsGranted).toBe("No tools on");
    expect(ACCESS_COPY.templatesNoneGranted).toBe("None");
  });

  it("state trio bodies", () => {
    expect(ACCESS_COPY.templatesEmpty).toBe(
      "This Droplet is serving no templates — create a role from scratch instead.",
    );
    expect(ACCESS_COPY.templatesErrorBody).toBe(
      "The templates are built into this Droplet, so this is a connection problem rather than an empty catalogue.",
    );
  });

  it("create dialog + its outcomes", () => {
    expect(ACCESS_COPY.templateCreateHeading).toBe("Create from a template");
    expect(ACCESS_COPY.templateCreateBody("Front Desk")).toBe(
      "Creates 'Front Desk' as an ordinary role. Nobody holds it until you assign someone, and you can edit or delete it any time.",
    );
    expect(ACCESS_COPY.templateCreateNameLabel).toBe("Role name");
    // Slug collisions are NOT errors server-side ("Front Desk" twice yields
    // `front-desk` then `front-desk-2`), so the hint says so instead of the
    // dashboard de-duplicating a name the operator chose.
    expect(ACCESS_COPY.templateCreateNameHint).toBe(
      "Two roles can share a name — each one still gets its own slug.",
    );
    expect(ACCESS_COPY.templateCreateSubmit).toBe("Create role");
    expect(ACCESS_COPY.templateCreated("Front Desk")).toBe(
      "'Front Desk' created — assign people when you're ready.",
    );
  });

  it("the 409 retry line says nothing was created", () => {
    // A CONCURRENT_MUTATION refusal applied NOTHING. Without that clause an
    // operator reads "try again" as "you may now have two".
    expect(ACCESS_COPY.templateRaceRetry).toBe(
      "Another change reached the box first, so nothing was created. Try again.",
    );
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
