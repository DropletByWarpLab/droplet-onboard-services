# Connecting Xero

> **Audience:** the person who owns the Xero subscription.
> **Time:** about ten minutes — **but read the first two sections before you spend any of it.** Xero is the one connector that can be impossible for you, and the one that costs you money every month.
> **What Droplet does with what you paste:** [`credential-handling.md`](credential-handling.md).
> **Sources checked 2026-08-27** — against Xero's own developer documentation and the credential facts recorded in ADR-042 §2 (pinned to WARP-2383). **Not yet walked through the live Xero developer portal by us**, so treat the screen and button names below as a close guide rather than a screenshot. Xero rebuilt its developer commercial model on 2026-03-02; anything you read elsewhere that is older than that may describe pricing and limits which no longer apply.

---

## Stop here if you are not in AU, NZ, UK or US

Droplet connects to Xero through a **Custom Connection**, and Xero makes Custom Connections available in **AU, NZ, UK and US** only. That is the complete list — there is no fifth country, no application process, and no exception.

**If your Xero organisation is in any other country — Canada, Ireland, Singapore, anywhere in the EU — you cannot connect Xero to Droplet today.** Close this page. Nothing further down will help, and working through the click-path will end at a screen that does not offer you the option.

This is a qualification question, not a troubleshooting step. It is here at the top because the alternative is discovering it fifteen minutes in and reasonably assuming something is broken.

*(There is a second technical route Xero offers, and we are not offering it yet: whether it can work for an on-premises box at all is still an open engineering question. When that resolves, this page will say so. Until then, Custom Connection is the only path, and the four countries above are the whole map.)*

---

## Xero charges you for this connection, every month, per organisation

A Custom Connection is a **paid** Xero product, billed by Xero to you — not to us, and not bundled into anything Droplet charges for.

**$10 AUD / £5 / $5 USD per month, per organisation.**

Those are three separate prices in three currencies, not one price converted. You pay whichever applies to your Xero account.

**"Per organisation" is the part that surprises people.** In Xero, an *organisation* is one set of books. A Custom Connection reaches exactly one of them. If your business keeps several — a trading company and a holding company, one per site, one per legal entity — **you need one Custom Connection each, and you pay for each one.**

| Your Xero setup | Custom Connections | Monthly cost (USD example) |
|---|---|---|
| One organisation | 1 | $5 USD |
| A trading company and a holding company | 2 | $10 USD |
| Four sites, each its own organisation | 4 | $20 USD |

So an accountant or a group with several entities should do this arithmetic before starting, not after the first invoice arrives. **$5 USD** is the sticker price; the number that lands on your bill is that figure times the number of sets of books you want Droplet to see.

You do not have to connect all of them. Connecting the one organisation that matters most is a perfectly good outcome and costs one unit.

> **On connection limits:** this guide deliberately quotes **no** number for how many connections you may have. Xero's own live documentation currently gives three different figures on three different pages, and we would rather say nothing than pick one and be wrong about your bill. It does not affect the Custom Connection path described here — you create one per organisation and pay per organisation. If you are planning something larger, confirm the limit with Xero directly rather than with us.

---

## Plan prerequisite

**Any paid Xero subscription for the organisation you are connecting**, and you must be able to sign in to Xero's developer portal with an account that has access to that organisation.

There is no Xero plan tier that unlocks or blocks this — the gate is the country (above) and the per-organisation charge (above), not the subscription level. A Xero organisation in a supported country can create a Custom Connection regardless of which Xero plan it is on.

You need to be someone Xero will let authorise access to the organisation's data. In practice that means the owner or an adviser with full access; a user with restricted access will be able to create the app but not to authorise it against the organisation.

---

## Cost

**$10 AUD / £5 / $5 USD per month, per organisation**, charged by Xero. See the worked table above — the multiplier is the number of separate sets of books, and it is the part most likely to produce a surprising bill.

**Droplet adds nothing on top.** There is no Warp Lab charge for the Xero connector, and the data Droplet reads is not metered to you.

---

## Click-path

Do this in a browser, signed in to Xero with an account that can authorise the organisation.

1. Go to Xero's **developer portal** and open **My Apps**.
2. **Create a new app** and choose **Custom Connection** as the integration type. This is the choice that matters — the other types are for apps distributed to other people's organisations, and they are not what you want.
3. Name it something you will recognise later: `Droplet — <your organisation name>`. If you are creating several, put the organisation's name in each so they are distinguishable at a glance.
4. **Select the organisation** this connection will reach. One connection, one organisation — this is where the per-organisation charge is decided.
5. **Choose the scopes.** See the next section. **Choose carefully** — changing them later is not free, and one direction of change cannot be undone. That is unusual and it is explained below.
6. **Authorise the connection.** Xero will confirm the charge at this point.
7. Copy the **Client ID** and generate and copy the **Client Secret**. The secret is the sensitive half; treat it like a password, and copy it before you navigate away.
8. In Droplet: **Integrations → Xero → Connect**, read the capability statement, and paste **both** values into the two fields.
9. Confirm. Droplet requests its own short-lived token and makes its first read.

