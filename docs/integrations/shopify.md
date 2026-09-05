# Connecting Shopify

> **Audience:** the person who owns the Shopify store.
> **Time:** about fifteen minutes — longer than the others, because Shopify asks you to create an app rather than a key.
> **What Droplet does with what you paste:** [`credential-handling.md`](credential-handling.md).
> **Implementation landed 2026-09-02 (WARP-2296).** Everything below now describes a shipped connector rather than a plan, and the two were reconciled in that PR. What Droplet does with each of the vendor limits on this page is written down in *What the box refuses* at the bottom.
> **Sources checked 2026-08-27** — against Shopify's own developer documentation and the credential facts recorded in ADR-042 §2 (pinned to WARP-2296). **Not yet walked through the live Shopify Dev Dashboard by us**, so treat the screen and button names below as a close guide rather than a screenshot. Shopify changed this flow on 2026-01-01, so anything you read elsewhere that is older than that is describing a screen which no longer exists.

---

## Answer this before you click anything: which plan are you on?

**Shopify gates your customers' personal details behind the Grow plan.** This is not a Droplet limitation and there is no way around it from our side.

Shopify classifies names, email addresses, phone numbers and postal addresses as **Level 2 protected customer data**. Access to that level requires the store to be on the **Grow plan ($105/mo)**. A store on the **Basic plan ($39/mo)** cannot grant it — not partially, not with an exception, not by ticking a different box.

So, plainly:

| Your plan | What Droplet can read | What it cannot |
|---|---|---|
| **Grow ($105/mo)** or above | Orders, products, inventory, fulfilments — **and** the customer names, emails, phones and addresses attached to them | — |
| **Basic ($39/mo)** | Orders, products, inventory, fulfilments — the commercial shape of the business | **Who any of it belongs to.** Customer names, emails, phones and addresses are unavailable |

**Decide which of those you are buying before you spend fifteen minutes on the setup.** A Basic-plan store still gets a genuinely useful connection — "what did we sell last month", "what is running low", "which products move" are all answerable. What it cannot answer is anything shaped like "what has this customer ordered before", because the box will not have been given the customer.

If you are on Basic and the customer questions are the reason you are connecting Shopify at all, the honest sequence is: upgrade to Grow first, then come back. Connecting first and discovering the gap afterwards wastes the setup and looks like a fault in Droplet, which it is not.

> **A note on how this failure presents.** Shopify does not refuse the request. An app without protected-data access gets an HTTP 200 with the customer fields blanked out. Droplet detects that and reports it as a named permission state rather than showing you a customer list full of empty names — but it is worth knowing that the underlying vendor behaviour is a silent blank, not an error.

---

## The other thing that changed: there is no "custom app" any more

If you have set up a Shopify integration before, or you are following a blog post, you are probably looking for **Settings → Apps and sales channels → Develop apps**, and an access token beginning `shpat_`.

**That path was removed on 2026-01-01.** Admin-created custom apps no longer exist and cannot be created. If you have an old `shpat_` token lying around, Droplet will refuse it — not out of preference, but because the flow that minted it is gone and it cannot be re-created if it stops working.

The replacement is a **Dev Dashboard app**, created in Shopify's developer dashboard under your own Shopify organization and installed on your own store. It is a little more clicking, and the credential it gives you is **two values, not one**: a **client id** and a **client secret**. Droplet's connect screen has two fields for exactly this reason — that is not a bug, and you are not missing a token somewhere.

The box uses those two values to mint its own short-lived access token whenever it needs one. You never see or handle that token.

---

## Plan prerequisite

**Grow ($105/mo) if you want customer names, emails, phones or addresses. Basic ($39/mo) is enough for everything else.**

See the table at the top of this page — that is the whole rule, and it is the single most important thing on this page.

You also need to be the store owner, or a staff member with permission to manage apps, and the app you create must live in the **same Shopify organization as the store you install it on**. Shopify enforces that, and it is a feature here: it is what makes this app unmistakably yours rather than ours.

---

## Cost

**Droplet adds nothing to your Shopify bill.** Creating a Dev Dashboard app is free, installing it on your own store is free, and the API calls Droplet makes are not metered or charged.

The only money in this page is the plan question above: **$105/mo (Grow)** versus **$39/mo (Basic)**, which is a Shopify subscription decision you would be making anyway — Droplet simply makes the difference visible.

---

## Click-path

Two halves: create the app, then install it and copy its credentials.

### Create the app

