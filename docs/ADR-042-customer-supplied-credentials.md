# ADR-042: Customer-supplied API credentials — a third consent model, and who registers the vendor app

- **Status:** Proposed (2026-08-27). The Slack question in §7 is **not** decided here — it is Romain's, and [WARP-2373](https://warp-lab.atlassian.net/browse/WARP-2373) owns it.
- **Epic:** [WARP-2214](https://warp-lab.atlassian.net/browse/WARP-2214) · this ADR is [WARP-2295](https://warp-lab.atlassian.net/browse/WARP-2295)
- **Amends:** [ADR-041](ADR-041-cloud-connector-class.md) §5, which fixes *"delegated per-user authorization, not application-wide"* as the default posture for cloud connectors. That was the right ruling for Microsoft 365 and the cloud ERP tracks, where an OAuth authorization-code flow against a registered app is the only way in. It is not the shape any of the five SaaS vendors in WARP-2214 take, and §5 named only two models when there are three.
- **Answers:** the question every vendor story under WARP-2214 was independently re-asking — *what exactly does the owner paste, and does Warp Lab have to register anything?* — and the acceptance criterion on [WARP-2383](https://warp-lab.atlassian.net/browse/WARP-2383) that an ADR record the customer-owned-auth ruling.
- **Builds on:** ADR-041 (the cloud-connector class, all five of whose conditions still bind), ADR-012 (phone-home egress control), WARP-269 / WARP-268 (the default-deny egress registry and its runtime audit).
- **First consumers:** Stripe ([WARP-2215](https://warp-lab.atlassian.net/browse/WARP-2215)), HubSpot ([WARP-2317](https://warp-lab.atlassian.net/browse/WARP-2317)), Mailchimp ([WARP-2379](https://warp-lab.atlassian.net/browse/WARP-2379)), Shopify ([WARP-2296](https://warp-lab.atlassian.net/browse/WARP-2296)), Xero ([WARP-2383](https://warp-lab.atlassian.net/browse/WARP-2383)). The credential form they all render is [WARP-2275](https://warp-lab.atlassian.net/browse/WARP-2275); the descriptor they all register into is [WARP-2217](https://warp-lab.atlassian.net/browse/WARP-2217).

## Context

ADR-041 §5 settled how a cloud connector gets in: the owner signs in through the vendor's own OAuth flow, the box holds a delegated refresh token, and the access model mirrors the signed-in user's. That is honest, it is minimum-necessary by construction, and for Microsoft 365 it is the only mechanism Microsoft offers.

The five SaaS vendors WARP-2214 puts on those rails all diverge from it, and — this is the part worth recording — they diverge the *same way*. Every one of them lets the account owner **mint a credential in their own vendor console and paste it into the box**. Nobody signs in. No redirect happens. No Warp Lab identity appears anywhere in the trust path.

That is neither of the two models §5 named. It is not delegated-per-user: the credential belongs to the *account*, not to a person's session, and it keeps working after the person who created it closes the browser. It is not an application-wide secret we distribute: we mint nothing, ship nothing, and hold nothing on the customer's behalf. It is a third thing, with its own provisioning path, its own revocation path, and its own blast radius, and it deserves recording rather than being absorbed as a footnote.

**The finding that removed a subsystem from the plan came from vendor terms, not from code.** The v1 plan carried an OAuth authorization-code flow: a registered app, a client secret, a callback URL on the box, a consent screen. Reading each vendor's own documentation retired all of it:

- **Stripe** documents our exact architecture by name: *"If customers self-host your integration, Stripe Apps using the restricted API key authentication method is likely the best fit. It doesn't require you to store your secret key on untrusted servers."* Stripe's OAuth has no PKCE, so the alternative would have meant a `client_secret` on hardware we do not control (WARP-2215).
- **HubSpot** rules itself out on the same ground and more sharply: it does not support PKCE at all, so an OAuth integration is *definitionally* a distributed client secret. Private app tokens are available on every tier including Free (WARP-2317).
- **Mailchimp's** API Use Policy sanctions the key explicitly — *"You'll only access the API using OAuth or an API key"* — so there is nothing OAuth would buy (WARP-2379).
- **Shopify** removed admin-created custom apps on 2026-01-01, and the replacement is *better* for this shape: a merchant-owned Dev Dashboard app plus the client-credentials grant, which *"takes the least setup… with no redirect flow to implement"* (WARP-2296).
- **Xero** is the one that does not resolve cleanly, and §3 says so rather than rounding it off.

The tension worth stating rather than smoothing over is this. ADR-041 §5 preferred delegated authorization because *the box can never read what the signed-in user cannot* — the access model mirrors the customer's own. A pasted account credential gives that up. It is scoped by whatever the vendor's console lets the owner tick, which in Mailchimp's case is **nothing at all**: a Mailchimp API key is full account access, with no scope model to narrow. We are trading a structurally-bounded access model for one bounded by vendor UI. The compensation is real and it is not nothing — no secret of ours on customer hardware, no fleet-wide app identity, no consent screen we could be tempted to make vague — but it is a trade, and §5's reasoning does not simply carry over.

Second thing this ADR settles, because the epic cannot proceed without it and because it is the question that keeps getting re-asked once per connector: **who registers the vendor app.** ADR-041's providers never had to ask — Microsoft's answer is "you do", and there is no other. Among the seven integrations in flight, six need nothing from Warp Lab and exactly one does. Writing that down is the point; leaving it unwritten is why it recurs.

## Decision

**Customer-supplied credentials are a third consent and custody model, permitted under all five of ADR-041's conditions, on eight further conditions of their own.**

### 1. There are three consent models, not two

Every cloud connector uses exactly one of:

1. **Delegated per-user authorization** — the person signs in through the vendor's OAuth flow against a *registered* app; the box holds a delegated token and can read only what that person can. ADR-041 §5's default, and still the default. Microsoft 365, Salesforce, QuickBooks Online.
2. **Application-wide credential minted by Warp Lab** — **not permitted, and this ADR does not create it.** Named here only so the third model is not mistaken for it.
3. **Customer-supplied credential** — the data owner mints a credential inside their own vendor account, scoped by whatever that vendor's console offers, and pastes it into the box. The box holds it; Warp Lab holds nothing and appears nowhere in the trust path. This ADR authorises it.

A provider descriptor (WARP-2217) must declare which model it uses. It is not inferable from the field shapes, and a connector that silently changes model is a change to what the customer consented to.

### 2. What the owner pastes, per vendor

Vendor facts have a shelf life — prefixes, plan tiers and scope models change without notice — so each row is pinned to the ticket that verified it and carries the date it was verified. **A row older than its ticket's research is stale, not doctrine.** Re-verify before building against it.

| Vendor | What the owner pastes | Accepted shape | Full-privilege alternative to refuse | Scope granularity | Expires? | Verified |
|---|---|---|---|---|---|---|
| **Stripe** | A restricted API key created by the account owner | `rk_live_…` / `rk_test_…` | **Yes — `sk_live_` / `sk_test_`** | Per-resource None / Read / Write. The finest of the five. | **No.** 7-day dual-validity grace on rotation. | 2026-08-27, WARP-2215 |
| **HubSpot** | A private app access token, scopes ticked at creation by a **super admin** | `pat-…` family (e.g. `pat-na1-…`) | No — private app tokens are the only shape | Per-scope checkboxes at app creation | **No.** 7-day grace on rotation. 20 private apps per portal. | 2026-08-27, WARP-2317 |
| **Mailchimp** | An API key from Profile → Extras → API keys | `<secret>-<dc>` — the `-us14`-style datacentre suffix is **mandatory** | No — there is only one privilege level | **None. The key is full account access.** | **No.** | 2026-08-27, WARP-2379 |
| **Shopify** | Client id **and client secret** of a merchant-owned Dev Dashboard app, installed on the merchant's own store | client id + client secret; the box mints its own 24-hour token via the client-credentials grant | No — admin-created `shpat_` custom apps were removed 2026-01-01 | Access scopes on the app; Level 2 PII additionally gated on the store's **Grow** plan | The pasted credential does not expire; the **minted token lasts 24 h** (`expires_in: 86399`) and there is no refresh token — re-mint, never refresh | 2026-08-27, WARP-2296 |
| **Xero** | Either a **Custom Connection** (client id + secret, a *modified* client-credentials grant — see below) or the credentials of a **customer-owned PKCE app** | Path A: client id + secret. Path B: client id, **no secret exists for this app type** | No | OAuth scopes | Path A access tokens last **30 minutes** with no refresh token — re-request. The pasted credential does not expire. | 2026-08-27, WARP-2383 |

Two rows carry a hazard the others do not, and both are already ACs on their stories:

- **Mailchimp's host is a function of the credential.** `https://<dc>.api.mailchimp.com/3.0/` is assembled from the suffix at runtime, which is exactly the case `docs/SECURITY.md:183-185` says the static egress scanner cannot see. The registry entry is `kind: dynamic` with a `config_key`; the **code-side exact-host guard is the enforcement**, in the shape of `QBO_ALLOWED_API_HOSTS` + `UnsafeBaseUrlError` (`services/erp-connector/src/quickbooks/online-connector.ts:145-147,181-192`). Getting that backwards produces a green CI over an unconstrained host.
- **Xero's Custom Connection is not the plain client-credentials grant, and calling it that will mislead an implementer.** Xero's own documentation is explicit: Custom Connection apps *"use a modified version of client credentials which is not described on this page"*, and the ordinary grant *"cannot"* reach a Xero user's organisation data — plain `client_credentials` on a normal Xero app reaches **non-tenanted** app data only. A useful consequence of the modified variant: a Custom Connection *"can only make calls against one organisation so only the access token is required"*, so no `xero-tenant-id` header is needed. (`developer.xero.com`, verified 2026-08-27.)
- **Shopify is the only vendor whose paste includes a client secret** — the *merchant's* secret, for the *merchant's* app, on the *merchant's* box. That is compatible with §3 and it is why Shopify's own constraint that *"the app and the store belong to the same Shopify organization"* is a feature here rather than a limitation.

### 3. Warp Lab distributes no client secret, and v1 registers no app of its own

Two rules, and they are the load-bearing ones:

- **No box ever holds a credential Warp Lab minted on a customer's behalf.** Not an app-wide API key, not a shared service account, not a client secret of ours. A credential on a box was created by that customer, in that customer's account, and can be destroyed by that customer without asking us.
- **v1 ships no redirect-based consent flow against a Warp-Lab-registered app**, and therefore no callback URL we own, no consent screen we author, and no OAuth client registration to maintain.

State the residue honestly rather than claiming more than is true. "No OAuth" is a near-truth, not a truth:

- Shopify's client-credentials grant **is** OAuth 2.0. What it lacks is the authorization-code leg — no redirect, no consent screen, no app of ours.
- Xero **Path B is an authorization-code flow with PKCE**. It is permitted under this ADR because the app is registered by the *customer*, and because that app type has *"no option to generate a client secret"* — so nothing of ours is distributed either way. It is also **unproven**: whether Xero's developer portal will accept a non-public `https://<box>.local/callback` redirect URI is WARP-2383's first acceptance criterion, and if the answer is no, Path B does not exist and Xero ships to AU/NZ/UK/US only via Path A. Do not treat Path B as available until that spike lands.

The condition under which the v1 no-redirect rule has to change is named in §8.

### 4. A full-privilege credential is refused at the boundary, not discouraged in a guide

Where a vendor offers both a scoped and a full-privilege credential, the box **rejects the full-privilege one at intake**, with a typed error, before it is written anywhere.

For **Stripe this is contractual, not stylistic.** Stripe's plugin-security rule is that *businesses give you restricted API keys that start with the prefix `rk_`, not `sk_`*. The box must refuse anything matching `^sk_` — both `sk_live_` and `sk_test_`. A future reviewer must not relax this as a convenience; it is a term we are bound by, and the test exists so that relaxing it goes red (WARP-2362).

Per vendor, the check is:

| Vendor | Accept | Reject |
|---|---|---|
| Stripe | `^rk_(live\|test)_` | **`^sk_`** — contractual |
| HubSpot | the `pat-` private-app family | anything else, including a legacy portal API key |
| Mailchimp | a key carrying a `-<dc>` suffix | a key with **no** suffix — never default the datacentre, because that silently dials the wrong host |
| Shopify | a Dev Dashboard client id + secret pair | a `shpat_` admin-created token — the flow that minted it was removed 2026-01-01 and it cannot be re-created |
| Xero | Path A: client id + secret. Path B: client id with **no** secret field | a Path A config carrying a redirect URI, or a Path B config carrying a secret — these are disjoint variants, not optional fields |

Two limits of this rule, stated so nobody over-reads it:

- **It cannot help where the vendor has one privilege level.** Mailchimp's check is a *shape* check, not a privilege check, because a Mailchimp key is always full account access. The rule constrains what we accept; it cannot constrain what the vendor issues.
- **The rejection path is itself a secret-handling path.** An error message that interpolates the rejected key to be helpful is exactly the leak rule 19 forbids. The rejection emits no substring of the supplied value; `apps/orchestrator/src/lib/log-redaction.ts:44-45` is the machinery, and the audit row follows the SMTP template — `hasPassword: passwordEnc.length > 0`, a boolean and never the value (`apps/orchestrator/src/routes/settings-email.ts:176-193`).

### 5. Where the credential lives — under its own derived key, and not in `secretRef`

A customer-supplied credential is stored encrypted in `IntegrationConnection.providerTokensEnc` (`apps/orchestrator/prisma/schema.prisma:4396`), AAD-bound to the row id so a blob moved between rows fails closed. Non-secret connection facts — Mailchimp's datacentre suffix, Shopify's shop domain, Xero's path discriminator — go in `providerConfig` (`:4383`), never in the encrypted blob and never re-derived per request.

**Each vendor gets its own derivation function** in `apps/orchestrator/src/services/column-crypto.service.ts:81-103`. That file already separates `deriveM365TokenCacheKey()` from `deriveErpCloudTokenKey()` for exactly this reason — *"they are different vendors with different blast radii, and one compromised key must not open the other."* Reusing an existing label because it is convenient is the failure this clause forbids.

**No connector may become `secretRef`'s first writer.** `secretRef` is asserted in the schema and unimplemented — rows persist the literal `"<provider>:pending"` — and ADR-041 §4 already rules that *"a cloud connector must not become that model's first writer"*. Same for `ErpEntityCache` and `ErpSyncCursor`. **WARP-2028** owns building them; this ADR does not invent a store, and no vendor story may either.

The credential form itself is three-way, per the canonical template at `apps/orchestrator/src/routes/settings-email.ts:147-154`: **omit = keep, `""` = clear, a value = encrypt now.** Treating `""` as "keep" makes clearing a credential impossible, which is the mutation the test exists to catch.

### 6. Rotation, expiry and revocation — and the state that must survive them

**These credentials mostly do not expire.** Stripe restricted keys, HubSpot private app tokens and Mailchimp API keys have no expiry at all; Shopify's and Xero's pasted credentials do not expire either, only the short-lived tokens minted *from* them. That is a real consequence and it cuts against us: **there is no natural re-consent moment.** An OAuth grant re-surfaces itself when a refresh fails; a pasted key placed in 2026 will still be working in 2029 with nobody having reconsidered it. The connection surface has to make an old credential visible on its own, because nothing else will.

**Revocation is entirely the customer's and is outside our control.** The owner deletes the key in Stripe's dashboard, or removes the super admin who created the HubSpot app, or regenerates the Shopify app credentials, and the box finds out on its next call — never before. We cannot rotate what we did not mint. The setup guides (WARP-2298) have to say so plainly rather than implying we manage it.

Obligations that follow:

- **Rotation is accepted without losing history.** A re-paste replaces the stored blob and leaves the connection's identity, cursors and synced content intact. Stripe and HubSpot both grant a 7-day dual-validity window on rotation, so a rotation performed correctly is not an outage.
- **A scope change may cost a customer round-trip, and at Xero it is partly irreversible.** Editing a live Xero Custom Connection *"will be deactivated until it is re-authorised"*, and *"if you remove a broad scope from an existing connection, you won't be able to re-add it. Any broad scope you remove will be permanently replaced by granular scopes."* So narrowing scope is not a free operation the box can perform for the customer, and at least one vendor makes it one-way. Treat a scope change as a re-consent event, not a settings tweak. (`developer.xero.com`, verified 2026-08-27.)
- **A short-lived minted token is re-minted, never refreshed.** Shopify issues no refresh token (24 h) and Xero Path A issues none either (30 min). `refresh()` throws, in the manner of `online-connector.ts:497-509`, and the connector re-mints from the stored customer credential.
- **First vendor rejection of a previously-working credential moves the connection to an explicit "needs a new credential" state and pauses sync.** Already-synced content is untouched. It does not retry into a rate limit, and it does not silently return nothing.

**The state is the load-bearing part.** *"The customer revoked our key"* is not *"never configured"* and is not *"the owner deliberately disconnected"*. Collapsing them produces a hub that looks idle while it is broken — the exact failure `M365ConnectionState` (`apps/orchestrator/prisma/schema.prisma:4990-5012`) exists to prevent, and its docstring makes the argument in-tree: *"NEEDS_RECONNECT in particular MUST be distinguishable from DISCONNECTED: they look identical from 'is there a working token' but mean opposite things to the person reading the dashboard."* Credential-based connections inherit that requirement. `IntegrationStatus` (`:4306-4318`) has `NOT_CONFIGURED`, `DEGRADED` and `ERROR` but **no needs-new-credential member**; whichever story lands the first SaaS connector adds one rather than overloading `ERROR`. This is the repo's no-guessing-from-absence rule, and here it decides whether a broken integration is legible.

**An under-scoped key is a named failure, never an empty result.** Restricted-key scoping is the customer's decision, so the box *will* meet keys that authenticate fine and then deny one resource: a Stripe key without `charge_read`, a HubSpot portal whose super admin lost permission and returns `USER_DOES_NOT_HAVE_PERMISSIONS`, a Shopify app not approved for protected customer data returning HTTP 200 with nulls. Each renders as a distinct, remediable state carrying what the owner must go and tick. The standard is `online-connector.ts:60-68` and it is not negotiable: *"None of the three may ever render as an empty result."* `[]` from a bills query reads as "you owe nobody anything".

### 7. Who registers the vendor app — the doctrine

Three cases. The third is stated rather than left silent, because "nothing needs requesting" is an answer and an unwritten answer gets re-asked.

| Integration | Who provisions | Does Warp Lab register or publish anything? |
|---|---|---|
| Stripe | The account owner, in their own Stripe dashboard | **No** |
| HubSpot | The portal's super admin, in their own portal | **No** |
| Mailchimp | The account owner, in their own profile | **No** |
| Shopify | The merchant, in their own Dev Dashboard, installed on their own store | **No** — and a Warp-Lab-owned app with custom distribution is **explicitly rejected** in WARP-2296, because it would put our client secret on customer hardware |
| Xero | The customer, as a Custom Connection or their own PKCE app | **No** — Xero App Store certification is structurally unreachable for an appliance fleet (WARP-2383), not merely expensive |
| Atlassian | The customer creates an API token; their org admin enables Rovo MCP | **No** |
| Eaglesoft · Dentrix · Open Dental · QuickBooks Desktop | **Neither.** A credential inside the customer's own database on their own LAN | **Nothing to register** — no vendor relationship, no console, no app |
| **Slack** | Per-user OAuth on top of a **workspace-level app** | **Yes — and Slack is the only one.** See below. |

**Slack is the sole operator-registered case, and this ADR does not rule on it.**

Slack's MCP requirements foreclose the customer-provisioned path: an MCP client must be backed by a registered Slack app with a **fixed app ID** which it hardcodes, and **unlisted apps are prohibited** — only directory-published or internal apps may use MCP. Probed authorization-server metadata confirms there is no programmatic escape: no `registration_endpoint` (a box cannot self-register), no CIMD (a client cannot identify itself by metadata URL), and no device grant. That leaves two options: every SMB builds its own internal Slack app — a four-step IT chore for a business defined by *not having an IT department* — or Warp Lab publishes one app for the fleet.

**The blast radius, stated plainly because it is the real cost:** one app identity means **one revocation or suspension removes Slack from every box in the fleet simultaneously.** There is no per-customer isolation in that model and no staged rollback. It also commits Warp Lab to a directory review on Slack's timeline which can be refused, and to owning that app identity indefinitely across staff changes. Every box additionally shares the app's registered redirect URIs, which forces either a fleet-wide `https://<box>.local/…` callback or a paste-the-code fallback — there is no per-box redirect. The one mitigating fact: Slack's own official plugin ships a **client ID with no secret** (a PKCE public client), so publishing would distribute no Warp Lab secret — making this an *availability and governance* risk rather than a credential-distribution one. That claim is in tension with probed metadata advertising `client_secret_post` only, and **is not yet resolved**.

**This is a commercial and legal commitment, not an engineering detail. Romain owns the call, [WARP-2373](https://warp-lab.atlassian.net/browse/WARP-2373) owns the decision record, and nothing here should be read as the decision having been made.** Per the boundary Romain fixed on 2026-08-27 across WARP-2286 and WARP-2373: the MCP-client-class ADR ([WARP-2286](https://warp-lab.atlassian.net/browse/WARP-2286), expected to land as ADR-043) carries the *classification* only and refers to WARP-2373 for the verdict; WARP-2373 carries the *decision*, its accepted consequences, the ownership and rotation runbook, and the rollback position if the listing is refused. This ADR classifies and cites. It does not rule, and it must not be cited as though it had.

### 8. OAuth authorization-code remains the standing path — this narrows §5, it does not replace it

For any future vendor with **no customer-creatable credential**, delegated per-user authorization through the OAuth authorization-code flow is still the answer, on exactly ADR-041 §5's terms. That model is not deprecated, not legacy, and not a fallback: it remains correct wherever the vendor's own architecture makes it the honest one, and it is what Microsoft 365 ships on today.

The rule for choosing is: **prefer the customer-supplied credential where the vendor offers one**, because it puts no Warp Lab identity in the trust path and no secret of ours on customer hardware. Where the vendor offers none, §5 applies unchanged — and a redirect-based flow against an app *we* register becomes necessary, which is the condition under which §3's v1 no-redirect rule has to be revisited. Revisiting it is an ADR, not a pull request.

## Consequences

**What gets better.** Five vendor stories stop each re-deciding the same thing, and the epic loses an entire subsystem: no OAuth client registration, no callback URL on the box, no consent-screen copy, no redirect-URI negotiation with five developer portals. Onboarding becomes something an SMB owner can complete alone — a click-path in a console they already use and a paste into a form, with no Partner account and, for four of the five, no extra spend. The credential form is one shape reused across every vendor (WARP-2275), riding a template already in production for SMTP. And Warp Lab owns no app identity for any of these vendors, so there is nothing of ours to revoke, suspend, or lose in a staff change.

**What gets harder, stated plainly.**

- **A pasted credential has no consent screen.** OAuth at least forces the vendor to show the customer what is being granted. Here nobody shows them anything unless we do. ADR-041 §2 requires *"a capability statement, not a policy promise"* at connect time — and this model makes **our own UI copy the only place that statement can live.** If it is vague, there is no vendor screen behind it to compensate. That copy is a product deliverable of WARP-2275 and WARP-2298, not a nicety.
- **"Minimum necessary access" is only as good as the vendor's own scoping, and the variance is wide.** Stripe gives per-resource read/write. HubSpot gives scope checkboxes. Mailchimp gives **nothing** — the key is the whole account, and connecting Mailchimp means handing the box full access to the marketing system of record because there is no narrower thing to hand it. We cannot claim uniformly-minimal access across these five, and we should stop short of implying we can.
- **We have surrendered ADR-041 §5's structural bound.** Delegated authorization meant the box *could not* read what the person could not. An account credential has no such ceiling — only the ticks the owner made. That is a real regression in a guarantee, accepted because the alternative for these vendors is a distributed client secret, which is worse.
- **There is no natural re-consent moment.** Non-expiring credentials mean a connection can outlive the person who made it, the reason it was made, and any review of whether it should still exist. Nothing prompts. The connection surface has to prompt instead.
- **We cannot rotate or revoke on the customer's behalf**, and the failure arrives as a rejected call rather than a notification. The people-shaped version of this — HubSpot's super admin leaving the company, and every call failing months later — is not hypothetical in an SMB. The named error class makes it legible; it cannot prevent it.
- **Two vendors' hosts are functions of configuration**, so `egress-gate` is structurally blind to them and the code-side guard is the only real enforcement. A refactor that assembles the URL differently would keep CI green while dialling anywhere. That is why the guard's tests assert on the injected `fetch` having **zero** calls, not on a returned value.

**What is explicitly not permitted under this ADR.** No box may hold a credential Warp Lab minted. No Warp Lab client secret may appear in any env template, compose file, provisioning artifact or box-side config for these vendors. A full-privilege credential may not be accepted where the vendor offers a scoped one — for Stripe that is contractual. A rejected credential may not appear, whole or in part, in a log line, an error message, or an audit row. A connector may not become `secretRef`'s, `ErpEntityCache`'s or `ErpSyncCursor`'s first writer while WARP-2028 is open. A permission-denied, a quota exhaustion, and a revoked credential may not render as an empty result. And nothing in §7 may be cited as a decision on Slack.

### Egress: this ADR registers nothing

Following ADR-041 §3's precedent — *"each subsequent provider registers its own hosts on its own ticket"* — **ADR-042 adds no entry to `docs/security/allowed-egress.yaml`**, and touching that file from this PR would be a signal the scope grew. Every vendor story already carries its own registration as an acceptance criterion, and each needs security review with Romain assigned. Recorded here so the shape is known before the first one lands, not so it is pre-approved:

| Vendor | Hosts | Registry shape |
|---|---|---|
| Stripe | `api.stripe.com` | `kind: egress`, `data_class: user-content-on-request` |
| HubSpot | `api.hubapi.com` | `kind: egress`, `data_class: user-content-on-request` |
| Mailchimp | `<dc>.api.mailchimp.com` | **`kind: dynamic`** + `config_key` — the host is a function of the credential |
| Shopify | `<shop>.myshopify.com` | **`kind: dynamic`** + `config_key`; `shopify.dev` as `kind: reference`, since it is a page the merchant's browser visits, never a host the box dials |
| Xero | `api.xero.com`; `identity.xero.com`, `login.xero.com` | `user-content-on-request` for the API host, `none` for the token hosts — the `m365-graph-api` / `m365-entra-login` pair is the template |

By **domain, never by IP** (ADR-041 §3). Nothing may be `data_class: ambient-customer-content`, which `docs/SECURITY.md:176-178` bans by name.

## Follow-ups

- **The Slack decision** — [WARP-2373](https://warp-lab.atlassian.net/browse/WARP-2373). Requires Romain by name. Blocks the Slack connector either way; resolve the `client_secret_post`-vs-PKCE-public-client tension before the manifest is built, because the whole no-secret argument rests on it.
- **Add a needs-new-credential member to `IntegrationStatus`** — `apps/orchestrator/prisma/schema.prisma:4306-4318` cannot today express §6's required distinction. Whichever SaaS connector lands first owns it; overloading `ERROR` is the mutation this ADR forbids.
- **Build the secret store `secretRef` promises** — **WARP-2028**. Blocking for anything that would otherwise become its first writer.
- **Xero redirect-URI spike** — [WARP-2383](https://warp-lab.atlassian.net/browse/WARP-2383) AC 1. Decides whether §2's Path B exists outside AU/NZ/UK/US, which is a market question, not an engineering one.
- **Mailchimp Free-plan API access** — unverified (WARP-2379). Until probed, the prerequisite reads "paid plan required (unverified on Free)".
- **HubSpot's *"at this time"* hedge** on legacy private apps is the auth story's single point of failure (WARP-2317). It is a watch item, not a blocker; if it moves, the fallback is not OAuth — HubSpot has no PKCE — it is renegotiating the integration.
- **The customer-facing half of this doctrine has no home yet.** `docs/integrations/SETUP.md` is a LAN-database guide with zero cloud content; [WARP-2298](https://warp-lab.atlassian.net/browse/WARP-2298) owns the per-vendor click-paths, plan-tier prerequisites and costs. The capability statement §Consequences requires lives there and in WARP-2275's form copy.
- **Re-read the vendor table before building against it.** Every row is dated. Four of the five vendors made a breaking change to their credential or commercial model within the last eight months.
