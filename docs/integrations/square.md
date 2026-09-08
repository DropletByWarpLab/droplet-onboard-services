# Connecting Square

> **Audience:** the person who owns the Square account — the same account that takes the payments.
> **Time:** about five minutes. Nothing to install, nothing to pay for.
> **What Droplet does with what you paste:** [`credential-handling.md`](credential-handling.md).
> **Sources checked 2026-09-07** — against Square's own developer documentation: the access-token guide, the Developer Console reference, the Orders quick-start, and the OAuth pages. **Not yet walked through the live Square Developer Console by us**, so treat the screen and button names below as a close guide rather than a screenshot. One question on this page is explicitly still open — how you *rotate* this token — and it is flagged as open rather than guessed at.

---

## Read this before you paste: a Square access token is your whole Square account

Stripe has a read-only key. Klaviyo lets you pick a scope. **Square gives you neither.**

Square's own documentation says it in one sentence: *"Personal access tokens never expire and they have all permissions associated with the account owner."* And, on the same subject: *"A personal access token can be used to impersonate the account owner and gain full access to account resources."* The page you are about to open carries its own warning — *"The access token on the Credentials page has permissions to update all Square account data. You should therefore not share this access token with other people."*

There is no scope picker anywhere in this flow. The steps are: create an application, open Credentials, choose Production, copy.

So the token you are about to create can do anything you can do in Square: take payments, issue refunds, change your catalogue, read and edit your customer list.

