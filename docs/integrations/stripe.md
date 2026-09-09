# Connecting Stripe

> **Audience:** the person who owns the Stripe account.
> **Time:** about five minutes. Nothing to install, nothing to pay for.
> **What Droplet does with what you paste:** [`credential-handling.md`](credential-handling.md).
> **Sources checked 2026-08-27** — against Stripe's own developer documentation and the credential facts recorded in ADR-042 §2 (pinned to WARP-2215). **Not yet walked through the live Stripe dashboard by us**, so treat the screen and button names below as a close guide rather than a screenshot. If a name has moved, the sequence still holds: Developers → API keys → restricted key.

---

## Read this before you paste: Droplet will refuse Stripe's most obvious key

Stripe's API keys page shows you a **secret key** — it begins `sk_live_` (or `sk_test_` in test mode) and it is the first thing on the screen. **Droplet refuses it.** If you paste it, you get an error, and the error is not a bug.

Stripe issues two kinds of key:

| Key | Begins | What it can do |
|---|---|---|
| **Secret key** | `sk_live_` / `sk_test_` | Everything. Read anything, charge anyone, issue refunds, change your payout account. |
| **Restricted key** | `rk_live_` / `rk_test_` | Only the specific things you tick, at only the level you tick them. |

Droplet accepts **only** a key matching `^rk_(live|test)_`. This is not a preference we could relax as a favour, and a future version will not quietly start accepting secret keys. Stripe's own guidance for integrations that run on hardware Stripe does not control is explicit — businesses supply restricted keys beginning `rk_`, not `sk_` — and Stripe names this exact architecture as the right fit: *"If customers self-host your integration, Stripe Apps using the restricted API key authentication method is likely the best fit. It doesn't require you to store your secret key on untrusted servers."*

The practical translation, in your interest rather than ours: your box sits in your office. If it were ever stolen or compromised, a restricted key gives an attacker a read-only view of the resources you ticked. A secret key gives them your money. **That is why the refusal exists, and why it comes before you paste rather than after.**

If you have already pasted a secret key somewhere it should not be, treat it as exposed: roll it in the Stripe dashboard.

---

## Plan prerequisite

**None.** Restricted API keys are available on every Stripe account, including a brand-new one, with no upgrade and no application. There is no Stripe plan tier that gates this.

You do need to be signed in as someone who can create API keys — the account owner, or an administrator. If your Stripe account has team members with limited roles, a member without API-key permission will not see the "Create restricted key" button at all.

---

## Cost

**None.** Stripe does not charge for API keys, for API calls, or for the volume of data you read. Connecting Droplet to Stripe adds nothing to your Stripe bill.

---

## Click-path

Do this in a browser, signed in to Stripe as the account owner.

1. **Decide live or test first.** The toggle is in the Stripe dashboard. A key made in test mode (`rk_test_`) reads only test data — useful for a dry run, useless for your real books. Droplet accepts both, so if you are trying it out, start in test mode deliberately rather than by accident.
2. Go to **Developers → API keys**. (On newer dashboards this is under the **Developers** menu at the top right; older layouts have it in the left sidebar.)
3. Scroll to the **Restricted keys** section — it is below the standard keys, and it is easy to miss because the secret key above it is larger and highlighted.
4. Click **Create restricted key**.
5. **Name it something you will recognise in two years.** `Droplet — <your office name>` is better than `key 3`. This name is the only thing that will tell you, later, which key belongs to the box.
6. **Set the permissions.** Everything defaults to **None**. Set the resources in the next section to **Read**. Leave everything else on None — including anything offering *Write*. Droplet does not need write access to Stripe and will not use it if you grant it.
7. Click **Create key**.
8. **Copy the key now.** Stripe shows a live key's value **once**. Once you navigate away it cannot be revealed again — see [Rotation and expiry](#rotation-and-expiry) for what to do if that happens.
9. In Droplet: **Integrations → Stripe → Connect**, read the capability statement, paste the key, and confirm.