1. Go to Shopify's **developer dashboard** (`shopify.dev/dashboard`) and sign in with the account that owns your store's Shopify organization.
2. Choose your **organization** — the one your store belongs to. If you see more than one, picking the wrong one produces an app that cannot be installed on your store, and the error at install time will not obviously say why.
3. **Create an app**. Name it something you will recognise later: `Droplet — <your store name>`.
4. In the app's configuration, set its **access scopes** to the read scopes listed in the next section. Nothing else.
5. If you need customer details, **request access to protected customer data** in the app's configuration, and choose the level that includes names, emails, phones and addresses. This is where the Grow-plan requirement bites: on a Basic-plan store the request cannot be granted.

### Install it and copy the credentials

6. **Install the app on your store.** It must be the store in the same organization as the app.
7. Open the app's **client credentials** — a **Client ID** and a **Client secret**.
8. **Copy both.** The client secret is the sensitive half; treat it like a password. Shopify may show it only once, so copy it before you navigate away.
9. In Droplet: **Integrations → Shopify → Connect**, read the capability statement, and paste **both** values into the two fields, plus your store's domain (the `your-store.myshopify.com` one, not a custom domain you may have pointed at it).
10. Confirm. Droplet mints its own access token and makes its first read.

If Droplet reports the credential as the wrong kind, the usual cause is pasting an old `shpat_` token into the client-id field. There is no field it belongs in — see the section above.

---

## Scopes and permissions

Shopify scopes are ticked on the app, not on the credential. Grant **read** scopes only; Droplet does not write to Shopify.

| Scope | What it buys you |
|---|---|
| `read_orders` | Orders, line items, totals, and status. The core of every sales question. |
| `read_products` | The product catalogue and its prices, so an order line is a product name rather than a number. |
| `read_inventory` | Stock levels — what is running low, what is sitting still. |
| `read_fulfillments` | Shipping and fulfilment status against each order. |
| `read_customers` | **The protected one.** Who the orders belong to: names, emails, phones, addresses. This is the scope the Grow plan gates — on Basic you can tick it and still receive blanks. |

**Grant less if you want to.** A narrower app is a working app. If you omit a scope, Droplet names the missing permission and the question it cannot answer, rather than returning an empty list that reads as "you sold nothing".

**Do not grant any `write_` scope.** Droplet is read-only against Shopify. Nothing needs it, and nothing will use it.

---

## Rotation and expiry

There are two credentials in play and they behave differently — which is worth understanding, because one of them expiring constantly is normal and not a problem.

- **What you pasted — the client id and client secret — does not expire.** It works until you rotate or delete it.
- **What the box mints from it — a short-lived access token, good for 24 hours — expires constantly, by design.** Shopify issues no refresh token for this flow, so the box simply mints a fresh one whenever it needs to. You never see this and there is nothing to do about it.

So: **you will never be asked to reconnect Shopify because a token expired.** If Droplet says the credential stopped working, something changed at your end — the app was uninstalled, the secret was rotated, or the store's plan changed.

**Rotating on purpose.** Rotate the client secret in the app's configuration in the developer dashboard, then paste the new secret into Droplet. Unlike Stripe and HubSpot, do not assume a grace period: rotate when you can tolerate a short gap, and update Droplet promptly afterwards.

**If the store changes plan.** Downgrading from Grow to Basic silently removes protected customer data. The connection stays up; the customer fields go blank. Droplet reports it as a permission state rather than as missing data, but nothing warns you at the moment you downgrade.

---

## Revocation

**You control this entirely. We cannot revoke on your behalf**, and Droplet finds out only on its next call.

**To stop Droplet reading Shopify:**

- **On the box:** `Integrations → Shopify → Manage → Disconnect`. This purges the stored client id and secret from the box and stops all reading. Data already synced stays until you delete it.
- **At Shopify — the thorough version:** **uninstall the app from your store.** That severs the app's access to that store immediately, regardless of who holds the credentials.
- **At Shopify — the narrower version:** rotate the client secret in the developer dashboard. The old secret stops working; the app stays installed.

**Do the box disconnect and the store uninstall**, if you are decommissioning a box or handing it back. Disconnecting stops Droplet using the credential; only uninstalling stops the app having access.

**If you suspect the box has been tampered with**, uninstall the app at Shopify first — that takes effect immediately and does not depend on the box being reachable or cooperative.

**What a revoked credential looks like on the dashboard:** the connection moves to a named state saying the credential no longer works, and sync pauses. It does not show zero orders.

---

## Order history: the 60-day wall

There is a second vendor limit on this page and it is easy to miss, because — like the customer-data one — **Shopify does not report it as an error. It just returns fewer orders.**

**`read_orders` reaches the last 60 days of your order history and no further.** Everything older needs a separate access scope, `read_all_orders`, which Shopify grants **by request** on the app. It is not a tick you can simply add: you ask, and Shopify decides.

