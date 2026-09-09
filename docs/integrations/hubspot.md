# Connecting HubSpot

> **Audience:** the person who owns the HubSpot portal — specifically, a **super admin**.
> **Time:** about five minutes. Nothing to install, nothing to pay for.
> **What Droplet does with what you paste:** [`credential-handling.md`](credential-handling.md).
> **Sources checked 2026-08-27** — against HubSpot's own developer documentation and the credential facts recorded in ADR-042 §2 (pinned to WARP-2317). **Not yet walked through the live HubSpot console by us**, so treat the screen and button names below as a close guide rather than a screenshot. If a name has moved, the sequence still holds: Settings → Integrations → Private Apps.

---

## Who creates this matters more than anything else on this page

**The private app must be created by a HubSpot super admin — and if that person later stops being a super admin, every call Droplet makes to HubSpot fails.**

Not degrades. Not partially works. Fails, entirely, with a permissions error, on a day that has nothing to do with the day anyone touched the integration.

This is the single most important paragraph in this guide, and it is here rather than in a troubleshooting section at the bottom because by the time you are troubleshooting it is already an outage — and because the connection between "we changed someone's HubSpot role in March" and "the integration broke in March" is not one anybody makes on their own.

**Why it matters especially in a small business.** The HubSpot super admin is very often the owner's first marketing hire, an agency, or an outside consultant. They set things up, and then they leave, or their contract ends, or someone tidies up permissions after an audit. Any of those removes super-admin from the person whose name is on the private app, and the integration stops working weeks or months later with no obvious cause.

**What to do about it, at creation time:**

- **Create the app under an account the business itself controls** — the owner's own HubSpot user, or a shared operations account the company keeps regardless of who is employed. Not a consultant's login. Not a departing employee's.
- **Write down whose account created it.** The private app page shows the app, but the dependency on that user's role is invisible until it breaks.
- **When that person leaves or changes role:** before removing their super-admin permission, have a current super admin create a **new** private app with the same scopes, paste the new token into Droplet, and then delete the old app. Doing it in that order means no outage. Doing it in the other order means an outage you will not diagnose quickly.

---

## Plan prerequisite

**None.** Private app access tokens are available on every HubSpot tier, including **Free**. There is no upgrade, no trial, and no Marketplace application involved.

The prerequisite is not a plan — it is a **person**: the app must be created by a **super admin**, and it keeps working only while that person remains one. See above.

One limit worth knowing: a HubSpot portal allows **20 private apps**. That is far more than a business will use, but if you have accumulated old ones it is worth tidying them before creating another.

---

## Cost

**None.** HubSpot does not charge for private apps, for access tokens, or for the API calls Droplet makes. Connecting Droplet to HubSpot adds nothing to your HubSpot bill.

---

## Click-path

Do this in a browser, signed in to HubSpot as a **super admin** on an account the business controls.

1. Click the **settings gear** in the top navigation.
2. In the left sidebar go to **Integrations → Private Apps**.
3. Click **Create a private app**.
4. On the **Basic Info** tab, name it something you will recognise in two years: `Droplet — <your office name>`. A description saying which box it belongs to is worth thirty seconds now.
5. Switch to the **Scopes** tab and tick the read scopes listed in the next section. Nothing else.
6. Click **Create app**, and confirm.
7. HubSpot shows the **access token** — it begins `pat-`. Click to reveal it and copy it.
8. In Droplet: **Integrations → HubSpot → Connect**, read the capability statement, paste the token, and confirm.

If Droplet reports the credential as the wrong kind, the usual cause is a **legacy portal API key** rather than a private app token. Those are a different, older, portal-wide credential, and Droplet does not accept them. The token you want starts `pat-`.

---

## Scopes and permissions

HubSpot scopes are ticked on the app at creation. Grant read scopes only; Droplet does not write to HubSpot.

| Scope | What it buys you |
|---|---|
| `crm.objects.contacts.read` | The people — names, emails, and their history with you. The backbone of every "what do we know about this customer" question. |
| `crm.objects.companies.read` | The organisations those people belong to, so contacts group into accounts. |
| `crm.objects.deals.read` | The pipeline: what is open, what stage it is at, what it is worth. |
| `crm.objects.line_items.read` | What the deals actually consist of, so a value is a list of things rather than a number. |
| `crm.schemas.contacts.read` and `crm.schemas.companies.read` | The definitions of your **custom properties**. Without these, custom fields arrive as opaque internal names and Droplet cannot tell you what they mean. Small scopes, disproportionate effect. |
| `tickets` | Support tickets, if you use HubSpot's service tools. Skip it if you do not. |

**Grant less if you want to.** A narrower app is a working app. If you omit a scope, Droplet names the missing permission and the question it cannot answer, rather than returning an empty list that reads as "you have no contacts".

**Do not grant write scopes.** Droplet is read-only against HubSpot. Nothing needs them, and nothing will use them.

**Changing scopes later** is straightforward on HubSpot's side — edit the private app, tick or untick, save. Nothing is irreversible and the token stays the same. That is worth noting because it is *not* true of every vendor.

---

## Rotation and expiry

**Private app access tokens do not expire.** The one you create today will still work in three years unless you rotate or delete it. Nothing on HubSpot's side will prompt you to reconsider it, and nothing on ours can — see [`credential-handling.md`](credential-handling.md).

**Rotating on purpose.** HubSpot supports rotating a private app's token with a grace period: the old token keeps working for up to **7 days** after you rotate. So the correct order is: rotate in HubSpot → paste the new token into Droplet → done. No outage, and no rush if you finish the second half tomorrow.

Rotation replaces the stored credential and leaves everything else alone — the connection keeps its identity, and everything already synced stays.

**The rotation that actually matters is the people one.** Re-read the top of this page. A token that never expires, tied to a role that can be removed, is a failure waiting for a staffing change. Rotate the app onto a durable account *before* the person who created it changes role, not after.

---

## Revocation

**You control this entirely. We cannot revoke on your behalf**, and Droplet finds out only on its next call.

**To stop Droplet reading HubSpot:**

- **On the box:** `Integrations → HubSpot → Manage → Disconnect`. This purges the stored token from the box and stops all reading. Data already synced stays until you delete it.
- **At HubSpot:** **Settings → Integrations → Private Apps**, open the app by the name you gave it, and **delete** it. Do this as well as disconnecting. Disconnecting stops Droplet using the token; only deleting the app stops the token existing.

**Do both, in that order**, if you are decommissioning a box or handing it back.

**If you suspect the box has been tampered with**, delete the private app at HubSpot first — that takes effect immediately and does not depend on the box being reachable or cooperative.

**What a revoked or broken credential looks like on the dashboard:** the connection moves to a named state saying the credential no longer works, and sync pauses. It does not show an empty CRM.

**And the one that catches everybody:** if HubSpot starts refusing every call with a permissions error and nothing about the integration changed, check whether the person who created the private app is still a **super admin**. That is the cause far more often than anything on the box.

---

**Related:** [`credential-handling.md`](credential-handling.md) · [`SETUP.md`](SETUP.md#3-track-b--a-cloud-service-you-already-pay-for-cloudsaas-providers) · [`README.md`](README.md)