**Droplet only ever reads, and it reads three things: payments, refunds and payouts.** That is the whole of it. It does not read your orders, your invoices, your customers, your catalogue or your Square Appointments bookings — see [Scopes and permissions](#scopes-and-permissions) below, which lists each one and says why. And it cannot write to Square at all: the connector Square runs on has no write path in it to switch off, so "writes are off" is not a setting anyone could turn back on.

But *us* being read-only does not make *the credential* read-only. Treat this token like the password to your till:

- give the application a name you will recognise — `Droplet — <your office name>`, not `My App` — because that name is the only thing that will later tell you which one belongs to the box;
- the token can be read again from the Credentials page by anyone who can sign in to your Square account, so that sign-in is the real perimeter: put two-factor authentication on it if you have not already;
- if you ever think the box has been tampered with, deal with it at Square first — see [Revocation](#revocation), and read it *before* you need it, because it is the one section on this page with a genuine gap in it.

---

## Plan prerequisite

**None.** Any Square account can do this, on any plan. There is no tier to upgrade to, no application to submit, and nobody at Square reviews anything.

Warp Lab is not in the loop either. You are not authorising a Warp Lab application and there is no consent screen with our name on it — you create a credential inside your own account and paste it into your own box. Nothing of ours can be revoked, expired or rate-limited on your behalf, because nothing of ours is in the path. That is the standing shape for every connector in this set; [`SETUP.md`](SETUP.md#31-why-you-create-the-credential-and-we-do-not) explains why.

The one prerequisite that is not a plan: **you must be able to sign in at `developer.squareup.com` with the same Square account that took the payments you want read.** It is the same sign-in as your Square Dashboard — there is no separate developer account to register, and no fee for it. A token created against a *different* Square account will authenticate perfectly and then show you somebody else's payments, or nobody's.

---

## Cost

**None.** Square does not charge for API access, for creating an application, or for the calls Droplet makes. Connecting Droplet adds nothing to your Square bill. Square's processing fees are what you pay for *taking* a payment; reading it back afterwards is free.

**On rate limits, Square publishes no number, and neither will we.** Most vendors in this set state a ceiling — Cal.com says 120 requests a minute, Klaviyo publishes a per-endpoint table. Square publishes no ceiling and returns no rate-limit headers on its responses; its documented behaviour is to answer `RATE_LIMITED` when it decides to. So Droplet does not pace itself against an invented figure — it makes its reads, and if Square asks it to slow down it waits and tries again rather than reporting a fault. A number printed here would be a guess wearing a fact's clothes, and you would plan around it.

---

## Click-path

Do this in a browser, signed in as the owner of the Square account.

1. Go to **`developer.squareup.com/apps`** and **sign in with the same Square account you already use.** This is the Square Developer Console. It is not a separate product and there is nothing to sign up for.
2. **Create an application** and name it. `Droplet — <your office name>` beats `Untitled`. You will be looking for this name again on the day you rotate or remove it.
3. **Open the application** you just made.
4. In the left pane, choose **Credentials**.
5. **🔴 At the top of the page, make sure the environment says `Production`, not `Sandbox`.** This is the step people get wrong, and it fails in a way that looks like a typo rather than a wrong setting. Square issues every application *two* tokens: a Production one and a Sandbox one. They are not interchangeable — Square's Sandbox is a separate service on a separate address (`connect.squareupsandbox.com`), and Droplet only ever dials `connect.squareup.com`. Paste the Sandbox token and the box gets an authentication failure from a real host against a token that belongs to a different world.
6. In the **Production Access token** box, choose **Show** and copy your token. Square's own wording, verbatim: *"In the **Production Access token** box, choose **Show** and copy your token."*
7. In Droplet: **Integrations → Square → Connect**, read the capability statement, paste the token, and confirm. The box checks it with one call to your **locations** list — the cheapest authenticated read Square offers, and one that takes no parameters, so a failure here is unambiguous evidence about the token rather than about one product's permissions.

**Unlike most credentials in this set, you can come back for this one.** Brevo and Klaviyo show a key once and never again; Square's Credentials page will show you the Production token again whenever you are signed in. That is a relief on the day you mistype it, and it is exactly why the Square sign-in itself matters as much as the token does.

---

## Scopes and permissions

**There are none to set.** A Square personal access token carries the account owner's full permissions, and Square offers no way to narrow it in this flow. Nothing in this section is a choice you get to make — it is a description of what you are handing over, and of the much smaller thing Droplet actually does with it, so you can decide whether you want to.

| What Droplet reads | Square endpoint | Why |
|---|---|---|
| **Payments** | `/v2/payments` | What you took, when, how much, in what currency, its status, and how much of it has been refunded. |
| **Refunds** | `/v2/refunds` | What you gave back, against which payment, and why. |
| **Payouts** | `/v2/payouts` | Money moving from Square to your bank: amount, currency, status, and the date it is expected to arrive. |
| **Locations** | `/v2/locations` | Not stored as business data. It is the single cheap call the box uses to check the token still works. |

The box opens outbound connections to exactly one address, **`connect.squareup.com`**, and to nothing else. That is a registered destination in the box's own egress list, not a matter of trust — an address that is not on that list is not reachable from the connector at all.

**Droplet does not write to Square.** It cannot take a payment, issue a refund, edit your catalogue, or change a customer record. Those surfaces do not exist in the connector at any level: the whole connector family Square runs on is read-only by construction, with no write path to disable.

### What Droplet does *not* read from Square, and why

Square's API reaches more than the three things above. Each of the others is left out for a specific reason, and they are listed here rather than quietly missing, so that "Droplet does not show my Square orders" is an answer you already have rather than a support call.

- **Orders.** Square only lets you list orders through a *search* request that carries its filters inside the body of the message. Droplet's connector for vendors like Square asks plain questions over a URL; a search-with-a-body is a different shape of request, and a change to shared machinery rather than a Square setting. It is a planned extension, not a refusal.
- **Invoices.** Square requires you to ask for invoices one location at a time, and — the part that decides it — a Square invoice record carries **no total**. The amount would have to be added up from the payment requests on it, or fetched from a linked order. An invoice list with a computed total that might be wrong is worse than no invoice list.
- **Customers.** Square's customer list cannot be filtered, or even sorted, by when a record last changed. Reading it at all would mean re-reading your entire customer book on every sync, forever. That is a decision about how hard the box hammers your Square account, and it deserves to be made deliberately rather than as a side effect.
- **Catalogue / products.** Stock levels come from a different call, an item's status has to be inferred, an item has no creation date at all, and a variation's name lives on its parent record. Four of the nine things Droplet would want are somewhere else.
- **Square Appointments.** The appointment records on your box are shaped for clinical practice management — they have a *patient* and an *operatory* (a treatment room). A Square customer is not a patient and a Square location is not an operatory. Putting retail bookings into a patient-shaped record would make them look like clinical data, and that is a decision about what those records *mean*, not a mapping detail.

### Two things about the numbers, so they do not surprise you

- **A payout can be negative.** Square uses a positive amount for a deposit and a negative one for a withdrawal. Droplet reports it exactly as Square does. It does not take the absolute value, because that would show money leaving your account as money arriving in it.
- **A payout's status can update late.** Square lets Droplet ask "what changed since last time" for payments and refunds, but the only filter on payouts is *when the payout was created* — so a payout that moves from Sent to Paid days later would never come up again by that route.
- **Droplet reads Square when you ask, and does not keep a copy.** Every question about your payments, refunds or payouts goes to Square at the moment you ask it, so what you see is whatever Square says right then — which also means the late-status point above cannot leave you with a stale answer sitting on the box. Nothing is stored, so there is nothing to go out of date, and there is no background job reading your Square account on a timer.

**One note on API versions, which costs you nothing but is worth knowing.** Square pins each application to a default API version, shown on the same Credentials page. Droplet does not use it — it states the version it was written against on every single call. So changing the version on your Credentials page cannot silently change the shape of the data the box reads, and neither can the passage of time.

---

## Rotation and expiry

**The token does not expire.** Square: *"Personal access tokens never expire and they have all permissions associated with the account owner."* There is no date to diary and no renewal email — which is the good news and the bad news in one sentence. A token created today is still a full-access key to your Square account in five years, in the hands of whoever has a copy by then. The shared page ([`credential-handling.md`](credential-handling.md)) explains the general case; Square is the clearest example of it.

**Rotating on purpose — and the one gap on this page.** Square's documentation is detailed about revoking *OAuth* tokens (there is a `RevokeToken` endpoint, and a seller-facing disconnect in the Square Dashboard) and says nothing at all about regenerating or removing the personal access token on your own application's Credentials page. We have not walked the live console, so rather than describe a button that may not be there:

1. Open **Credentials** and look for a rotate or regenerate control on the Production access token. If it is there, use it — then paste the new value into Droplet at **Integrations → Credentials**, the page that exists for exactly this and does not mean redoing the connect wizard.
2. If it is not there, rotate by **creating a second application** in the Developer Console, copying *its* production token, pasting that into Droplet, confirming the connection reports healthy, and only then retiring the first one. Done in that order there is no outage — rotation replaces the stored credential and leaves everything else alone, so the connection keeps its identity and everything already synced stays.

If you find the control, we would like to know; this section will then say so instead of hedging.

**Do rotate when someone leaves.** A Square token is not tied to the person who copied it — removing their user does not break it, which is convenient and is also the trap. Anyone who has ever held the value still holds a full-permission key. Rotate it, and rotate it if the token has ever been pasted into a chat message, a ticket or a shared document.

**Do not use this token anywhere else.** It is not scoped, so a second tool holding the same value is a second full-access copy with none of the box's handling. Give each tool its own application and its own token, so that retiring one does not mean an outage for the others.

---

## Revocation

**You control this entirely. We cannot revoke on your behalf**, and Droplet finds out only on its next call.

**To stop Droplet reading Square:**

- **On the box:** `Integrations → Square → Manage → Disconnect`. This purges the stored token from the box and stops all reading. Data already synced stays until you delete it.
- **At Square:** rotate or remove the token, using the procedure in [Rotation and expiry](#rotation-and-expiry) above. **This is the half we cannot give you an exact click-path for**, and it is the honest weak point of this connector: Square documents no console control for revoking a personal access token, so we will not send you hunting for a specific button.

**Do not confuse this with "My Applications" in your Square Dashboard.** That screen disconnects *third-party* applications you authorised through Square's OAuth flow — an accounting tool, a plugin. Droplet is not one of those. You did not authorise us; you made a credential inside your own developer account. Disconnecting things on that screen will not touch the token you pasted into the box, and the fact that it *looks* like the right screen is exactly why it is named here.

**If you suspect the box has been tampered with**, do not start on the box. Because the reliable revocation path at Square is unclear, the fastest complete answer is at your Square account rather than at any one token: change the Square account password and sign other sessions out, which closes the console the token can be read from, then work through the rotation above. Disconnecting on the box stops *Droplet* using the token; only action at Square stops the token *working*.

**Do both**, in that order, if you are decommissioning a box or handing it back. An orphaned Square token is not a tidiness problem — it is a standing key that can move money.

**What a revoked or broken credential looks like on the dashboard:** the connection moves to a named state saying the credential no longer works, and sync pauses. It does not show zero payments, and it does not keep retrying into an error. That distinction matters here more than most: "you took no payments" is a believable-looking answer for a quiet week, and there would be no way for you to tell it apart from a broken connection — so Droplet never gives it. A problem is always reported as a problem, never as an empty list.

---

**Related:** [`credential-handling.md`](credential-handling.md) · [`SETUP.md`](SETUP.md#3-track-b--a-cloud-service-you-already-pay-for-cloudsaas-providers) · [`README.md`](README.md)
