# Connecting Loyverse

> **Audience:** the person who owns the Loyverse account whose customers and items you want the box to read.
> **Time:** about five minutes. Nothing to install, nothing to pay for.
> **What Droplet does with what you paste:** [`credential-handling.md`](credential-handling.md).
> **Sources checked 2026-09-18** — against Loyverse's own API reference (the OpenAPI document and the rendered docs), its help article on access tokens, its pricing page and its API FAQ. **Not yet walked through the live Loyverse Back Office by us**, so treat the screen and button names below as a close guide rather than a screenshot. One thing on this page is explicitly still open — whether an employee with Back Office access can make a token — and it is flagged as open rather than guessed at.

---

## Two things to know before you start

**1. The token you will make can do *everything* in your Loyverse account. Droplet uses it to read.**

Loyverse's own words: a personal access token *"gives unlimited access to all resources provided by the Loyverse API."* There is no read-only option when you make one. That is not a Droplet choice, it is the only kind of token Loyverse issues on this path. **Droplet reads customers and items and nothing else, and it cannot write to Loyverse at all** — it cannot create a receipt, change a price, or delete a customer, because the connector Loyverse runs on has no write path in it to switch off. But *us* being read-only does not make *the token* read-only. Name it for the box, **set an expiration date on it** (Loyverse offers one; it is optional), and delete it when the box goes.

**2. Your sales are not read yet, on purpose.**

Loyverse's receipts carry no currency. Your currency is one setting on your whole account, and the box has no way today to stamp that one setting onto every receipt it reads — and the box refuses to store an amount without its currency, because `17.52` on its own is a number you have to know the context of, and a guess would mislabel every receipt of a shop that is not in the currency we guessed. So **receipts are not among the things this connection reads**, and asking the assistant about your Loyverse orders or takings gets an honest "not served from Loyverse", not an empty list. Customers and items do carry amounts too (lifetime spend, price) and arrive with the currency field empty; those are optional in the shape the box stores, and are read.

This is the one gap on this page we consider a real shortfall rather than a vendor quirk, and it is recorded as an open decision in the box's own design record. When receipts do arrive, two Loyverse facts will matter that do not today: the free tier shows sales for the **last 31 days** only (seeing further back is the **Unlimited Sales History** add-on, at **$5 per store per month**), and Loyverse returns sales and refunds in one list, so a refund would arrive as a receipt with a positive amount next to the sale it refunds. Neither affects customers or items.

---

## Plan prerequisite

