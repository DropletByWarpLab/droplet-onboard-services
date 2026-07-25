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

  // ── Person editor (§6) ──
  addException: "+ Add an exception",
  exceptionsHint: "One-off grants or denials on top of the role. Most people never need one.",
  identityHint: "Set by the role's starting point — change the role, not this directly.",
  roleDefault: "Role default",
  effectiveAccessTitle: "Effective access",
  effectiveHint:
    "Resolved from tier → role grants → department rights → usage. Never more than the tier allows.",
} as const;
