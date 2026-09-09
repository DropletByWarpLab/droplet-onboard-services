# Connecting Brevo

> **Audience:** the person who owns the Brevo account.
> **Time:** about five minutes. Nothing to install, nothing to pay for.
> **What Droplet does with what you paste:** [`credential-handling.md`](credential-handling.md).
> **Sources checked 2026-09-03** — against Brevo's own developer documentation, its live API definition, and its help centre. **Not yet walked through the live Brevo console by us**, so treat the screen and button names below as a close guide rather than a screenshot. If a name has moved, the sequence still holds: your account menu → SMTP & API → API Keys & MCP → generate.

---

## Read this before you paste: a Brevo API key is your whole account

Stripe has a read-only key. Shopify has a permission list. **Brevo has neither.**

Brevo's own help centre puts it in one sentence: *"API keys give full access to your Brevo account and should be protected in the same way as a password."* There is no read-only key, no per-resource scope picker, and nothing in the key-creation flow that lets you narrow it. We checked the current flow specifically to see whether one had appeared: it has not. The steps are name, expiry, generate, copy.

So the key you are about to create can:

- **send email from your own domain**, to anyone in your account,
- read, edit and **delete your contacts**,
- create, edit and **delete your campaigns**.

**Droplet only ever reads.** The connector refuses every write, and the send and order-creation endpoints are unreachable from it — not "switched off", but absent from the list of addresses it is able to build. That is a property of the code, and the test suite fails the build if a send surface appears in it.

But *we* being read-only does not make *the credential* read-only. Treat this key like the password it is:

- give it a name you will recognise, so you can find and delete it later;
- delete it in Brevo the day the box is decommissioned or handed back;
- if you ever think the box has been tampered with, **delete the key at Brevo first** — that takes effect immediately and does not depend on the box being reachable or cooperative.

---

## Plan prerequisite

**None.** The free plan is enough, and it is not a trial.

Brevo's own rate-limit documentation states that the general API limits are *"Available to all account types (Free, Starter, Standard, Professional, and Enterprise)"*. The Sales Platform — the companies and deals Droplet reads — is advertised on the same terms: *"Build your custom sales pipeline on the free plan, no credit card required."*

You do need to be signed in as someone who holds the **API keys** permission — the account owner, or a teammate granted it. Brevo is explicit: *"Only Brevo users with API keys permission can access the API Keys & MCP page, create a new API key, or delete an existing API key."* Without it, the page is not there at all — the button does not error, it simply does not exist.

---

## Cost

**None.** Brevo does not charge for API keys, for API calls, or for the volume of data you read. Connecting Droplet to Brevo adds nothing to your Brevo bill.

There is one thing to know that is not a cost but behaves like one. Brevo meters the API in **requests per hour**, and the meter is very uneven: contact endpoints get 36,000 requests an hour, while *everything else* — campaigns, companies, deals, orders — shares **100 requests an hour**. Droplet budgets those two groups separately and slows itself down rather than being cut off. In practice you will not notice; the reason it is here is that if you also run another tool against the same Brevo account, the two of you share that 100.

---

## Click-path

Do this in a browser, signed in to Brevo as the account owner.

1. Go to **app.brevo.com** and sign in as the account owner, or as a user who holds the **API keys** permission.
2. Click your **account name in the top-right corner** and choose **SMTP & API**. (Direct link, and the one to use if the menu has moved: `https://app.brevo.com/settings/keys/api`)
3. Open the **API Keys & MCP** tab. (It was called "API keys" until recently; same place.)
4. Click **Generate a new API key**.
5. **Name it something you will still recognise in two years.** `Droplet — <your office name>` beats `key 2`. The name is the only thing that will later tell you which key belongs to the box, and you will want that on the day you rotate or revoke it.
6. **Set the expiry to "no expiration".** Brevo makes you choose: *"Set an expiry date from 7 days to 1 year or choose no expiration for the API key."* A 7-day or 30-day key gives you a connection that works perfectly on install day and dies silently weeks later — and Brevo's warning email goes to you, never to the box. If your own security policy forbids a non-expiring key, that is fine, but **write the expiry date in your calendar now**, because nothing else will remind you.
7. **Do NOT tick "Create MCP server API key".** This is the trap in the current dialog. Brevo: *"If you activate the Create MCP server API key, the API key created in step 4 is deactivated and a MCP version of the API key is generated instead."* Tick it and the key you are about to copy is already dead — you will paste it into Droplet and get an error that looks exactly like a typo.
8. Click **Generate**, then **copy the key immediately.** Brevo shows it once: *"Your API key is only visible during this step. Once your API key is created, you won't be able to copy it anymore and you'll need to create a new one if you lose it."*
9. In Droplet: **Integrations → Brevo → Connect**, read the capability statement, paste the key, and confirm. The box validates it with a single call to your account details. An error here means the key is wrong, expired, deactivated or IP-blocked — not that Brevo is down.
10. **Now do the IP step below. It is not optional.** Go to **Settings → Security → Authorized IPs** and either add your office's public IP address, or switch automatic blocking off. See the next section for why this matters more than it looks.

---

## Scopes and permissions

**There are none to set.** This is the whole of it: a Brevo API key carries full account access and Brevo offers no way to narrow it. Nothing in this section is a choice you can make — it is a description of what you are handing over, so you can decide whether you want to.

