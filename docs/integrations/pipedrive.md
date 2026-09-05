# Connecting Pipedrive

> **Audience:** the person who owns the Pipedrive account.
> **Time:** about five minutes, assuming your user already has API access switched on. If it does not, you need an administrator for one of the steps.
> **What Droplet does with what you paste:** [`credential-handling.md`](credential-handling.md).
> **Sources checked 2026-09-03** — against Pipedrive's own developer and support documentation. **Not yet walked through the live Pipedrive console by us**, so treat the screen and menu names below as a close guide rather than a screenshot. Where something is genuinely uncertain, this page says so rather than guessing.

---

## Three things to know before you start

**1. Droplet asks you for two things, and only one of them is the key.**

The other is your **company domain** — the bit of your Pipedrive web address before `.pipedrive.com`. If you sign in at `acme-sales.pipedrive.com`, your company domain is `acme-sales`.

That is not a formality. Pipedrive keeps different customers' data in different data centres, and the company domain is what tells Droplet which one your account lives in. There is no single Pipedrive address the box can just know. Get it wrong and the box is knocking on a door that is not yours — which is exactly why Droplet checks it before it stores anything, and refuses anything that is not a plain single name.

Read it off your browser's address bar while you are signed in. Just the name — not `https://`, not the whole address.

**2. A Pipedrive API token is full account access. There is no read-only option.**

Pipedrive issues one kind of personal API token, and it carries **exactly the permissions of the user who created it**. Whoever holds it can read, create, edit, delete, merge and export — everything that user can do in the web app. Pipedrive's own help text puts it plainly: the key grants access to your account, and you should not share it with anyone you would not be comfortable sharing the data with.

There is no narrower variant to ask for. Some other systems let you mint a read-only key; Pipedrive does not.

**We would rather say this plainly than let you discover it. Connecting Pipedrive means handing the box a credential with full access to your sales system of record.** Droplet only ever reads, and the connection ships read-only with no write path in it at all — but that is a property of our software, not a boundary Pipedrive enforces. If that trade is not one you want to make, the honest answer is not to connect Pipedrive.

**3. There is one way to narrow it, and it depends on your plan.**

Because the token inherits its creator's permissions, you can limit what it reaches by creating it from a **dedicated Pipedrive user in a restricted permission set** — a login that exists only for this, with access to only what the box should mirror.

Custom permission sets are a **higher-tier Pipedrive feature**. On the entry plan you cannot create one, which means the token you create is full access to everything, and no amount of care on your side changes that. See the plan section below.

---

## Plan prerequisite

**Any paid Pipedrive plan will work. There is no free Pipedrive tier at all** — every plan is paid, with a 14-day trial and no permanently free option.

The good news: **API access is not gated behind a higher tier.** Pipedrive publishes API rate limits for its entry plan, so a customer on the cheapest plan can create a token and connect. You do not need to upgrade to integrate.

Two things about your plan do matter:

- **How fast Droplet may read.** Pipedrive allows more requests per second on higher plans. Droplet assumes the *lowest* allowance unless someone tells it otherwise, which is the safe default — it means the box will never overrun your limit, at the cost of reading a little more slowly than a higher plan would allow. If you are on a higher tier and syncs feel slow, that is a setting an installer can raise.
- **Whether you can scope the token at all.** Custom permission sets are a higher-tier feature. On a lower plan there is no way to create a limited user, so the token is unavoidably full account access.

**The prerequisite that trips people up is not the plan — it is a permission switch.**

API access is controlled per **permission set**, and its failure mode is that *nothing appears*. If the user you are signed in as does not have API access enabled, the API page simply is not in the menu. There is no error, no greyed-out button and no explanation, and it looks identical to having looked in the wrong place.

If you get to step 3 below and there is no **API** entry, that is what has happened. An administrator has to enable API access for your permission set under **Settings → Manage users → Permission sets**. It is a Pipedrive setting; Droplet cannot switch it on for you and cannot detect it in advance.

---

## Cost

**Nothing. Pipedrive does not charge for API access**, and the reading Droplet does is not billed to you.

**Droplet adds nothing to your Pipedrive bill.**