Repeat the whole sequence for each additional organisation you want connected. They are separate connections with separate credentials and separate charges.

> **A note for anyone reading Xero's general developer documentation alongside this.** A Custom Connection is *described* as using the client-credentials grant, but Xero's own documentation is careful to say it is a **modified** variant that its general pages do not describe, and that the ordinary client-credentials grant **cannot** reach an organisation's data at all. If you or your developer build against the generically documented flow, you will authenticate successfully and get an empty-looking result from the wrong place. Droplet handles this correctly; the note is here so nobody "fixes" it into the standard flow.

---

## Scopes and permissions

Grant read scopes only. Droplet does not write to Xero.

| Scope | What it buys you |
|---|---|
| `accounting.transactions.read` | Invoices, bills and payments — the core of "who owes us" and "what do we owe". Bills and invoices share one place in Xero, so this one scope covers both. |
| `accounting.contacts.read` | The customers and suppliers those transactions belong to, so an amount has a name attached. |
| `accounting.settings.read` | The chart of accounts — **and your bank accounts**, which Xero treats as accounts rather than as their own thing. Without it, balances have no account names and bank accounts are invisible. |
| `accounting.reports.read` | Standard reports such as profit and loss and aged receivables. Optional; skip it if you only want transaction-level questions answered. |

**Grant less if you want to.** A narrower connection is a working connection, and Droplet names the missing permission rather than returning an empty list.

### Changing scopes later is a re-consent event, and one direction is permanent

This is genuinely unusual and worth reading twice.

- **Editing a live Custom Connection deactivates it** until it is re-authorised. So a scope change is not a settings tweak — it is a short outage plus a trip back to the portal to re-authorise.
- **Removing a broad scope cannot be undone.** Xero's own wording: if you remove a broad scope from an existing connection, you will not be able to re-add it — it is permanently replaced by granular scopes.

Two consequences:

1. **Droplet cannot adjust your scopes for you.** Every scope change costs you a round-trip through the Xero portal. That is a Xero constraint, not a missing Droplet feature.
2. **Do not narrow scopes speculatively.** Grant the set you want from the start. If you are unsure, grant the four above; trimming one later may not be reversible.

Separately, Xero has been retiring scopes on a schedule: the general-ledger journals scope stopped being available to **new** Custom Connections on **2026-04-29**, and Xero has said broad scopes end on **2027-09-13**. Droplet does not depend on the journals scope, so neither deadline affects this connection — but if you are reading an older setup guide that tells you to tick it, that is why it is not on the list above.

---

## Rotation and expiry

Two credentials, behaving differently.

- **What you pasted — the client id and client secret — does not expire.** It works until you rotate or delete it. Nothing will ever prompt you to reconsider it; see [`credential-handling.md`](credential-handling.md) for why that is worth a calendar note.
- **What the box requests from it — an access token good for 30 minutes — expires constantly, by design.** Xero issues no refresh token for this connection type, so the box simply requests a fresh token when it needs one. You never see this and there is nothing to do about it.

So **you will never be asked to reconnect Xero because a token expired.** If Droplet says the credential stopped working, something changed at your end: the connection was edited (which deactivates it until re-authorised), the secret was rotated, the Xero subscription lapsed, or the connection was deleted.

**Rotating on purpose.** Generate a new client secret in the developer portal, then paste it into Droplet. Do not assume a grace period — rotate when you can tolerate a short gap, and update Droplet promptly afterwards.

---

## Revocation

**You control this entirely. We cannot revoke on your behalf**, and Droplet finds out only on its next call.

**To stop Droplet reading Xero:**

- **On the box:** `Integrations → Xero → Manage → Disconnect`. This purges the stored client id and secret from the box and stops all reading. Data already synced stays until you delete it.
- **At Xero:** delete the Custom Connection in the developer portal's **My Apps**. That severs access and stops the monthly charge for that organisation.

**Do both.** Disconnecting stops Droplet using the credential; only deleting the connection at Xero stops it existing and stops you paying for it. **If you are decommissioning a box, deleting the connection at Xero is the step that saves you money** — a Custom Connection left behind on a box nobody uses is still billed.

**If you suspect the box has been tampered with**, delete the Custom Connection at Xero first — that takes effect immediately and does not depend on the box being reachable or cooperative.

> **One thing we are not going to guess at.** Xero publishes a token-revocation endpoint, but it revokes a *refresh token* — and a Custom Connection does not have one. So that endpoint does not apply to this connection type, and we have not yet confirmed with Xero what the supported severing procedure is beyond deleting the connection in the portal. **Deleting the connection in My Apps is the step we are confident about; do that.** If you need a documented revocation procedure for an audit, ask Xero directly rather than relying on this page — and tell us, so we can write down the answer.

**What a revoked or deleted connection looks like on the dashboard:** the connection moves to a named state saying the credential no longer works, and sync pauses. It does not show zero invoices.

---

**Related:** [`credential-handling.md`](credential-handling.md) · [`SETUP.md`](SETUP.md#3-track-b--a-cloud-service-you-already-pay-for-cloudsaas-providers) · [`README.md`](README.md)