**None. Loyverse POS is free, and "Integrations" is a free feature.** There is no API plan, no application to submit, and nobody at Loyverse reviews anything. Warp Lab is not in the loop either: you create the token inside your own account and paste it into your own box, so there is no consent screen with our name on it and nothing of ours that can be revoked on your behalf. [`SETUP.md`](SETUP.md#31-why-you-create-the-credential-and-we-do-not) explains why that is the shape for every connector in this set.

Customers and items — everything this connection reads — are not behind any add-on. The paid **Unlimited Sales History** add-on concerns receipts, which the box does not read yet (see the top of this page).

**Open: who can make the token.** Loyverse's help article describes the Access Tokens page in the Back Office and does not say whether an employee with limited Back Office rights can reach it. Make the token as the **account owner** and the question does not arise.

---

## Cost

**None to connect.** Loyverse does not charge for access tokens or for the calls Droplet makes. Creating a token is free, and it is free on the free account. Connecting Droplet adds nothing to your Loyverse bill.

**No add-on is needed for anything on this page.** Loyverse's paid add-ons — Unlimited Sales History ($5 per store per month), Employee Management and Advanced Inventory (each $25 per store per month) — concern receipts, staff and stock, none of which this connection reads.

There is one thing to know that is not a cost but behaves like one. **Loyverse allows 300 requests every 300 seconds per account.** Droplet paces itself against that figure deliberately — one request a second — rather than sprinting and being cut off, and it asks for the largest page Loyverse offers so a shop's customer book is usually one request. In practice you will not notice. The reason it is written here is that the allowance is **per account, not per token**: if you also run another tool against the same Loyverse account, the two of you are sharing it.

---

## Click-path

Do this in a browser, signed in to the Loyverse Back Office **as the account owner** — see [Plan prerequisite](#plan-prerequisite) for why.

1. Sign in to the **Loyverse Back Office** (the web dashboard, not the POS app on the till).
2. In the left-hand menu open **Integrations**, then **Access tokens**. (Loyverse's own direct link to that page is printed in their API reference; if the menu has moved, search the help centre for "access tokens".)
3. Click **+ Add access token**.
4. **Name it something you will still recognise in two years.** `Droplet — <your shop name>` beats `token 2`. The name is the only thing that will later tell you which token belongs to the box, and you will want that on the day you rotate or revoke it.
5. **Set an expiration date, on purpose.** Loyverse offers one and does not insist. Because this token can do everything in your account (see the top of this page), an expiry is your only control over it once it leaves your hands. A dated token gives you a connection that works perfectly on install day and then stops on a Tuesday months later — so if you set one, **write the date in your calendar now**, because nothing else will remind you; the box cannot see the date. If you would rather not diary it, choose no expiry and rely on deleting the token when the box goes.
6. Click **Save**, then **copy the token**. Loyverse allows up to **20 tokens per account**, so making one for the box costs you nothing you will miss.
7. In Droplet: **Integrations → Loyverse → Connect**, read the capability statement, paste the token, and confirm. The box checks it with a single call to Loyverse's "merchant" endpoint, which returns your business name and currency and nothing else — so a failure here is unambiguous evidence about the token rather than about your data.

---

## Scopes and permissions

**There are none to set** — Loyverse's token form offers a name and an optional expiry, and no permission list. This section is therefore not a set of choices; it is a description of what the box actually does with a token that could do more.

| What Droplet reads | Loyverse endpoint | Why |
|---|---|---|
| **Customers** | `/v1.0/customers` | Each customer's identifier, email, lifetime spend, and when the record was made and last changed. |
| **Items** | `/v1.0/items` | Each catalogue item's identifier, name, first variant's SKU and price, and when it was made and last changed. Deleted items are read too, so a deletion reaches the box as a change rather than as an item that quietly stopped arriving. |
| **Your merchant profile** | `/v1.0/merchant/` | Not stored as business data. It is the single cheap call the box uses to check the token still works. |
| *Receipts* | *`/v1.0/receipts`* | **Not read.** See the top of this page: a receipt carries no currency, and the box will not store an amount without one. |

The box opens outbound connections to exactly one address, **`api.loyverse.com`**, and to nothing else. That is a registered destination in the box's own egress list, not a matter of trust — an address that is not on that list is not reachable from the connector at all.

**Droplet does not write to Loyverse.** It cannot create or edit a receipt, add or delete a customer, change an item or its price, or touch inventory. Those surfaces do not exist in the connector at any level: the whole connector family Loyverse runs on is read-only by construction, with no write path to disable. The *token* can do all of those things; the box has no code that would.

### What Droplet deliberately leaves blank, and why

Rows on the box are stored in a shared shape that other vendors also fill. Loyverse does not carry everything that shape has room for, and rather than fill the gaps with something that looks close, Droplet leaves them empty. This is the section to read if you were expecting them.

- **Currency, on every row.** A Loyverse customer or item carries no currency. Your currency is one setting on your whole account, and the box has no way today to stamp that one setting onto every row it reads. So a customer's lifetime spend and an item's price arrive as the decimal numbers Loyverse gives — `120.55`, `10.00` — with the currency field empty. On these two the field is optional and the row is still useful; on receipts it is required, which is why receipts are not read at all (see the top of this page).
- **A customer's first and last name.** Loyverse has one *name* field. Splitting "Mary Ann Smith" or "van der Berg" on a space is a guess, so the box keeps neither half. One consequence: **asking the assistant to find a customer *by surname* returns nothing from Loyverse**, while listing customers works. That is honest rather than helpful, and it is written down so it is not a support call.
- **A customer's number of orders.** Loyverse gives a number of *visits*, and does not say a visit is a receipt. The box does not pretend it is.
- **Stock on hand.** Loyverse keeps stock on a separate endpoint, per variant per store, which the box cannot join to the item today. One consequence: **asking the assistant what is running low returns nothing from Loyverse.**
- **Everything but the first variant of an item.** A T-shirt in three sizes is one item with three variants in Loyverse, each with its own SKU and price. The box records the first. If your catalogue relies on variants, know that the box has the first one's SKU and price and not the others. An item whose price is *variable* — typed at the till — has no price on the box at all, rather than a zero that would read as "free".

### Two facts about how Loyverse lists things, which the box already handles

- **Newest first.** Loyverse returns customers and items newest-first, and offers no way to change that. The box therefore reads every page of a sync before it decides where it is up to, and an interrupted sync does not move forward at all — so a page you never got is a page you will get next time.
- **Deleted customers may not be visible as changes.** Loyverse's documentation says two different things about whether a deleted customer is kept for a while or removed at once, and says nothing about whether the box would see one in the meantime. The box's periodic full re-read is what notices a customer who has vanished; the day-to-day sync is not.

---

## Rotation and expiry

**A Loyverse token expires if you told it to.** This is the exception to the general rule on the shared page ([`credential-handling.md`](credential-handling.md)) that these credentials do not expire: Loyverse offers an expiry date at creation, so whether this connection has an end date is a decision you already made in step 5 of the click-path. If you set one, it is yours to diary — the box cannot see the date, and there is nothing it can do about it in advance.

**Rotating on purpose is clean here, because Loyverse allows 20 tokens per account.** Create the new token in **Integrations → Access tokens**, paste it into Droplet at **Integrations → Credentials** — the page that exists for exactly this, and which does not mean redoing the connect wizard — confirm the connection reports healthy, and only then delete the old token. Done in that order there is no outage. Rotation replaces the stored credential and leaves everything else alone: the connection keeps its identity, and everything already synced stays.

**Treat the token as belonging to the account, not to a person.** Loyverse tokens are made in the Back Office of the *account*, and the box's check call returns the *merchant*, not a user. So unlike Cal.com or Pipedrive, a staff member leaving does not by itself stop this connection — which cuts both ways: the token outlives the person who made it, so rotate it when the people who could have copied it change.

---

## Revocation

**You control this entirely. We cannot revoke on your behalf**, and Droplet finds out only on its next call.

**To stop Droplet reading Loyverse:**

- **On the box:** `Integrations → Loyverse → Manage → Disconnect`. This purges the stored token from the box and stops all reading. Data already synced stays until you delete it.
- **At Loyverse:** go to **Integrations → Access tokens** in the Back Office, find the token by the name you gave it, and **delete** it. Do this as well as disconnecting. Disconnecting stops Droplet using the token; only deleting it at Loyverse stops the token existing — and remember that this token could write to your account, so a token that still exists is a standing capability, not just a stale login.

**Do both, in that order**, if you are decommissioning a box or handing it back.

**If you suspect the box has been tampered with**, delete the token at Loyverse **first**. That takes effect immediately and does not depend on the box being reachable or cooperative — which is the whole reason the vendor-side step is not optional, and it matters more here than for a read-only credential.

**What a revoked or expired token looks like on the dashboard:** the connection moves to a named state saying the credential no longer works, and sync pauses. It does not show an empty customer book. That distinction matters: "no new customers" is a completely believable answer for a quiet week, and there would be no way for you to tell it apart from a broken connection — so Droplet never gives it. A problem is always reported as a problem, never as an empty list.

**Deleting your data.** Droplet can delete everything it has read from a Loyverse connection, on request, scoped to that one connection — so a box serving two Loyverse accounts cannot lose the wrong one's data. Ask, and it is done as a single action.

---

**Related:** [`credential-handling.md`](credential-handling.md) · [`SETUP.md`](SETUP.md#3-track-b--a-cloud-service-you-already-pay-for-cloudsaas-providers) · [`README.md`](README.md)