| What your app has | What Droplet can answer |
|---|---|
| `read_orders` only | "What did we sell last month", "what shipped this week", "which products move" — anything inside 60 days |
| `read_orders` + `read_all_orders` | The same questions over your whole history |

**Why this matters more than it sounds.** A revenue question answered from a silently truncated window is wrong in the one place nobody checks it. So Droplet does not answer it:

- Ask for orders from a date **inside** the 60 days and you get them.
- Ask for orders from a date **before** the wall, without `read_all_orders`, and Droplet **refuses the question and says why** rather than returning the 60 days it can see and letting that pass as the answer.
- The **background sync** is different on purpose: it asks "what changed", for which 60 days is a complete answer, so it quietly works to the wall rather than failing. Your recent orders keep syncing either way.

Droplet knows which of the two you have without asking you: Shopify tells the box exactly which scopes were granted at the moment it mints its access token.

---

## What we could not verify without a live store (WARP-2299)

Two facts on this page came from Shopify's own documentation and **have not been confirmed against a real merchant store by us.** They are recorded here rather than smoothed over, because both change what a customer can do and both are cheap to check on day one.

**1. Does the protected-customer-data request actually get granted on a Grow store?** The documentation says Level 2 access requires Grow. What it does not say is how the request behaves for an app that is installed on one store and never distributed — which is exactly our shape. The connector handles **both outcomes** and does not assume either: granted, and the customer datasets work; denied, and the connection stays up with a named state on the customer dataset only.

**2. Can a merchant-owned Dev Dashboard app obtain `read_all_orders` at all?** Shopify's request flow was written for distributed apps going through app review. Whether it is offered — and granted — for a single-store app is unconfirmed. The connector treats its absence as the normal case and the wall as the default.

**What a real store must show, on day one, to close this out.** In order, each answerable in a minute once a store is connected:

1. **Connect and read the granted scopes.** Droplet displays them. They are the merchant's own ticks, echoed back by Shopify at token mint. If `read_customers` is absent, stop — that is a tick, not a plan problem.
2. **Read one customer.** A name and an email present ⇒ Level 2 is genuinely granted on this store. Every protected field blank across every customer ⇒ the silent redaction, and the plan or the data-access request is the cause.
3. **Ask for an order older than 60 days.** A refusal naming `read_all_orders` ⇒ the wall is real for this app. Orders returned ⇒ the scope was granted and the wall is lifted.
4. **Check the store's plan against what you saw.** A Grow store that still redacts means the app's protected-data request was never granted, which is a different fix from upgrading.

**The exact shapes Droplet detects**, recorded so a future reader does not have to rediscover them:

| What Shopify sends | What it means | What Droplet does |
|---|---|---|
| HTTP 200, an `errors` entry saying the app *"is not approved to use the … field"* | Protected data refused outright | Names it as a permission state; orders and products keep working |
| HTTP 200, customers returned with **every** name, surname and email `null` | The silent redaction — the dangerous one | Same named state. Never shows the blank rows |
| HTTP 200, an `errors` entry naming a **required access scope** | A scope the merchant did not tick | A different message: go and tick it, do not upgrade anything |
| Fewer orders than the window asked for | The 60-day wall | Refuses a question that reaches past it, rather than answering short |

A store with **no customers yet** is deliberately none of the above: Droplet records "nothing to test against" rather than guessing, because a brand-new Grow store and a redacted one look identical from the outside, and telling a merchant to upgrade a plan they already have is the wrong half of that guess.

---

## What the box refuses

Short list, because refusals are easier to plan around than surprises.

- **An old `shpat_` token, in either field.** Not a preference: the flow that minted it was removed on 2026-01-01, so it cannot be re-created if it stops working. Droplet says so instead of storing it.
- **A custom domain in the store-domain field.** Shopify authenticates on the `.myshopify.com` name; a domain you pointed at the store is not it.
- **Any write, at any tier.** Droplet does not cancel orders, issue refunds, edit products or change fulfilment, and there is no setting that turns that on. The connector cannot express those requests at all.
- **A customer list with blank names.** See above — a named state instead.
- **An order question that reaches past the 60-day wall** without the scope that lifts it.
- **Anything but your own store.** Droplet checks the destination against the store domain on this connection before it sends the credentials, every time — so a mis-typed or tampered domain costs a refusal, not a request.

---

**Related:** [`credential-handling.md`](credential-handling.md) · [`SETUP.md`](SETUP.md#3-track-b--a-cloud-service-you-already-pay-for-cloudsaas-providers) · [`README.md`](README.md)
