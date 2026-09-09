# What Droplet does with the credential you paste

> **Audience:** the person about to connect Stripe, HubSpot, Mailchimp, Shopify or Xero to a Droplet.
> **Applies to:** every cloud/SaaS connector — [Track B of `SETUP.md`](SETUP.md#3-track-b--a-cloud-service-you-already-pay-for-cloudsaas-providers).
> **This is one page on purpose.** The five vendor guides link here rather than each restating it, so there is exactly one version of this promise and it cannot drift into five.

---

## The short version

**This is a capability statement, not a policy promise.** It describes what the box is built to do, not what we intend to do.

> **Droplet copies the credential onto your box and keeps it there.**
> It is encrypted on the box's own disk, under a key derived from that box's identity.
> It is **never shown again** — not to you, not to us, not to the dashboard, not to a support engineer.
> It is used only to read the things you ticked, from your premises, over an outbound connection to that one vendor.
> **Disconnecting deletes it.** A factory reset destroys the key that could have decrypted it.
> **We cannot rotate it, revoke it, or use it anywhere else.** It is yours, and only you can take it back.

That block is the **canonical source string** for the connect screen's capability statement. The wording in the product and the wording here are meant to be the same sentences; if they diverge, this page is the one to copy from.

---

## The five things worth knowing before you paste

### 1. It is encrypted on the box, under that box's own key

The credential is stored in an encrypted column in the box's database. The key is derived on the box, from the box's own device secret — it is not a password anyone types, and it is not held by Warp Lab.

The encryption is also **bound to the row it belongs to**. If someone copied the stored blob out of your Stripe connection and pasted it into another connection's row, it would fail to decrypt rather than quietly authenticate as the wrong account.

### 2. It is never returned to the browser

Once stored, there is no screen, no API response, and no export that gives the credential back. The connection detail the dashboard receives is built from an explicit list of safe fields — status, what it is connected to, when it last synced — and the encrypted column is not on that list.

The same rule covers failure. If Droplet **refuses** the credential you pasted — because it is the wrong kind, for example a Stripe secret key where only a restricted key is accepted — the refusal message tells you what was wrong without ever repeating any part of what you pasted, and the audit record notes only that a credential was supplied, never its value.

### 3. Disconnecting deletes it

**Disconnect** on the integration's manage menu is not a flag flip. The stored credential is removed from the box, and the connection goes back to "not connected".

Two things that deliberately survive: the data Droplet has already read and indexed stays where it is until you delete it, and the connection's identity stays so the dashboard can still tell you that this is a Stripe connection that is now disconnected — rather than pretending Stripe was never set up.

If you want the credential gone at the vendor's end too — and you usually should — you have to delete it there as well. See the "Revocation" section of your vendor's guide. Disconnecting on the box stops Droplet using it; it does not stop it existing.

### 4. A factory reset destroys the key, not just the rows

A factory reset regenerates the box's device secret. Every credential that was encrypted under the old one becomes permanently unreadable, whether or not the rows themselves survive the wipe. There is no recovery path, by design: after a factory reset you reconnect each service from scratch, which is the correct outcome for a credential to your payment processor or your accounting system.

The same is true of a restored backup taken before the reset — the credentials in it cannot be decrypted by the new box identity.

### 5. Nothing about it is ours

We do not mint it, hold a copy of it, or appear anywhere in the trust path between your box and the vendor. There is no Warp Lab app registration behind these five connectors, no Warp Lab client secret on your box, and no account of ours that could be compromised into yours.

The flip side is the honest one: **we cannot rotate or revoke your credential on your behalf, and we cannot renew one that stops working.** If you delete the key in Stripe's dashboard, or the HubSpot admin who created the app loses that role, the box finds out on its next call — never in advance. What it does then is show you a named, specific state saying the credential needs replacing. It will not quietly return empty results.

---

## The part nobody else will tell you: these credentials do not expire

Almost none of the credentials in this set have an expiry date. A Stripe restricted key, a HubSpot private app token and a Mailchimp API key have no expiry at all. Shopify's and Xero's pasted credentials do not expire either — only the short-lived tokens the box mints from them, which the box re-mints on its own.

When you sign in to something with a "sign in with Google" style flow, that permission eventually lapses and you are asked again. **That does not happen here.** A key you paste today will still be working in three years, with nobody having reconsidered whether it should be. Nothing will prompt you.

So two habits are worth forming, because the software cannot form them for you:

- **Write down what you connected and why**, wherever your business keeps that kind of note. The integration list on the box tells you *that* Stripe is connected; it cannot tell you whether the reason still holds.
- **Review the connections when the person who set them up leaves.** This is the failure that actually happens in a small business: the credential outlives the role, the project, and sometimes the employee.

Droplet helps by making an old connection visible on the integrations page with the date it was set up. That is the extent of what it can do — there is no vendor-side expiry to lean on.

---

## Frequently asked, honestly answered

**Does the credential leave my building?**
Only in the sense that Droplet uses it to call that one vendor, over HTTPS, outbound. It is not sent anywhere else, and it is not sent to Warp Lab. Every destination the box is allowed to dial is registered in an allow-list that defaults to refusing everything else.

**Can a Warp Lab support engineer read it?**
No. There is no interface that returns it, and remote access to the box does not create one. What support can see is the same connection status you can see.

**Can the local AI read it?**
No. The assistant reads the *data* the connector fetched — invoices, contacts, orders — not the credential that fetched it.

**What if I paste the wrong thing?**
Droplet checks the shape before it stores anything. A credential of the wrong kind is refused at the paste step, with the reason, and is never written to disk. Nothing to clean up.

**What if my key is stolen from somewhere else?**
Revoke it at the vendor, create a new one, and paste the new one in. Droplet accepts a replacement in place — the connection keeps its identity and everything already synced stays. Stripe and HubSpot both keep the old key working for a short grace period after you rotate, so a rotation done in the right order is not an outage.

---

## Appendix — how we can say all this (for reviewers and auditors)

Every claim above maps to shipped code, not to intent. This appendix exists so a reviewer can check the page rather than trust it.

| Claim | Where it is enforced |
|---|---|
| Encrypted at rest under a per-purpose derived key | `apps/orchestrator/src/services/column-crypto.service.ts` — HKDF-SHA256 per-purpose derivation; each vendor family gets its own label so one compromised key does not open another |
| Bound to the row, so a moved blob fails closed | AES-256-GCM with the row id as additional authenticated data; `IntegrationConnection.providerTokensEnc` in `apps/orchestrator/prisma/schema.prisma` |
| Never returned to the browser | The integration detail returned by the API is an explicit field allow-list (`apps/orchestrator/src/services/integrations.service.ts`, `toDetail`); no `*Enc` column is on it. `apiCredentialsEnc`'s schema comment states the same rule |
| A rejected credential never appears in a log, error or audit row | `apps/orchestrator/src/lib/log-redaction.ts`; the audit shape follows the SMTP template — a boolean saying a secret was supplied, never the value |
| Factory reset destroys the key | `scripts/factory-reset.sh` removes `.env`; `scripts/setup.sh` regenerates `DEVICE_SECRET_KEY` when it is absent, which crypto-shreds anything encrypted under the old one |
| Disconnect purges the credential | Required by [ADR-041](../ADR-041-cloud-connector-class.md) §2 — *"it revokes and purges the stored tokens, not merely flips a flag"*. The shipped precedent is the Microsoft 365 connector's `disconnect`, which nulls `tokenCacheEnc` |

**Two things this page deliberately does not claim.**

1. **There is no external secret store.** The `secretRef` field visible in the schema is not backed by an implementation, and no cloud connector may become its first writer while that work is open. Everything above describes the encrypted-column path, which is what actually ships.
2. **We do not claim uniformly minimal access.** What the box can read is bounded by what the vendor's console let you tick, and that varies enormously between these five — from Stripe's per-resource read switches down to Mailchimp, which offers no scoping at all. Each vendor guide states which you are getting.

**Related:** [ADR-041](../ADR-041-cloud-connector-class.md) (the cloud connector class and its five conditions) · ADR-042 (customer-supplied credentials as a third consent model) · [`SETUP.md`](SETUP.md) · [`README.md`](README.md)
