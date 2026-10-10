# Connecting GoCardless

> **Audience:** the GoCardless **admin** whose Direct Debit payments, refunds and payouts you want the box to read.
> **Time:** about three minutes. Nothing to install, nothing to pay for, nothing to apply for.
> **What Droplet does with what you paste:** [`credential-handling.md`](credential-handling.md).
> **Sources checked 2026-10-04** — against GoCardless's own API reference (its making-requests, data-conventions, limits, OAuth-reference and payment, refund and payout pages), its support article *How to create an access token*, its US pricing page, and the official Node SDK's source and README (for how the date filter is spelled on the wire). **Not yet walked through with a live account by us**, so treat the screen names below as a close guide rather than a screenshot. A short list of questions is explicitly still open — see [the end of Scopes and permissions](#scopes-and-permissions) — and each is flagged as open rather than guessed at.

---

## Four things to know before you start

**1. Ask for the read-only scope when you make the token.**

GoCardless lets you choose a scope when you create an access token — read-only or read-write. Choose **read-only**. Droplet only ever *reads*: it cannot create a payment, collect from a customer, cancel a mandate or issue a refund, because the connector family GoCardless runs on has no write path in it to switch off. But *us* being read-only does not make *the token* read-only. A read-write token handed to the box could do all of that if it were ever misused, and the scope is the one control you have over it.

**2. Use your live dashboard, not the sandbox.**

A sandbox token only works against GoCardless's sandbox host, and this box never dials that host. A token pasted from the sandbox will be refused by the live API, and the box will tell you the credential does not work.

**3. Disabling the person who made the token does not switch the token off.**

GoCardless says this in its own article: disabling an administrator or user who has created an access token **does not revoke** the access token they created. If an admin leaves, the token they made keeps working until someone disables *the token itself*. See [Revocation](#revocation).

**4. Payers, mandates and subscriptions are not read.**

Droplet reads three things: **payments** (the collections you have made), **refunds**, and **payouts** (the money GoCardless sends to your bank). It does not read your customers, their bank details, their mandates, or your subscriptions and instalment plans. If the question you want the box to answer is "who has an active mandate" or "which plans are quarterly", **this connector does not answer it**.

---

## Plan prerequisite

**None beyond the GoCardless account itself, and the role you hold in it.** GoCardless's US pricing page lists API integration across all three of its standard tiers with no restriction by tier — its feature row is that you can use GoCardless through the dashboard, an API, or a partner product. Creating an access token needs the **admin** role: GoCardless's support article says only administrators can create one. There is no application to submit and nobody at GoCardless reviews anything. Warp Lab is not in the loop either: you create the token inside your own account and paste it into your own box, so there is no consent screen with our name on it and nothing of ours that can be revoked on your behalf. [`SETUP.md`](SETUP.md#31-why-you-create-the-credential-and-we-do-not) explains why that is the shape for every connector in this set.

---

## Cost

**None for the connection.** GoCardless's US pricing page lists Standard at 0.5% + $0.05, Advanced at 0.75% + $0.05 and Pro at 0.9% + $0.05 per transaction, with "No recurring monthly subscription fees". Those are the ordinary collection fees you already pay; **reading your payments does not add to them**, and there is no charge for creating a token or for the calls Droplet makes. Connecting Droplet adds nothing to your GoCardless bill.

One thing is not a cost but behaves like a limit. GoCardless's own limits page gives two figures — 1,600 requests a minute in a table, and 1,000 a minute in its header example and a note that calls 1,000 a performance target. Droplet paces itself at the **lower** one, so it never asks for more than 1,000 a minute, and if GoCardless ever answers "slow down" it backs off. In practice you will not notice it; it is written here because the allowance belongs to your account and is shared with every other tool using it.

---

## Click-path

Do this in a browser, signed in to your **live** GoCardless dashboard **as an admin**.

1. Open the GoCardless dashboard and make sure you are in your live account, not the sandbox.
2. Open **Developers**, then **API settings**.
3. Click **Create** (top right) and choose **Access token**.
4. **Name it** something you will recognise later — *Droplet* is plenty — and **choose the read-only scope**.
5. Click **Create access token**, then copy the token **now**. GoCardless will not be able to show it again; if you lose it, you create another.
6. In Droplet: **Connectors → GoCardless → Connect**, read the capability statement, paste the token, and confirm. The box checks it with a single call to GoCardless's creditors list — your organisation has one creditor — so a failure here is unambiguous evidence about the token rather than about your payments.

---

## Scopes and permissions

**Read-only is the scope to choose** — GoCardless names its two scopes `read_only` and `read_write`, and the choice is made at creation, covering the token as a whole rather than resource by resource. This section is therefore a description of what the box actually does with the access you give it.

| What Droplet reads | GoCardless endpoint | Why |
|---|---|---|
| **Payments** | `/payments` | Each payment's identifier, when it was created, its amount and the amount refunded, its currency and its status. |
| **Refunds** | `/refunds` | Each refund's identifier, the payment it returns money from, its amount, currency and status. |
| **Payouts** | `/payouts` | Each payout's identifier, when it was created, the date it arrives in your bank, its amount, currency and status. |
| **Your organisation's creditor** | `/creditors` | Not stored as business data. It is the single cheap call the box uses to check the token still works. |

The box opens outbound connections to exactly one address, **`api.gocardless.com`**, and to nothing else. That is a registered destination in the box's own egress list, not a matter of trust — an address that is not on that list is not reachable from the connector at all.

**Droplet does not write to GoCardless.** It cannot create a payment, collect, cancel or refund. Those surfaces do not exist in the connector at any level.

### Three things to know about what the box reads

- **Nothing is copied onto the box.** Payments, refunds and payouts are read when you ask a question and are not kept, so there is no synced copy to delete afterwards. The cost of that is that **each question reads your whole history**: GoCardless returns up to 500 rows a request, so an account with 50,000 payments is about a hundred requests, several seconds at the pace above, every time you ask.
- **Amounts are shown in the major unit.** GoCardless sends money as whole minor units — 100 means 1.00 in a pound or euro account — and the box converts using each row's own currency.
- **The status is GoCardless's own word.** A payment moves from *pending submission* to later states after it is created, and the box shows the word GoCardless sends, unchanged.

### Questions still open, stated as open

- **The exact label of the read-only choice** in the token form is not on any official page we read, so the wording in step 4 is a description, not a screenshot.
- **Whether a read-only token may call the creditors list.** We expect it to; we have not confirmed it with a live token. If the box reports a fresh read-only token as refused, tell us — the fix on our side is a one-line change to which endpoint the check uses.
- **Whether GoCardless accepts the date filter in the form the box sends it.** The box asks for payments created on or after a date; the official SDK writes that filter with its brackets raw and the box's HTTP layer writes them percent-encoded. Standard servers treat the two the same. One live call settles it.
- **Whether a payment can ever carry a customer link.** The documented payment carries a mandate and a creditor and no customer, so the box leaves the customer column empty rather than guess.

---

## Rotation and expiry

**No expiry is documented** for a GoCardless access token, so there is no date to diary. A token stays valid until someone disables it.

**To rotate:** create a new read-only token exactly as in the click-path, paste it into Droplet at **Connectors → Credentials**, confirm the connection reports healthy, and only then **disable the old token** (see [Revocation](#revocation)). There is no grace period to rely on: the old token works until the moment it is disabled and not after.

**Treat the token as belonging to a person, and rotate when that person leaves.** An admin made it, and — as above — disabling that admin's account does **not** revoke it. A token held by someone who no longer works for you is a standing credential into your collection history. Make the box's token from an account that will outlive any one person, and disable the token itself when the people around it change.

---

## Revocation

**You control this entirely. We cannot revoke on your behalf**, and Droplet finds out only on its next call.

**To stop Droplet reading GoCardless:**

- **On the box:** `Connectors → GoCardless → Manage → Disconnect`. This purges the stored token from the box and stops all reading. Nothing from GoCardless is copied onto the box in the first place, so there is no synced data to delete afterwards.
- **At GoCardless:** open **Developers → API settings**, find the token, and click **Disable access token**. Do this as well as disconnecting. Disconnecting stops Droplet using the token; only disabling it at GoCardless stops the token existing.

**Do both, in that order**, if you are decommissioning a box or handing it back.

**If you suspect the box has been tampered with**, disable the token at GoCardless **first**. That takes effect immediately and does not depend on the box being reachable or cooperative — which is the whole reason the vendor-side step is not optional.

**What a disabled token looks like on the dashboard:** the connection moves to a named state saying the credential no longer works, and reading pauses. It does not show an empty list of payments. "You collected nothing" is a completely believable answer, and there would be no way for you to tell it apart from a broken connection — so Droplet never gives it. A problem is always reported as a problem, never as an empty list.

---

**Related:** [`credential-handling.md`](credential-handling.md) · [`SETUP.md`](SETUP.md#3-track-b--a-cloud-service-you-already-pay-for-cloudsaas-providers) · [`README.md`](README.md)
