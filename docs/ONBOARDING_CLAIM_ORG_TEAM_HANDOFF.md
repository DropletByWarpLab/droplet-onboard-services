# Onboarding — Claim / Org / Team · design breakdown for Claude Design

> **Why this doc exists.** We're keeping the **9 shipped setup-wizard steps**
> (welcome → account → internet → storage → discovery → cameras → vpn → ai →
> done) and adding the **3 net-new steps** from the new login/onboarding handoff
> (`warp lab/droplet login walkthrough re/onboarding-handoff/`): **Claim**,
> **Organization**, **Team**. This is the spec Claude Design needs to draw those
> 3 (plus 2 small deltas to existing steps) at the same fidelity as the rest of
> the walkthrough. Once Claude Design returns the finished walkthrough, it comes
> back here and engineering builds + PRs it.
>
> Source of the visuals: `onboarding-handoff/src/OnbWizard.jsx`
> (`WizClaim`, `WizOrg`, `WizTeam`). Source of behavior: `dashboard/FEATURES.md`
> + `droplet-onboard-services`. The Aurora **login** is already built
> (PR #370); this doc is only the **wizard** additions.

---

## 1 · Where the 3 steps slot in

The handoff drew a standalone 6-step flow (Claim/Network/Org/Account/Team/
Finish). We are **not** replacing the shipped wizard with it — `internet`,
`storage`, `discovery`, `cameras`, `vpn`, `ai` are wired to real backends and
tested. Instead we **weave the 3 genuinely-new steps into the existing order**:

```
welcome → CLAIM → account → ORG → internet → storage → discovery → cameras → vpn → ai → TEAM → done
            ▲ new           ▲ new                                              ▲ new
```

Rationale:
- **Claim is first** (after the welcome splash): you bind the appliance to your
  workspace before creating any account. Nothing else can happen until it's claimed.
- **Org right after account**: the owner account exists, now name the workspace
  it owns. (Account stays where it is — every later step needs an authenticated
  session.)
- **Team near the end** (before `done`): "you're set up — now bring people in."
  Inviting teammates is the natural last action before the finish flourish.

### Step gates (extends the table in `SETUP_WIZARD_WALKTHROUGH.md`)

| Step | Skippable? | Why |
|---|---|---|
| claim | **No** | The box is useless unless claimed; gates everything after. |
| org | **No** | The workspace name/slug is referenced by later steps + the dashboard. |
| team | Yes ("I'll invite people later") | Solo owner is a valid end state; invites can come from People later. |

---

## 2 · Step: **Claim**  *(new — slots first, after welcome)*

**Purpose.** Confirm the detected appliance is yours and bind it to your
workspace. The customer reads the claim code off the **PyPortal lid display**
and types/confirms it.

**Fields / inputs.**
- Read-only **hardware card**: compute, storage, network, display (from
  `GET /setup/appliance`).
- **Claim code** input — grouped, formatted (e.g. `DRPL · 7K2Q · 9F4M`),
  shown on the PyPortal.
- **Supply-chain** reassurance chip: TAA compliant · NDAA §889 clear.

**Backend contract.** *(net-new — tracked by the `onb-claim-hardware` scaffold PR)*
- `GET /setup/appliance` → `{ appliance_id, compute, storage, network, display, supply_chain }`
  (shape per `FEATURES.md §9`). UI is read-only.
- `POST /setup/claim { code }` → binds appliance to workspace. Rate-limited; code
  rotates; the PyPortal renders the live code (Adafruit USB vendor `239a`).

**UI structure** (from `WizClaim`):
- `WizHead` kicker "Step 1" → title "We found your Droplet" → sub.
- Appliance card: aurora-badge drop icon + name + `appliance_id` (mono) + "Detected on LAN" status chip; 2×2 spec grid (compute/storage/network/display).
- Claim-code field with hint "Shown on the PyPortal display on the front of the unit."
- Success chip (green): supply-chain verified.

**Edge cases.**
- Appliance unreachable / `GET /setup/appliance` 5xx → "We can't see your Droplet yet" + retry; don't let the customer past.
- Wrong code → inline error, decrement a rate-limit budget, never reveal the real code.
- Already claimed (re-run) → short-circuit to the next step with an "Already claimed" note.

**Token mapping.** aurora badge → `.aurora-brand`; card → `dp-card`/`dp-group`; status chip → `dp-status-chip`; success chip → `--color-system-green` family; mono → `--font-mono`; title → `type-title-1`.

---

## 3 · Step: **Organization**  *(new — slots after account)*

**Purpose.** Name the single workspace ("company brain") everyone joins.

**Fields / inputs.**
- Logo upload (optional, on-box only).
- Workspace **name**.
- Workspace **URL slug** — `droplet.local/<slug>` (mDNS host is `Droplet.local`).
- **Time zone**, **Industry**, **Company size** (selects).

**Backend contract.** *(net-new — `onb-org-owner` scaffold PR)*
- `POST /setup/org { name, slug, tz, industry, size, logo }` → persist on encrypted NVMe.
- Slug reserves `droplet.local/<slug>`; validate `[a-z0-9-]`, uniqueness.
- Industry/size pick **local smart defaults only** (folder structure, example
  tools, camera policy) — **never sent off the box** (state this in the UI).

**UI structure** (from `WizOrg`):
- `WizHead` "Step 3" → "Create your workspace" → sub.
- Logo dropzone (dashed accent tile) beside the workspace-name field.
- Row: Workspace URL (`droplet.local /` prefix) + Time zone.
- Row: Industry + Company size.
- Footnote: "We use industry and size only to pick smart defaults … Nothing is sent off the box."

**Edge cases.**
- Slug taken / invalid → inline error under the field; block continue.
- Logo too large / wrong type → inline error; logo is optional so allow skip-of-logo.

**Token mapping.** dashed logo tile → `--color-accent-subtle` bg + `--color-accent` text; inputs → `dp-input`; prefix/suffix adornments per existing `StepShell` inputs; footnote → `type-caption-1 text-label-tertiary`.

---

## 4 · Step: **Team**  *(new — slots before done)*

**Purpose.** Invite teammates by email + role now, **or** sync the whole
directory over SSO. Roles map to what the AI may do on their behalf.

**Fields / inputs.**
- **Directory sync** banner → "Connect SSO" (Google Workspace / Microsoft Entra / Okta).
- **Invite row**: email + role select + "Add".
- **Pending-invite list** (avatar, name, email, role chip, remove).

**Backend contract.** *(net-new — `onb-team-roles` + `onb-sso-*` scaffold PRs)*
- `POST /people/invite { email, role }` — extends the existing
  `/api/auth/invites` flow. Email requires the Off-LAN "Outbound email" channel
  (ON by default, `FEATURES.md §8`).
- `POST /sso/directory/connect` then `/sso/directory/sync` — SCIM / directory
  mirror. Roles map to AI safety tiers (`FEATURES.md §6`).
- **Role-model decision needed** — see Open Questions.

**UI structure** (from `WizTeam`):
- `WizHead` "Step 5" → "Bring in your team" → sub.
- Accent "Sync your directory instead" banner + "Connect SSO" button.
- Invite-by-email row (email + role + Add).
- Invited list with per-row remove; footer "N invites ready · roles can be changed anytime in People → Roles."

**Edge cases.**
- Outbound-email channel OFF → disable email invites, explain, still allow SSO sync / skip.
- Duplicate email → inline dedupe.
- SSO connect fails → toast, keep manual invites working.

**Token mapping.** accent banner → `--color-accent-subtle` + `--color-accent`; role chips → the existing `--role-*` token family; avatars → existing People avatar styles.

---

## 5 · Deltas to existing steps (draw these too)

These aren't new steps but the handoff changes two existing ones — Claude Design
should produce the updated visuals so engineering can extend them:

- **Account step → add inline TOTP enrollment.** After name/email/password, an
  expandable "Two-factor authentication · Required for owners" card with a QR +
  6-digit confirm (from `WizAccount`). Backend `POST /auth/totp/enroll|verify`
  (`onb-totp-recovery` PR). Recovery codes shown once.
- **Internet step → add Wi-Fi + advanced reveal.** Today it's a bare placeholder
  (remote access is handled automatically by the box's named address over the
  ADR-025A relay (`droplet-fleet-hq`), not configured here). The
  handoff's `WizNetwork` adds SSID + Wi-Fi password + guest toggle, plus an
  "Advanced network setup (OpenWrt)" reveal (camera VLAN, static IP, WireGuard,
  full OpenWrt). Backend already exists in `services/routing` (ubus); this is
  wiring. Decide whether to merge into the existing `internet` step or add a
  sibling `network` step (recommend: extend `internet`, rename to "Network").

---

## 6 · Design system (so the 3 match the other 9)

- **Reuse existing wizard chrome:** `components/setup/StepShell.tsx` (title +
  subtitle + primary/skip footer), `ProgressDots.tsx`, `LearnMoreCard.tsx`
  ("how to use" callout). Don't reinvent — every step is
  `function Step({ onComplete, onSkip, ctx })`.
- **Tokens:** violet accent (`--color-accent`), `type-*` scale, `dp-card` /
  `dp-input` / `dp-btn-*`, `--role-*` for role chips, `--color-system-*` for
  status. The dark aurora flourish (claim badge, finish badge) is the new
  `.aurora-brand` utility shipped with the login PR — reuse it.
- **Each step teaches, not just configures** — keep the `LearnMoreCard` "how
  does this work?" pattern the shipped steps use.
- **Single-page state machine**, no router subroutes; customer always taps
  "Continue" (no auto-advance), matching the current wizard.

## 7 · What Claude Design should hand back

In the same package shape as the current handoff (a `reference.html` preview +
`src/` JSX lifting tokens/markup), the **3 new steps** (Claim, Org, Team) and the
**2 deltas** (Account TOTP, Internet/Network), rendered against the
**dashboard's** token names (`--color-*`, `dp-*`, `type-*`) — not the handoff's
standalone CSS vars — so engineering can lift them directly into
`apps/web-dashboard/src/components/setup/steps/`.

## 8 · Open questions for Stefan

1. **Role model.** Shipped roles are household (`owner/admin/family/guest`); the
   handoff assumes business (`owner/manager/member/viewer/guest`). The dashboard
   CSS already defines both. Which set governs Team/Org? (Tracked in the
   `onb-team-roles` PR / ADR-007 dual-workspace.)
2. **Network step.** Extend `internet` to add Wi-Fi/advanced, or add a separate
   `network` step? (Recommend: extend.)
3. **Hardware card.** The Claim card assumes PyPortal + UniFi 24-port + 3×1.5 TB
   RAID1. The live single-box differs — should the card render whatever
   `GET /setup/appliance` returns (recommended) rather than the handoff's fixed
   spec list?

---

*Status: spec for design. No code in this PR. Pairs with the Aurora login
(PR #370) and the onboarding-backend scaffold PRs (`docs/ONBOARDING_*`).*
