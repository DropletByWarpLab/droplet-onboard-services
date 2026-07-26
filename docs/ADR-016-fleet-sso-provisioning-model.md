# ADR-016 — Fleet SSO provisioning model (per-box IdP federation vs central relay)

> **Status: Proposed — sign-off gated (Stefan).** Recommends **Option A:
> bring-your-own-IdP per customer + a Setup-wizard provisioning step** as the v1
> fleet model, with the **central hosted relay (Option C) explicitly deferred**.
> The open decision is A vs C. Tracked by **WARP-630**. Builds on ADR-013
> (built-in directory) and the per-box OIDC config in
> [`ONBOARDING_SSO_OIDC.md`](ONBOARDING_SSO_OIDC.md); the runtime provider
> discovery it assumes is the **in-flight WARP-629 (PR #403, in review)**.

## Context

External-IdP SSO (Google / Entra / Okta) shipped in #378 / #396 and is wired
**per box via env**: `DROPLET_SSO_<P>_{ISSUER,CLIENT_ID,CLIENT_SECRET,REDIRECT_URI}`
(`config.ts`), resolved by `getOidcProviderConfig()` and surfaced by
`enabledSsoProviders()` (`services/sso-oidc.service.ts`). WARP-629 (in flight, PR
#403) makes the login render only the providers a given box has configured. None
of this answers the
fleet question: **does SSO work for every Droplet as it comes online?**

It does not, for one load-bearing reason — the **OIDC redirect URI**:

- On `/authorize`, the box sends the IdP `redirect_uri = https://<box>/api/sso/oidc/callback`
  (`buildAuthorizeRequest`, from the env value). The IdP **only honours a
  redirect URI that is pre-registered** on the OAuth client; anything else is
  rejected (`redirect_uri_mismatch`). `config.ts` documents this in the
  `DROPLET_SSO_*` block: *"REDIRECT_URI must exactly match the redirect
  registered at the IdP."*
- **Google specifically** forbids, on the registered URI: wildcards
  (`https://*.warp-lab.com/...`), raw IP addresses, and non-public hosts
  (`.local`, private ranges). It must be a fully-qualified HTTPS URL on a public
  domain. There is also a per-client cap on the number of redirect URIs.

Consequences that follow directly:

1. **You cannot pre-register a fleet of unknown future box hostnames** in one
   OAuth client, and you cannot wildcard them. So a single Warp-owned Google app
   shared by all boxes does **not** scale.
2. **Home / LAN boxes** (reached at `192.168.x.x` or `*.local`) cannot be a valid
   Google redirect target **at all**.
3. **Nothing in onboarding provisions SSO.** A box flashes → `setup.sh` →
   wizard → registers with the portal, all with **zero** `DROPLET_SSO_*`. SSO
   stays dark until that specific box is hand-configured.

What *is* shareable vs per-box:

| Config | Fleet-shareable? |
|---|---|
| `ISSUER` (`https://accounts.google.com`, etc.) | ✅ identical everywhere |
| `CLIENT_ID` / `CLIENT_SECRET` | ⚠️ only if the redirect problem is solved centrally |
| `REDIRECT_URI` | ❌ inherently unique per box |

This collides with the product's **local-first / "nothing leaves the box"**
positioning (the login footer literally says so), so the fleet model is a
deliberate architecture choice, not a default.

## Decision (Proposed)

Adopt **Option A — bring-your-own-IdP per customer, provisioned at setup** as the
v1 fleet model:

- SSO is a **per-organization federation**: a customer connects their box(es) to
  **their own** Google Workspace / Entra tenant / Okta org and registers that
  box's redirect URI in **their** IdP. Warp ships no IdP credentials.
- A **Setup-wizard step "Connect your identity provider"** (WARP-630) captures
  issuer / client-id / client-secret + the box's external hostname, **derives the
  exact `REDIRECT_URI`**, shows the operator what to register at the IdP, writes
  `DROPLET_SSO_<P>_*` to `.env`, and restarts the orchestrator once to load them.
  Runtime discovery (WARP-629, in flight) then lights the button on that box
  only. (Why a write-through + restart is acceptable here — and not in conflict
  with the WireGuard-endpoint ruling — is spelled out below.)
- **Prerequisite, enforced:** a real public hostname + trusted HTTPS. The wizard
  validates this and, on a raw-IP / `.local` box, **hides the IdP step** with a
  clear "SSO needs a public hostname" message rather than offering a flow that
  will 400.
- **Per-persona:** the home/LAN deployment shape does **not** offer external SSO;
  its path is the built-in argon2id directory password login (ADR-013) +
  passkeys (#377), which is fully self-contained and air-gap-safe. The business
  shape offers the IdP step.

**On `.env` write-through + restart (vs the WireGuard-endpoint ruling).** The
Setup-wizard addendum rated "write-through to `.env` + restart" a **"Hard no"**
for the WireGuard endpoint host, choosing a restart-free runtime fallback
instead. That ruling stands and is **not** contradicted here; the cases differ on
the two points that drove it:

- **SSO config is secret.** `CLIENT_SECRET` must live in `.env` per the
  secrets-only-via-`.env` rule (no DB/Settings model for secrets); the WireGuard
  endpoint host is non-secret.
- **No runtime-derivable source.** The WireGuard endpoint comes from the box's
  provisioned named address (`<name>.droplet-us.com`, ADR-025A in `droplet-fleet-hq`) with zero writes;
  a customer-pasted issuer / client-id / secret has no equivalent source — it
  must be persisted from operator input.
- **One-time provisioning, not a recurring toggle.** This is a single setup-time
  write + restart per box, not a settings surface flipped repeatedly, so the
  "worst UX" objection (a restart on *every* settings change) does not apply.

If the addendum's generic `Settings`-overlay (its option (b)) later lands, SSO's
*non-secret* fields could move onto it; the secret stays in `.env` regardless.
Follow-up, not a v1 blocker.

**Central hosted relay (Option C) is deferred**, not adopted. Revisit only if a
**managed / zero-touch SSO tier** is pursued, as its own ADR.

## Consequences

- **Preserves local-first.** No Warp-Lab-hosted component enters the login path;
  there is no fleet-wide credential or relay to operate or breach. Each box
  remains independently authoritative (ADR-013).
- **Per-deployment setup cost.** Each business customer does standard IdP work
  (create an OAuth client, register the box's redirect URI). The wizard reduces
  this to "paste three values + register one URL," but it is not zero-touch.
- **Hard dependency on box addressability.** A business box must be reachable at a
  stable public HTTPS hostname for Google/Entra to redirect to it. This couples
  fleet SSO to the (separate) networking/cert story; ADR-016 makes that
  prerequisite explicit rather than implicit.
- **Home users get no Google button — by design.** That is correct for the
  persona and avoids a permanently-broken affordance.
- **Build scope (WARP-630):** the wizard step, redirect-URI derivation + display,
  the hostname/HTTPS setup check, persona gating, and an operator runbook.
- **No change to the OIDC core.** The relying-party flow, account-linking, and
  `enabledSsoProviders()` discovery are unchanged; this ADR is purely about *how
  each box gets configured*.

## Alternatives considered

- **Option B — one shared Warp OAuth client, every box's redirect URI registered
  in it. REJECTED.** Defeated by Google's no-wildcard rule + the redirect-URI
  cap: you cannot enumerate unknown future hostnames, and rotating one shared
  client secret across the fleet is a blast-radius and operational hazard.
- **Option C — central hosted redirect relay** (one Warp OAuth app →
  `https://auth.warp-lab.com/callback` → forward to the box keyed by signed
  `state`). **DEFERRED.** It is the only true "one setup, all boxes" design and
  the right answer **iff** Warp offers a managed tier — but it injects a
  Warp-operated cloud service into every sign-in, which contradicts the
  local-first promise, adds an availability dependency and an attractive attack
  surface, and is real infra to build/run. Out of scope for v1; its own ADR if
  pursued.
- **Do nothing (manual `.env` per box). REJECTED as the product answer** — it
  works for a one-off but isn't a repeatable fleet story and invites
  copy-paste/secret-handling mistakes on customer boxes.

## Open questions (for sign-off)

1. **A vs C** — is a managed zero-touch SSO tier on the roadmap? If yes, schedule
   the Option-C relay ADR; if no, ratify A and close.
2. **Hostname/cert ownership** — does the customer bring DNS + cert, or does Warp
   provide a per-box subdomain (e.g. `<box-id>.boxes.warp-lab.com`) + ACME? The
   latter is a lighter Option-A variant that still avoids a relay in the auth
   path; worth a follow-up.
3. **Home-shape stance** — confirm external SSO is intentionally unavailable on
   LAN-only boxes (password + passkeys only).

## References

- [`ONBOARDING_SSO_OIDC.md`](ONBOARDING_SSO_OIDC.md) — per-box OIDC config + the
  redirect-URI rule (quoted above from `config.ts`).
- ADR-013 (built-in directory); WARP-629 / PR #403 — runtime provider discovery
  (**in flight, in review**); WARP-630 (this ADR's implementation).
- `apps/orchestrator/src/services/sso-oidc.service.ts`,
  `apps/orchestrator/src/routes/sso.ts`, `apps/orchestrator/src/config.ts`.
