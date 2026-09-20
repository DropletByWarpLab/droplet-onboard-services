# Connecting Mailchimp

> **Audience:** the person who owns the Mailchimp account.
> **Time:** about three minutes — the shortest setup of the five.
> **What Droplet does with what you paste:** [`credential-handling.md`](credential-handling.md).
> **Sources checked 2026-08-27** — against Mailchimp's own developer documentation and the credential facts recorded in ADR-042 §2 (pinned to WARP-2379). **Not yet walked through the live Mailchimp console by us**, so treat the screen and button names below as a close guide rather than a screenshot. One question on this page is explicitly still open, and it is flagged as open rather than guessed at.

---

## Two things to know before you start

**1. The tail on the key is not noise, and you must not trim it.**

A Mailchimp API key looks like a long random string with a short suffix on the end:

```
••••••••••••••••••••••••••••••••-us14
```

That `-us14` is a **datacenter suffix**, and it is the part that tells Droplet *which Mailchimp server your account lives on*. Mailchimp runs many, and the address of the one holding your data is assembled from that suffix. Without it, the box does not know where to call.

So: **paste the key exactly as Mailchimp gives it to you, including the hyphen and everything after it.** The failure mode if you do not is nasty — a connection error that points nowhere near the real cause, because the box either cannot resolve a host or reaches the wrong one. Droplet refuses a key with no suffix outright rather than guessing at a default, precisely so that this never happens silently.

The two ways people lose the suffix, both easy to do by accident:

- **Tidying up.** It looks like a stray fragment. It is not.
- **A line break in a copy-paste.** If the key came to you in an email or a chat message and wrapped across two lines, the tail is the bit most likely to be left behind. Check the end of what you pasted before you confirm.

**2. A Mailchimp key is full account access. There is no narrower option.**

Every other vendor in this set lets you tick which things a credential may see. Mailchimp does not. There is exactly one kind of API key and it carries the same privileges as your own login: it can read your audiences, your campaigns and your reports, and it is not restricted to reading.

We would rather say this plainly than let you discover it. **Connecting Mailchimp means handing the box a credential with full access to your marketing system of record.** Droplet only reads, and the connection ships read-only — but that is a property of our software, not a boundary Mailchimp enforces. If that trade is not one you want to make, the honest answer is not to connect Mailchimp.

---

## Plan prerequisite

**Assume a paid Mailchimp plan is required. We have not verified whether the Free plan can create a working API key, and we are not going to assert either answer until we have.**

That is deliberately blunt. Here is the state of it:

- Mailchimp's API keys are created from the account profile, and nothing in Mailchimp's documented click-path names a plan tier as a gate.
- But Mailchimp has moved features between tiers repeatedly, and API access on the Free plan is exactly the kind of thing that changes without an announcement.
- **We have not tested it against a real Free-plan account.** Nobody at Warp Lab has confirmed that a Free-plan key authenticates and returns data.

**What to do if you are on the Free plan:** try it. The setup takes three minutes and costs nothing, and Droplet will tell you plainly whether the key works rather than sitting on a spinner. If it fails, that is a genuine finding — please tell us, because it decides whether the Mailchimp connector is offerable to Free-plan businesses at all, and it is a question we would rather answer from a real account than from a documentation page.

Beyond the plan question, the prerequisite is simply that you can sign in to the Mailchimp account that owns the audiences you want read.

---

## Cost

**None from Mailchimp for the API itself.** Mailchimp does not charge for creating an API key, and the calls Droplet makes are not billed to you.

**Droplet adds nothing to your Mailchimp bill.**

The only open money question is the plan question above: if it turns out the Free plan cannot use the API, then the cost of connecting Mailchimp is the cost of Mailchimp's cheapest paid tier — and we will say so here as soon as we know.

---

## Click-path

Do this in a browser, signed in to Mailchimp as the account owner.

1. Click your **profile name** (bottom-left of the Mailchimp navigation) to open your account.
2. Go to **Extras → API keys**.
3. Click **Create A Key**.
4. **Name it something you will recognise in two years.** `Droplet — <your office name>` beats `key 2`. This name is the only thing that will later tell you which key belongs to the box.
5. **Copy the key — whole.** Select from the very first character to the very last one after the hyphen. If you are pasting it via a chat message or a note, check it did not wrap across a line and lose its tail.
6. In Droplet: **Integrations → Mailchimp → Connect**, read the capability statement, paste the key, and confirm.

If Droplet refuses the key saying it has no datacenter suffix, you have lost the tail. Go back and copy it again from the end.

---

## Scopes and permissions

**There are none to choose.** Mailchimp issues one kind of API key, at one privilege level, covering the whole account. There is no scope screen, no permission checkboxes, and no read-only variant to select.

What Droplet does with that access:

| What it reads | Why |
|---|---|
| **Audiences and their members** | Who is on your lists, and their subscription status. |
| **Campaigns** | What you sent, and when. |
| **Reports** | Opens, clicks, unsubscribes — how a campaign actually performed. |

**Droplet does not write to Mailchimp.** It does not add members, send campaigns, or change your lists. That is enforced in Droplet, not by the key.

Because the key is account-wide, the boundary on this connection is entirely the box's read-only posture, plus the fact that the key never leaves the box. That is a real difference from Stripe or HubSpot, where the vendor itself limits what the credential can do, and it is worth weighing when you decide whether to connect Mailchimp at all.

---

## Rotation and expiry

**Mailchimp API keys do not expire.** The one you create today will still work in three years unless you disable or delete it. Nothing on Mailchimp's side will prompt you to reconsider it, and nothing on ours can — see [`credential-handling.md`](credential-handling.md).

**Rotating on purpose.** Create a new key in **Extras → API keys**, paste it into Droplet, and then **disable or delete the old one**. Do not assume a grace period on the old key: create the new one first, put it in place, then remove the old.

Rotation replaces the stored credential and leaves everything else alone — the connection keeps its identity, and everything already synced stays.

**Do rotate when someone leaves.** Because the key is full account access and never expires, an old Mailchimp key is the most valuable stray credential in this set. If the person who created it has left, or the key has ever been pasted into a chat message or a shared document, replace it.

**The suffix can change.** It is rare, but if Mailchimp ever moves your account between datacenters, a newly issued key carries a different suffix. That is another reason to always paste a fresh key whole rather than editing an old one.

---

## Revocation

**You control this entirely. We cannot revoke on your behalf**, and Droplet finds out only on its next call.

**To stop Droplet reading Mailchimp:**

- **On the box:** `Integrations → Mailchimp → Manage → Disconnect`. This purges the stored key from the box and stops all reading. Data already synced stays until you delete it.
- **At Mailchimp:** go to **Extras → API keys**, find the key by the name you gave it, and **disable or delete** it. Do this as well as disconnecting. Disconnecting stops Droplet using the key; only removing it at Mailchimp stops the key existing.

**Do both, in that order**, if you are decommissioning a box or handing it back. This matters more here than for the other vendors, precisely because the key is account-wide.

**If you suspect the box has been tampered with**, delete the key at Mailchimp first — that takes effect immediately and does not depend on the box being reachable or cooperative.

**What a revoked key looks like on the dashboard:** the connection moves to a named state saying the credential no longer works, and sync pauses. It does not show an empty audience list.

---

**Related:** [`credential-handling.md`](credential-handling.md) · [`SETUP.md`](SETUP.md#3-track-b--a-cloud-service-you-already-pay-for-cloudsaas-providers) · [`README.md`](README.md)