| What Droplet reads | Brevo endpoint | Why |
|---|---|---|
| **Contacts** | `/contacts` | Your address book: who they are, when they were added, when they last changed. |
| **Lists** | `/contacts/lists` | The lists themselves, with their current subscriber counts. |
| **List membership** | `/contacts/lists/{id}/contacts` | Who is actually on which list — and, importantly, **who has opted out**. |
| **Email campaigns** | `/emailCampaigns` | What was sent, when, and how it performed: delivered, unique opens, unique clicks. |
| **Companies** | `/companies` | Sales Platform companies. Empty if you have never used it — that is a real empty, not a fault. |
| **Deals** | `/crm/deals` | Sales Platform pipeline: stage, owner, value. |
| **Orders** | `/orders` | E-commerce orders, if you have a storefront synced into Brevo. |

**What Droplet never touches:** transactional email, SMS and WhatsApp sending; contact creation, editing or deletion; campaign creation, editing or sending; order creation. Those addresses are not reachable from the connector at all.

### The setting that will break this connection weeks from now

Brevo has an IP-security feature, and **it turns itself on**. This is the single most common way a healthy Brevo connection dies, and it looks exactly like a dead credential, so it is worth reading twice.

Brevo's own description of the lifecycle: *"When you first use an API key, Brevo automatically authorizes the IP addresses that make API calls. This 'learning phase' means IP blocking is inactive, so you can set up and test your integration without restrictions."* Then: *"If no new IPs are detected for 30 days, Brevo automatically: Activates the blocking of unknown IP addresses."*

So roughly a month after a clean install, Brevo starts refusing any call from an address it has not seen — *"Requests from unauthorized IPs are blocked even if the API key is valid."* If your internet connection has a changing public IP address (most business broadband does), that day will come and nothing on either side will have changed.

Two things soften it, and one step removes it:

- **Small changes are safe.** Brevo authorizes a whole `/24` block: *"if the IP address is 192.168.1.25, Brevo will authorize the entire range from 192.168.1.0 to 192.168.1.255."* An ISP re-lease inside the same range survives. Only a jump outside it trips the block.
- **Droplet tells you which one it is.** The connection card names an IP block as its own state, separately from a bad key, so you are not sent to regenerate a key that was never the problem.
- **The fix is step 10 above.** Add the office's public IP at Settings → Security → Authorized IPs, or deactivate automatic blocking. Do it on install day, not on the day it breaks.

---

## Rotation and expiry

The shared page ([`credential-handling.md`](credential-handling.md)) explains that credentials like this generally do not expire. **Brevo is the exception**, in two separate ways, and both are silent.

**1. The expiry you chose.** Brevo's creation dialog forces a choice between 7 days and 1 year, or no expiration. If you accepted a short one, this connection has an end date. Brevo emails *you* 7 days before and again on the day; the box never sees those emails.

**2. The expiry you did not choose.** Separately: *"To improve security and reduce the risk of exposure from unused credentials, inactive API keys expire after 90 days."* This is the one that catches people out — a box switched off over a long shutdown, or a connection disconnected "for now", cannot simply be resumed months later. The key will have expired from disuse.

**Rotating on purpose.** There is no grace period and no rolling: create the new key first, paste it into Droplet, confirm the connection is working, and only then delete the old one in Brevo. Done in that order there is no outage. Rotation replaces the stored credential and leaves everything else alone — the connection keeps its identity, and everything already synced stays.

**You navigated away before copying the key.** Not recoverable, and not a support call: Brevo shows the value once. Create a **new** key, paste it into Droplet, and then delete the old one so you are not left with an orphan nobody is using.

**Someone left the company.** A Brevo key is not tied to the person who created it, so removing their user does not break it. That is convenient, and it is also the trap: the key outlives them silently. Rotate it anyway.

### Four different problems, one identical error

Brevo answers all four of these the same way, and no software on the box can tell them apart from the answer. If the connection card reports the credential as unusable, check them in this order:

1. **The key was deleted**, or was pasted incompletely.
2. **The key expired** — either the date you chose at creation, or the 90-day inactivity rule above.
3. **The key was deactivated at Brevo.** This is a real state, separate from deletion, and it is reversible — including the "Create MCP server API key" trap from step 7 of the click-path.
4. **Your IP is blocked** — see the previous section. Regenerating the key will not help; the key is fine.

---

## Revocation

**You control this entirely. We cannot revoke on your behalf**, and Droplet finds out only on its next call.

**To stop Droplet reading Brevo:**

- **On the box:** `Integrations → Brevo → Manage → Disconnect`. This purges the stored key from the box and stops all reading. Data already synced stays until you delete it.
- **At Brevo:** **Settings → SMTP & API → API Keys & MCP**, find the key by the name you gave it, and either **Deactivate API key** (reversible — it stops working but can be switched back on) or **delete** it (permanent).

**Do both, in that order**, if you are decommissioning a box or handing it back. Disconnecting stops Droplet using the key; only deactivating or deleting it at Brevo stops the key *existing*. And because the key is full account access, an orphaned Brevo key is not a tidiness problem — it is a credential that can still send mail from your domain.

**If you suspect the box has been tampered with**, deactivate or delete the key at Brevo **first**. That takes effect immediately and does not depend on the box being reachable or cooperative.

**What a revoked key looks like on the dashboard:** the connection moves to a named state saying the credential no longer works, and sync pauses. It does not show zero contacts, and it does not keep retrying into an error. If you see "no data" from Brevo — no companies, no deals, no orders — that means Brevo genuinely returned nothing, which is normal on an account that has never used the Sales Platform or the e-commerce module. A problem is always reported as a problem, never as an empty list.

---

**Related:** [`credential-handling.md`](credential-handling.md) · [`SETUP.md`](SETUP.md#3-track-b--a-cloud-service-you-already-pay-for-cloudsaas-providers) · [`README.md`](README.md)