There is one budget worth knowing about even though it is not money. Pipedrive gives every account a **daily allowance of API calls** — a base amount multiplied by your plan and by how many user seats you pay for, resetting once a day. It is **shared by every integration you run against that account**, not just Droplet. On a single-seat entry plan it is not enormous.

What that means in practice:

- A routine daily sync is comfortably within it.
- A first full import of a large, long-established Pipedrive account is the one operation big enough to be worth thinking about, and an installer should schedule it rather than running it alongside your other integrations.
- If another tool of yours suddenly starts failing against Pipedrive on the same day the box does its first sync, this is the reason — and it clears by itself the next day.

One more: the allowance resets at midnight in **Pipedrive's** timezone, which is not necessarily yours. A job scheduled for your local midnight can land on either side of the reset.

**If you do not already pay for Pipedrive**, the cost of connecting it is the cost of a Pipedrive plan, because there is no free tier to fall back on.

---

## Click-path

Do this in a browser, signed in to Pipedrive.

1. **Sign in as the user whose access the box should mirror.** The token you are about to create carries that user's permissions exactly. If your plan allows custom permission sets, prefer a **dedicated user** created for this, in a restricted set, over your own login. If it does not, sign in as the person whose view of the pipeline the box should have.

2. **Read your company domain out of the address bar.** At `acme-sales.pipedrive.com/...`, the company domain is `acme-sales`. Write it down — Droplet asks for it separately from the token, because it is what tells Droplet which Pipedrive data centre to reach.

3. **Click your account name in the top right, then Company settings → Personal preferences → API.** The direct address is `app.pipedrive.com/settings/api`.

4. **If there is no API entry in that menu, stop here.** API access is switched off for your permission set. An administrator must enable it under **Settings → Manage users → Permission sets** before you can go on. This is the silent one described above — there will be no error telling you this is what happened.

5. **Copy your personal API token.** Copy it whole, from the first character to the last, with no space before or after it. Droplet refuses a value with a space or a line break in it rather than sending something malformed, so if you paste one that wrapped across two lines it will tell you.

   **Read this before you click anything that says "regenerate".** Pipedrive allows **exactly one active API token per user, per company**. Generating a new one immediately invalidates the old one, and anything else already using it stops working — silently, from that other tool's point of view. If you are not sure whether another integration is using this user's token, check before you regenerate, or create the dedicated user in step 1 instead.

6. **In Droplet: Integrations → Pipedrive → Connect.** Paste the company domain into the first field and the API token into the second. The token field is masked, is encrypted before it is written to disk, and is never shown back to you or written to a log.

7. **Click Connect.** Droplet makes one read-only call to confirm two things: that the token works, and that it belongs to the company domain you typed. It does this by asking Pipedrive which company the token is for and comparing the answer with what you entered. If that call is refused, nothing is stored.

   If it fails, **check the company domain first.** A token that is fine but paired with the wrong spelling of your domain fails in a way that looks exactly like a bad token.

8. **To disconnect later**, delete or regenerate the token on that same Pipedrive API page. That takes effect immediately, whether or not the box is reachable at the time. See the revocation section below for how to do this cleanly.

---

## Scopes and permissions

**There are none to choose.** Pipedrive issues one kind of API token, at one privilege level: whatever the user who created it can do. There is no scope screen, no permission checkboxes and no read-only variant to select.

What Droplet reads:

| What it reads | Why |
|---|---|
| **People (Pipedrive persons)** | Who your contacts are, with their primary email address. |
| **Companies (Pipedrive organizations)** | The businesses those people belong to. |
| **Deals** | The pipeline itself — name, stage, value and currency, and when a deal actually closed. |
| **Activities** | Calls, meetings and tasks logged against a deal or a person, so the box can answer "who have we not spoken to since the quote". |
| **Products** | Your product catalogue and its list prices. |

**Droplet does not write to Pipedrive.** It does not create deals, move stages, edit contacts, merge records, delete anything or export anything. There is no write path in the connector at any setting — not switched off, not present.

Because the token is account-wide, the boundary on this connection is entirely the box's read-only posture plus the fact that the token never leaves the box. That is a real difference from vendors where the credential itself is limited, and it is worth weighing before you connect.