If Droplet reports the key as the wrong kind, check the first characters. `rk_` is correct; `sk_` is the one described at the top of this page.

---

## Scopes and permissions

Stripe's restricted keys are the finest-grained credential of any vendor Droplet connects to: every resource is individually **None / Read / Write**. Grant **Read** on the resources below and nothing else.

| Stripe resource | Set to | What it buys you |
|---|---|---|
| **Charges** | Read | Individual payments — what came in, when, from whom, and whether it succeeded. This is the backbone of every revenue question. |
| **Balance transactions** | Read | The money view: fees, net amounts, and what actually landed. Without it, figures are gross and will not reconcile to your bank. |
| **Customers** | Read | Ties payments to the people who made them, so "what has this customer paid us" is answerable. |
| **Invoices** | Read | Issued and outstanding invoices, for receivables questions. |
| **Payouts** | Read | The transfers Stripe made to your bank account, so deposits can be matched. |
| **Subscriptions** | Read | Recurring revenue, renewal dates, and cancellations. Skip only if you take no recurring payments. |
| **Products** and **Prices** | Read | What the line items on a charge actually refer to. Without it, revenue is a list of amounts with no names. |
| **Disputes** | Read | Chargebacks. Small in number, large in consequence — leave it on unless you have a reason not to. |

**Grant less if you want to.** A narrower key is a working key. If you leave a resource on None, Droplet does not silently return an empty list — it tells you which permission is missing and which question it cannot answer until you tick it. You can widen the key later without redoing anything else.

**Never grant Write.** Droplet is read-only against Stripe and there is no feature that needs more. If a future version ever proposes a write, it will ask you for a new key rather than assuming an old one covers it.

---

## Rotation and expiry

**Restricted keys do not expire.** The one you create today will still work in three years unless you delete it. Nothing on Stripe's side will ever prompt you to reconsider it, and nothing on ours can — see [`credential-handling.md`](credential-handling.md) for why that matters and what to do about it.

**Rotating on purpose.** Stripe supports rolling a restricted key with a grace period: when you roll it, the old key keeps working for up to **7 days** while you put the new one in place. So the correct order is: roll in Stripe → paste the new key into Droplet → done. There is no outage if you do it in that order, and no rush if you forget the second half for a day.

Rotation replaces the stored credential and leaves everything else alone — the connection keeps its identity, and everything already synced stays.

**You navigated away before copying the key.** This happens, and it is not recoverable: a live key's value is shown once. Do not contact support — the fix is entirely in your hands. Create a **new** restricted key with the same permissions, paste it into Droplet, and then **delete the old one** in Stripe so you are not left with an orphaned key nobody is using.

**Someone left the company.** A restricted key is not tied to the person who created it — deleting their Stripe user does not break the key. That is convenient and it is also the trap: the key outlives them silently. Roll it anyway.

---

## Revocation

**You control this entirely. We cannot revoke on your behalf**, and Droplet finds out only on its next call.

**To stop Droplet reading Stripe:**

- **On the box:** `Integrations → Stripe → Manage → Disconnect`. This purges the stored key from the box and stops all reading. Data already synced stays until you delete it.
- **At Stripe:** **Developers → API keys → Restricted keys**, find the key by the name you gave it, and **delete** it. Do this as well as disconnecting. Disconnecting stops Droplet using the key; only deleting it at Stripe stops the key existing.

**Do both, in that order**, if you are decommissioning a box or handing it back.

**If you suspect the box has been tampered with**, delete the key at Stripe first — that takes effect immediately and does not depend on the box being reachable or cooperative.

**What a revoked key looks like on the dashboard:** the connection moves to a named state saying the credential no longer works, and sync pauses. It does not show zero charges, and it does not keep retrying into an error. If you see "no data" from Stripe, that means Stripe genuinely returned nothing — not that something is broken.

---

**Related:** [`credential-handling.md`](credential-handling.md) · [`SETUP.md`](SETUP.md#3-track-b--a-cloud-service-you-already-pay-for-cloudsaas-providers) · [`README.md`](README.md)
