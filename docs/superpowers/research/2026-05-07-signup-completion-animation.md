# Signup completion animation + token-based invite flow — research

**Date:** 2026-05-07
**Tickets:** [WARP-216](https://warp-lab.atlassian.net/browse/WARP-216) (animation component), [WARP-217](https://warp-lab.atlassian.net/browse/WARP-217) (token-based invite flow, blocked by 216)
**Author:** Claude (controller session)

This document captures the research, prior-art audit, and design decisions made before implementing the signup completion flourish + token-based user invite flow. It is intentionally written for **future Claude sessions** that may extend, refactor, or debug either feature.

---

## 1. The original problem

A first-time admin who completes the `/setup` flow ends up on a screen with:

1. A static green check icon (Lucide `<Check />`).
2. A "Sign In" button that pushes them to `/login` — even though the previous step already auto-logged them in via `loginUser(username, password)` (see [setup/page.tsx](../../../apps/web-dashboard/src/app/setup/page.tsx) ~line 86).

This is two clicks and a redundant credential prompt where there should be zero. The user asked for a fluid, modern completion animation that auto-redirects to `/`.

**Secondary problem — the "Invite user" form is not a real invite.** The Users page's "Invite user" button (`/users`) opens a form where the **admin** types the new user's password. That password then has to be transmitted to the invitee out-of-band (Slack, email, paper). There is no:

- Shareable invite URL.
- Self-service password setup by the invitee.
- Single-use token semantics.
- Acceptance audit trail.

Hence WARP-217 — a real token-based invite flow that ends in the same flourish.

---

## 2. Prior art in this repo

### 2.1 The setup flow already auto-logs the admin in

[`apps/web-dashboard/src/app/setup/page.tsx`](../../../apps/web-dashboard/src/app/setup/page.tsx) — `handleCreateAccount`:

```ts
await setupAdmin(username, password, displayName);
await loginUser(username, password);   // ← session already valid here
completeSetup();
setStep("discovery");
```

By the time the user reaches `step === "done"`, the JWT cookie is set. The redirect to `/login` is purely cosmetic — and harmful. Removing it is safe.

### 2.2 Multi-admin is already supported

`apps/orchestrator/src/services/jwt.service.ts` defines `roleFromGroups()` which maps Nextcloud group memberships → `"admin" | "user"`. The `/api/users/...` admin routes (created via `ncCreateUser`) accept a `groups` argument that decides the role. The dashboard Users page already gates with `isAdmin === false` → "Admin access required" empty state. So **multiple admins are first-class** today; what was missing was an invite UX, not a permission model.

### 2.3 Single-use token precedent: `PairingCode`

`apps/orchestrator/prisma/schema.prisma`:

```prisma
model PairingCode {
  id        String   @id @default(uuid())
  code      String   @unique
  userId    String
  expiresAt DateTime
  used      Boolean  @default(false)
  claimedBy String?  // DeviceClient.id
  createdAt DateTime @default(now())

  @@index([code])
  @@index([expiresAt])
}
```

This is the canonical pattern for short-lived single-use tokens in this repo. `UserInvite` mirrors it with the addition of `acceptedAt`, `revokedAt`, `acceptedFrom` (audit), `displayName`, `email`, and `role`. Use **the same constant-time comparison** that pairing-code consumption uses (`crypto.timingSafeEqual`).

### 2.4 Existing animation vocabulary

`apps/web-dashboard/src/app/globals.css` already defines these CSS keyframes (no extra deps required):

| Class | Keyframe | Used in |
|---|---|---|
| `animate-aurora` | `aurora-drift` | (background ambient) |
| `animate-fade-rise` | `fade-rise` | login/dashboard cards |
| `animate-shimmer` | `shimmer` | skeleton placeholders |
| `animate-slide-up` | `slide-up` | toasts |
| `animate-scan-pulse` | `scan-pulse` | setup discovery wifi pulse |
| `animate-device-appear` | `device-appear` | discovered devices grid |

The signup flourish needs **sequenced, multi-phase choreography** (check → logo → text → progress) — the kind that is awkward in pure CSS and trivial in framer-motion. See §3 for the tech-choice rationale.

### 2.5 Design tokens (must use, never bypass)

`apps/web-dashboard/tailwind.config.ts` exposes:

- **Surfaces:** `bg-surface-{primary,secondary,tertiary,elevated}` (CSS vars; auto dark-mode).
- **Labels:** `text-label-{primary,secondary,tertiary,quaternary}`.
- **Accent:** `bg-accent`, `text-accent`, `bg-accent/10` for soft tints.
- **Semantic:** `bg-system-{red,orange,green,blue}` (use `/10` for soft fills).
- **Typography classes** (in globals.css): `type-large-title`, `type-title-1`, `type-headline`, `type-body`, `type-subheadline`, `type-footnote`, `type-caption-1`.
- **Component classes:** `dp-card`, `dp-row`, `dp-group`, `dp-input`, `dp-btn-primary`.

The UI/UX harness role hard-fails on hardcoded hex / rgb / px font-sizes (see [.superpowers/agents/ui-ux.md](../../../.superpowers/agents/ui-ux.md) §"Design-token adherence"). All animation chrome must compose from these tokens.

### 2.6 Logo asset

`apps/web-dashboard/src/components/DropletMark.tsx` — used as `<DropletMark size={48} className="text-accent" />` on both `/setup` welcome screen and `/login`. Prefer this over the static `/logo.svg` — it accepts `size` + `className` and inherits color from `currentColor`, making the animation theming trivial.

---

## 3. Animation tech choice

User asked for the "best animation tech, widely used."

**Decision: `framer-motion` (v11+).** Added as a `apps/web-dashboard/package.json` dependency for WARP-216.

### Why framer-motion over alternatives

| Option | Pro | Con | Verdict |
|---|---|---|---|
| **CSS keyframes (existing pattern)** | Zero deps, already in repo. | Sequenced choreography (check → logo → text → progress) requires nested `animation-delay`s and is fragile to tweak. No `useReducedMotion()` helper. No imperative onComplete. | ❌ awkward for this shape |
| **framer-motion** | Industry standard for React; declarative `variants` + `AnimatePresence`; built-in `useReducedMotion`; spring physics; ~50KB gzipped. | New dep. | ✅ chosen |
| **GSAP** | Powerful timeline. | License complexity (GSAP Business for some plugins); imperative-first; more friction with React 18 concurrent mode. | ❌ overkill |
| **react-spring** | Solid physics. | Smaller community than framer-motion in 2026; awkward declarative-vs-imperative split. | ❌ no advantage over fm |
| **Lottie (After Effects export)** | Designer-driven. | Adds a runtime + JSON asset pipeline; can't easily theme via design tokens; opacity to engineering review. | ❌ wrong fit |

### Checkmark drawing technique

The classic "drawn check" effect uses **SVG `stroke-dasharray` + `stroke-dashoffset`**. In framer-motion this is expressed as `pathLength: 0 → 1` on a `motion.path`, which under the hood animates `stroke-dashoffset`. This is the same technique GitHub, Stripe, and Vercel use for completion checks.

```tsx
<motion.path
  d="M5 13 L10 18 L19 8"
  fill="none"
  stroke="currentColor"
  strokeWidth={3}
  strokeLinecap="round"
  strokeLinejoin="round"
  initial={{ pathLength: 0 }}
  animate={{ pathLength: 1 }}
  transition={{ duration: 0.45, ease: "easeOut" }}
/>
```

### Phase choreography

| Phase | t (ms) | Motion |
|---|---|---|
| 1 | 0–500 | Ring `scale 0.8 → 1`, `opacity 0 → 1`; check `pathLength 0 → 1`. |
| 2 | 500–900 | Check `opacity 1 → 0`; logo `scale 0.85 → 1` spring (`stiffness 220, damping 20`), `opacity 0 → 1`. |
| 3 | 900–1200 | Welcome text `y: 8 → 0`, `opacity 0 → 1`; subtitle 80ms-staggered. |
| 4 | 1200–2500 | Progress bar `scaleX 1 → 0` linear; on complete fire `onComplete` + `router.push(redirectTo)`. |

`useReducedMotion()` returns `true` → skip phases 1–3 and render the final state immediately, then redirect after 1.5s.

---

## 4. Token-based invite flow design (WARP-217)

### 4.1 Why not just email-link?

This is a LAN edge appliance (see ADR-002 home-user persona). There is no guarantee the Droplet has SMTP set up. So the v1 flow is:

1. Admin generates link.
2. Admin copies/QR-shares it via whatever channel they like.
3. Invitee opens it on the same LAN (or via remote-access if configured).

Email delivery is explicitly out of scope (deferred follow-up).

### 4.2 Token format

URL-safe base64, 32 random bytes (`crypto.randomBytes(32).toString("base64url")`) = 43 chars. Match shape `^[A-Za-z0-9_-]{40,}$` in tests.

**Constant-time comparison required.** `=` operator on a string allows timing oracles. Use `crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(stored))` after length check.

### 4.3 State machine

```
Pending → Accepted   (POST /accept/:token with valid password)
Pending → Expired    (now() > expiresAt)
Pending → Revoked    (admin DELETE /invites/:token)
```

Once Accepted, Expired, or Revoked, the token is dead. `POST /accept/:token` returns 410 Gone (used/expired) or 404 (revoked). 410 is the right HTTP code for "this resource existed and is now permanently gone" per RFC 7231 §6.5.9.

### 4.4 Why per-invite role

Some Droplet households want one admin (the family IT person) and N read-only users (kids, guests). The invite role select makes that explicit at invite time, instead of post-hoc in a settings panel. Accept-time role is what gets passed to `ncCreateUser`'s `groups` argument.

### 4.5 Why not reuse `/setup` route for invitees

The `/setup` route is gated by `ncCheckSetupRequired()` — once any admin exists, it short-circuits. An invitee accepting an invite is creating their own non-bootstrap account; semantics are different. Hence a dedicated `/invite/[token]` page that calls a different endpoint (`POST /api/auth/invites/accept/:token`) and reuses the `WelcomeFlourish` for the post-accept moment.

### 4.6 Audit fields

`createdBy`, `acceptedFrom` (IP), `acceptedAt`, `revokedAt`, `expiresAt`. The Users page's "Pending invites" section reads `createdBy` so admins can see "who invited whom." This is cheap to add and avoids a future migration.

---

## 5. Test patterns observed in this repo

(For Dev/QA agents implementing the tickets — match these conventions.)

### 5.1 Orchestrator tests

- **Vitest globals** (`describe`, `it`, `expect`) — no manual import.
- Colocated `*.test.ts` next to the route file.
- **supertest** for HTTP routes; build the Express app via existing `apps/orchestrator/src/app.ts` factory.
- Mock Nextcloud via the patterns in `nextcloud.client.ts` callers — fixture-mode env var + module-level mock (see WARP-44 and WARP-205 for examples).
- Prisma: use the test database from `DATABASE_URL` env in `apps/orchestrator/.env.test`; truncate tables in `beforeEach`.

### 5.2 Dashboard tests

- **Vitest + @testing-library/react** + **jsdom**.
- `vi.useFakeTimers()` for any redirect-after-Xms assertion.
- Mock `useRouter` from `next/navigation` (vitest mock factory).
- For framer-motion components: `transition: { duration: 0 }` via test prop OR mock `useReducedMotion` to return `true`. The latter is cleaner — no chance of test flake on slow CI.

### 5.3 Migration hygiene (per `.superpowers/agents/dev.md`)

- Generate via `npx prisma migrate dev --create-only`.
- Rename the timestamp to the ticket's canonical date so ordering stays stable across branches: `prisma/migrations/2026-05-07_warp_217_user_invite/`.
- Re-run the migration a second time in dev and confirm row count is stable. Document this in the Dev's "Handoff notes."

---

## 6. UX heuristics enforced by the harness

From [.superpowers/agents/ui-ux.md](../../../.superpowers/agents/ui-ux.md) — these are non-negotiable for dashboard tickets:

- **Plain-language copy.** No "sync your account", "connect to cloud" — this is a LAN-only device.
- **No raw error codes** in the UI. Every typed error gets a human translation.
- **Optimistic mutations** with rollback (where applicable — invite generation is one-shot, but invite revoke is optimistic).
- **Tokens, never hex.** Hard fail on `color:\s*#`, `background-color:\s*#`, `font-size:\s*[0-9]`.
- **Reduced-motion.** If user prefers reduced motion, animation degrades to final state — never "flash and disappear."

---

## 7. What NOT to do

Things considered and rejected:

1. **Confetti / particle effects.** Off-brand; the persona is "calm utility appliance," not "consumer launch screen."
2. **Sound on completion.** Edge appliance might be in a server closet; sound is intrusive and untestable.
3. **Re-opening `/login` after setup.** The whole point is removing the redundant credential prompt.
4. **Cookie-only auth check on the invite-accept page.** The page must be accessible to a fully logged-out invitee — endpoint is public, gated by the token itself.
5. **Email delivery in v1.** Out of scope; admin shares the link manually. SMTP-on-Droplet is its own design space.
6. **Admin-impersonates-invitee acceptance.** Tempting because it looks simpler; rejected because the invitee never sets their own password and we lose the audit trail. Same anti-pattern as the existing form being replaced.
7. **GSAP / Lottie / any non-React-first lib.** See §3 table.
8. **Storing the invite token plaintext anywhere outside the DB row.** Don't log it; don't include it in error messages.

---

## 8. File map (for whoever picks this up)

### WARP-216 (animation, no orchestrator changes)

```
apps/web-dashboard/
├── package.json                                  # + framer-motion
├── src/
│   ├── components/auth/WelcomeFlourish.tsx       # NEW
│   ├── app/setup/page.tsx                        # MODIFIED — replace step="done" block; remove /login redirect
│   └── __tests__/
│       ├── WelcomeFlourish.test.tsx              # NEW
│       └── setup.flow.test.tsx                   # NEW (or extend existing)
docs/superpowers/research/2026-05-07-signup-completion-animation.md  # this file
```

### WARP-217 (invite flow, full-stack)

```
apps/orchestrator/
├── prisma/
│   ├── schema.prisma                             # + UserInvite model
│   └── migrations/2026-05-07_warp_217_user_invite/migration.sql  # NEW
├── src/
│   ├── routes/auth.ts                            # + 5 invite routes
│   ├── routes/auth.invites.test.ts               # NEW
│   └── services/invite.service.ts                # NEW (token gen + validation)

apps/web-dashboard/
├── src/
│   ├── lib/api.ts                                # + createInvite, listInvites, revokeInvite, getInvite, acceptInvite
│   ├── app/users/page.tsx                        # MODIFIED — replace inline form with invite-link modal + pending list
│   ├── app/invite/[token]/page.tsx               # NEW
│   └── __tests__/
│       ├── invite.accept.test.tsx                # NEW
│       └── users.invite.test.tsx                 # NEW
```

---

## 9. Future Claude: where to push this further

Likely follow-ups (do NOT bundle into either ticket — these are their own scope):

1. **SMTP delivery of invites.** Optional integration with the Droplet's notification stack (`apps/orchestrator/src/services/notifications.service.ts`). Add `NOTIFY_INVITE_EMAIL` env var. Falls back to copy-link if unset.
2. **Invite link signed with a short JWT** instead of opaque token. Pro: stateless validation. Con: revocation is harder (need a denylist, which is what we already have).
3. **Magic-link login** (re-using the same pattern). Different state machine — the user already exists. Not part of these tickets.
4. **Confetti hook** behind a feature flag for users who explicitly want it. Same `useReducedMotion()` gate.
5. **Per-Droplet branded logo upload** so the flourish shows the household's chosen mark, not just `<DropletMark />`. Settings page work.

---

## 10. Cross-references

- [WARP-216 ticket](https://warp-lab.atlassian.net/browse/WARP-216)
- [WARP-217 ticket](https://warp-lab.atlassian.net/browse/WARP-217)
- [.superpowers/agents/dev.md](../../../.superpowers/agents/dev.md)
- [.superpowers/agents/ui-ux.md](../../../.superpowers/agents/ui-ux.md)
- [.superpowers/agents/qa.md](../../../.superpowers/agents/qa.md)
- [.superpowers/agents/manager.md](../../../.superpowers/agents/manager.md)
- [ADR-002 — Network page home-user supervision](../../ADR-002-network-page-home-user-supervision.md) (persona authority)
- [setup/page.tsx](../../../apps/web-dashboard/src/app/setup/page.tsx) (existing flow being replaced)
- [auth.ts route](../../../apps/orchestrator/src/routes/auth.ts) (where invite routes will land)
- [PairingCode model](../../../apps/orchestrator/prisma/schema.prisma) (token semantics precedent)