**Two things Droplet cannot see, and will not pretend to.**

- **Deletions and merges.** Pipedrive only announces those to integrations that it can call back over the public internet, and the box deliberately accepts no connections from the internet. So if you delete a contact or merge two companies, Droplet will not learn about it from a routine sync. Deals are **not** an exception, despite a detail that looks like one: Pipedrive itself keeps a deleted deal visible for 30 days, but Droplet does not ask for deleted records on any dataset, so it does not learn about them either. If you delete or merge things regularly, treat what Droplet shows as a copy that lags on removals and confirm against Pipedrive before acting on an absence.
- **Changes made to a related record.** Logging a call against a deal does not count as changing the deal. Droplet tracks each kind of record on its own clock for that reason.

Neither of these is a Droplet feature that is missing. They are properties of how Pipedrive works with a system that has no public address, and the connector reports them rather than quietly leaving gaps in what it tells you.

---

## Rotation and expiry

**Pipedrive API tokens do not expire.** The one you create today still works in three years unless somebody removes it. Nothing on Pipedrive's side will prompt you to reconsider it, and nothing on ours can — see [`credential-handling.md`](credential-handling.md).

**Rotation is unusual here, and it is the thing most likely to surprise you.** Because Pipedrive allows only one active token per user per company, you cannot create the new one first and retire the old one afterwards, the way you would with most systems. Regenerating **is** the rotation, and the old token stops working the instant you do it.

So:

- **If this user's token is only used by Droplet:** regenerate it on the API page, then paste the new value into Droplet straight away. There will be a short window where the box cannot read; it recovers as soon as you paste.
- **If anything else uses it:** do not regenerate. Create a **separate Pipedrive user** for Droplet instead and take a token from that one. Then each system has its own credential and can be rotated without taking down the other. This is the arrangement worth setting up before you need it.

Rotation replaces the stored credential and leaves everything else alone — the connection keeps its identity, and everything already synced stays.

**Do rotate when someone leaves.** The token is full account access and never expires, so an old Pipedrive token belonging to a departed colleague is one of the most valuable stray credentials a business can leave lying around. If the person who created it has gone, or the token has ever been pasted into a chat message or a shared document, replace it.

**Your company domain can change too.** An administrator can rename it from Pipedrive's account settings, and when they do, the old one stops working. Pipedrive does not notify integrations. Droplet notices at its next read — it compares the domain it has stored against the company the token actually belongs to — and reports that the domain needs updating rather than quietly failing. If you rename your company domain, tell whoever looks after the box.

---

## Revocation

**You control this entirely. We cannot revoke on your behalf**, and Droplet finds out at its next call.

**To stop Droplet reading Pipedrive:**

- **On the box:** `Integrations → Pipedrive → Manage → Disconnect`. This purges the stored token and the company domain from the box and stops all reading. Data already synced stays until you delete it.
- **At Pipedrive:** go to **Company settings → Personal preferences → API** as the user whose token it is, and regenerate or delete the token. Do this as well as disconnecting. Disconnecting stops Droplet using the token; only removing it at Pipedrive stops the token existing.

**Do both, in that order**, if you are decommissioning a box or handing it back. This matters more here than for most vendors, precisely because the token is full account access.

**If you created a dedicated Pipedrive user for the box**, the cleanest revocation is to **deactivate that user** rather than regenerate a token. It takes away everything at once, it cannot be undone by someone re-pasting an old value, and it does not disturb anyone else's integrations.

**If you suspect the box has been tampered with**, regenerate the token at Pipedrive first — that takes effect immediately and does not depend on the box being reachable or cooperative. Then disconnect on the box when you can.

**What a revoked token looks like on the dashboard:** the connection moves to a named state saying the credential no longer works, and sync pauses. It does not show an empty pipeline. That distinction is deliberate — "no deals" and "we could not read your deals" are different answers, and the box will never give you the first when it means the second.

---

**Related:** [`credential-handling.md`](credential-handling.md) · [`SETUP.md`](SETUP.md#3-track-b--a-cloud-service-you-already-pay-for-cloudsaas-providers) · [`README.md`](README.md)
