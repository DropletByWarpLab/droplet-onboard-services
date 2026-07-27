/**
 * WARP-1532 (RBAC v2 T8) — the Access & Roles copy block.
 *
 * Ships VERBATIM from the design brief §12 (shared_brain content/brand/
 * handoffs/access/DESIGN-BRIEF.md), plus the handful of §4/§5-quoted strings
 * the surfaces render. One resolved substitution only: the `family` tier
 * displays as "Staff" (founder decision O-1 / brief §0.1) — the enforced
 * enum value stays `family` everywhere; only the label swaps.
 *
 * Do not edit these strings without a design-packet update — copy.test.ts
 * pins every one character-for-character.
 */
export const ACCESS_COPY = {
  // ── Chrome ──
  tab: "Roles & access",
  yourRoles: "Your roles",
  builtinRoles: "Built-in roles",
  peopleWithRole: "People with this role",
  memberCaption: "Only owners and admins can manage access.",
  emptyRoles:
    "No custom roles yet — the built-in roles cover everyone until you add one. Create a role to give a group of people exactly the access they need.",
  emptyPeopleInRole: "No one has this role yet — assign people to put it to work.",
  emptyConnectors: "No connectors set up yet — add one in Integrations.",

  // ── Starting points (Staff label per §0.1 / O-1) ──
  startAdmin: "Admin — can manage the box",
  startStaff: "Staff — everyday staff access",
  startGuest: "Guest — view-mostly, limited",

  // ── Builder helpers ──
  usageDefaults:
    "These are the defaults for everyone in this role. You can override them per person in People.",
  filesRow: "Set file access per department →",
  locksToggle: "May operate locks",
  chatAlwaysOn: "Chat is always available.",
  settingsAlwaysOn: "Everyone can reach their own settings.",
  homeAlwaysOn: "Home is where everyone lands.",
  toolAutoOff: (feature: string) => `Turned off with ${feature}.`,
  cloudConsequence:
    "This is the only setting that sends a person's chat with the assistant off this Droplet — to the cloud AI provider they choose. It's off by default.",
  floorBlockedNetwork: "Network changes are for admins.",
  // ── WARP-1585: declared feature dependencies ──
  // Documents has no surface of its own — it opens files that live in Files —
  // so a Documents grant with no Files grant grants nothing reachable. The
  // row is shown, disabled, WITH this reason: the same shape as `toolAutoOff`
  // one level up, and deliberately NOT a padlock (§13 reserves Lock for
  // floor-blocked-with-reason, which this is not — the operator can clear
  // this one themselves by turning Files on).
  // Authored here on the T9 precedent (`inviteRolesDegraded`): no §12 string
  // exists for a dependency block. Flagged for design-packet ratification.
  docsNeedsFiles: "Documents open from your file libraries — turn Files on to include them.",
  builderSubline: "What people with this role can see, do, and use.",
  cloudModelsToggle: "Let this role's assistant use cloud models",
  offBoxHeader: "Reaching outside your Droplet",
  connectorsPHI: "Some connectors include protected health information.",
  connectorHint:
    "Read shows the assistant patient and schedule data; write lets it make changes, always with a confirmation step.",
  openIntegrations: "Open Integrations →",

  // ── Guardrails ──
  ownerRowMeta: "Full control · can't be changed",
  ownerDetailNote: "The owner always has full control of this Droplet.",
  ownerTooltip: "The owner has full control and can't be changed here.",
  selfLockout: "You can't remove your own access to this panel.",
  lastAdmin:
    "This is the last person who can manage access — give someone else an admin role first.",
  manageRolesLink: "Manage roles →",
  rankCap: "You can only assign access at or below your own level.",
  cloudConfirm: (role: string) =>
    `Let ${role}'s assistant use cloud models? This is the only setting that sends a person's chat messages off this Droplet. Turn it off any time.`,
  sessionRevoke: (name: string) =>
    `Saved. Applying now — this signs ${name} out of their other sessions and the new access takes effect immediately.`,
  deleteRoleUnused: (role: string) =>
    `Delete the '${role}' role? People can't be assigned to it afterwards. This doesn't change anyone's access right now.`,
  deleteRoleInUse: (n: number) => `In use by ${n} people — reassign them first.`,
  reassignPeopleLink: "Reassign people →",

  // ── Archive / restore (WARP-1560) ──
  // The packet's own archive body (prototype access-app.jsx), whole again.
  // T8 shipped it with the second sentence CUT because no restore surface
  // existed yet and §12 never promises an affordance you can't reach; the
  // surface exists now, so the promise is honest and goes back in.
  archiveRole:
    "Archived roles can't be assigned but keep their settings. You can restore them any time.",
  // WARP-1560-authored — the packet has no restore string (same footing as
  // `docsNeedsFiles` / `inviteRolesDegraded` below; flagged for packet
  // ratification). Mirrors the archive + delete bodies: consequence, then
  // reassurance. That last sentence is load-bearing rather than polite —
  // archive is NOT revoke (effective-access.service.ts deliberately never
  // reads `state`), so people holding an archived role never lost access
  // and therefore cannot "regain" it. Departments' restore body says the
  // opposite, correctly, because archiving a department really does take
  // its members' access away.
  restoreRole:
    "Restored roles can be assigned again, and their usage defaults start applying again. This doesn't change anyone's access right now.",
  archivedRoles: "Archived roles",
  archived: "Archived",
  // The honest reason under the disabled Assign-people button — shown, not
  // hover-only, and text-first: §13 reserves Lock for floor-blocked levels,
  // which this is not (the operator can clear it themselves by restoring).
  archivedNotAssignable:
    "Archived roles can't be assigned — restore this one to put it back to work.",
  // `emptyRoles` claims "No custom roles yet", which stops being true the
  // moment every custom role is merely filed away rather than absent.
  emptyRolesAllArchived: "Every custom role is archived — restore one, or create a new role.",

  // ── Retained quota (WARP-1576) ──
  // Clearing a role's storage default deliberately pushes nothing (a cleared
  // default means "unmanaged", never "unlimited" — WARP-1531's semantics), so
  // the members who had no quota of their own stay on whatever Nextcloud
  // already enforces. The server returns the count precisely so this can be
  // said out loud; without it the operator gets silence where a consequence
  // happened. WARP-1576-authored on the ticket's own phrasing.
  retainedQuota: (n: number) =>
    n === 1
      ? "1 person keeps their current storage limit until it's changed."
      : `${n} people keep their current storage limit until it's changed.`,
  removePerson: (name: string) =>
    `Remove ${name}? They lose access to this Droplet immediately and are signed out.`,

  // ── Sync + system states (§12 Sync, §10 trios) ──
  applying: "Applying…",
  applied: "Applied",
  needsAttention: "Needs attention",
  unknownValue: "—",
  offlineBanner:
    "This Droplet is offline — access changes will apply when it's back. Current access still holds.",
  rolesErrorTitle: "Couldn't reach your Droplet",
  retry: "Retry",

  // ── Detail-pane notes (§4.1 / §4.2 quoted) ──
  builtinFixed: "Built-in roles are fixed. Create a custom role to change what a group can do.",
  serviceMeta: "System identities — not assignable",
  adminMeta: "Manages the box and its people",
  staffMeta: "Everyday staff access",
  guestMeta: "View-mostly, limited",

  // ── Invite modal (§7 / WARP-1533 T9) ──
  // T9-authored (no §12 string exists for the degraded picker): the honest
  // caption when custom roles can't load and the invite modal falls back to
  // built-in tiers only. Flagged for design-packet ratification.
  inviteRolesDegraded:
    "Couldn't load your custom roles — you can invite with the built-in roles for now.",
  // The role pickers' second optgroup label (person editor + invite modal).
  // Deliberately distinct from `builtinRoles` ("Built-in roles"), which is
  // Surface A's roles-list section header — keep both.
  builtIn: "Built-in",

  // ── Person editor (§6) ──
  addException: "+ Add an exception",
  exceptionsHint: "One-off grants or denials on top of the role. Most people never need one.",
  identityHint: "Set by the role's starting point — change the role, not this directly.",
  roleDefault: "Role default",
  effectiveAccessTitle: "Effective access",
  effectiveHint:
    "Resolved from tier → role grants → department rights → usage. Never more than the tier allows.",
} as const;
