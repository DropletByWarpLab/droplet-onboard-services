# Connecting Capsule CRM

> **Audience:** the person who owns the Capsule account whose pipeline and tasks you want the box to read.
> **Time:** about two minutes. Nothing to install, nothing to pay for, nothing to apply for.
> **What Droplet does with what you paste:** [`credential-handling.md`](credential-handling.md).
> **Sources checked 2026-10-04** — against Capsule's own developer documentation (its authentication, reading-from-the-api, handling-api-responses, opportunity, task and user pages), Capsule's support article on integrating with Capsule, and its pricing pages. **Not yet walked through with a live Capsule account by us**, so treat the menu names below as a close guide rather than a screenshot. A short list of questions is explicitly still open — see [the end of Scopes and permissions](#scopes-and-permissions) — and each is flagged as open rather than guessed at.

---

## Four things to know before you start

**1. Droplet reads your opportunities and your tasks. It does not read your people or your organisations.**

Capsule keeps people and organisations behind a single list that returns both and cannot be filtered by kind, and this connector's design cannot route one list into two places by what each row turns out to be. So the box reads **opportunities** — each one's name, its milestone (the stage it is at), its value and currency, and when it was created, closed and last changed — and **tasks** — each one's description, status, owner and dates. If the question you want the box to answer is "who is this contact" or "which organisations do we work with", **this connector does not answer it**.

**2. Ask for a read-only token when you make it.**

Capsule's tokens carry a scope: `read`, `read write`, or `read write user_preference`, and the default is `read write`. Droplet only ever *reads* — it cannot create, edit, complete or delete anything in Capsule, because the connector family Capsule runs on has no write path in it to switch off. But *us* being read-only does not make *the token* read-only. A read-only token answers "forbidden" to anything that writes, which is exactly what you want the box to hold.

**3. Your opportunities are copied onto the box; Won and Lost do not carry over as won and lost.**

Opportunities land in Customers as deals, in one pipeline named **Capsule CRM**, with one stage for each distinct milestone name. The box only marks a stage as won or lost for the two stage keys it knows from other CRMs, and a Capsule milestone called *Won* or *Lost* is not one of them — so those deals appear in a stage with that name but are treated as **open**. Their closing date is not kept either. The milestone's name still tells you where the deal is. Tasks are different: they are read when you ask and are not copied.

**4. Tasks use Capsule's own upper-case status words.**

Capsule's task statuses are `OPEN`, `COMPLETED` and `PENDING`, and the box passes them through unchanged. When you ask the box for tasks "in a status", the match is exact: asking for `open` finds nothing; asking for `OPEN` finds the open ones. Completed tasks are included — the box asks Capsule for all three statuses, because Capsule's default is open tasks only.

---

## Plan prerequisite

**None beyond a Capsule account.** Capsule's own pricing announcement says API access is **included in every tier**, and Capsule has a Free plan (2 users, 250 contacts, 1 pipeline, 5 custom fields). The developer documentation names no plan gate for a personal token. **We have not confirmed that a Free-plan account can generate one** — that is inferred from "every tier" — so if your account is on Free and the option is missing from your menu, tell us. There is no application to submit and nobody at Capsule reviews anything. Warp Lab is not in the loop either: you generate the token inside your own account and paste it into your own box, so there is no consent screen with our name on it and nothing of ours that can be revoked on your behalf. [`SETUP.md`](SETUP.md#31-why-you-create-the-credential-and-we-do-not) explains why that is the shape for every connector in this set.

Capsule also offers an OAuth-based MCP server on its Growth plan and above. Droplet does not use it; the token path described here is not Growth-gated.

---

## Cost

**None.** Capsule does not charge for personal access tokens or for the calls Droplet makes, and connecting Droplet adds nothing to your Capsule bill.

One thing is not a cost but behaves like a limit. **Each Capsule user is allowed 4,000 requests an hour when using a bearer token** — and the allowance belongs to *the user*, so it is shared with every other tool using that user's tokens. Droplet paces itself well inside it, one request about every 0.9 seconds, and if Capsule ever answers "slow down" it backs off. Tasks have no "changed since" filter, so the box re-reads every task on each sync tick: an account with 20,000 tasks costs roughly 800 requests an hour, about a fifth of the allowance. Opportunities are read incrementally and cost far less.

---

## Click-path

Do this in a browser, signed in to Capsule **as the person whose pipeline you want the box to read** — see [Rotation and expiry](#rotation-and-expiry) for why that matters.

1. Open Capsule and sign in.
2. Click **your name** in the top menu bar and choose **My Preferences**.
3. Open **API Authentication**.
4. Click **Generate new API token**.
5. Copy the token with the copy icon. If Capsule lets you choose the token's scope at this point, choose **read**.
6. In Droplet: **Connectors → Capsule CRM → Connect**, read the capability statement, paste the token, and confirm. The box checks it with a single call to Capsule's "who am I" endpoint, which returns the user the token belongs to and nothing else — so a failure here is unambiguous evidence about the token rather than about your pipeline.

---

## Scopes and permissions

**Ask for `read`.** Capsule's scopes are `read`, `read write` and `read write user_preference`, with `read write` as the default, and Capsule's own support article tells you to restrict a token to only what is required. A token made by a user who is not an administrator sees what that user sees, so a person with limited visibility gives the box limited visibility.

| What Droplet reads | Capsule endpoint | Why |
|---|---|---|
| **Opportunities** | `/api/v2/opportunities` | Each opportunity's identifier, name, milestone, value and currency, and when it was created, closed and last changed. Read incrementally. |
| **Tasks** | `/api/v2/tasks` | Each task's identifier, description, status, owner, project and dates — open, completed and pending. Re-read in full on each sync tick. |
| **The token's own user** | `/api/v2/users/current` | Not stored as business data. It is the single cheap call the box uses to check the token still works. |

The box opens outbound connections to exactly one address, **`api.capsulecrm.com`**, and to nothing else. That is a registered destination in the box's own egress list, not a matter of trust — an address that is not on that list is not reachable from the connector at all.

**Droplet does not write to Capsule.** It cannot create or change an opportunity, task, person or organisation. Those surfaces do not exist in the connector at any level.

### Questions still open, stated as open

- **Whether Capsule's token form offers a scope choice.** The support article says to restrict the token but does not show the picker, so step 5 is a description, not a screenshot.
- **Which field Capsule's changed-since filter looks at, and whether the bound is inclusive.** The documentation says it includes entities "changed after this date". If the bound is exclusive, an edit made in the same second as the box's last sync waits for the box's periodic full re-check to be found.
- **Whether Capsule's "next page" link keeps the task statuses.** The box follows the link exactly as Capsule sends it. If a link dropped the status list, later pages of tasks would quietly be open-only.
- **Whether a Free-plan account can generate a token** — see [Plan prerequisite](#plan-prerequisite).

---

## Rotation and expiry

**No expiry is documented** for a Capsule personal access token, so there is no date to diary. A token stays valid until it is revoked.

**To rotate:** generate a new token exactly as in the click-path, paste it into Droplet at **Connectors → Credentials**, confirm the connection reports healthy, and only then revoke the old one (see [Revocation](#revocation)).

**Treat the token as belonging to a person, and rotate when that person leaves.** The token is generated from an individual's own *My Preferences*, and it sees what that individual sees. If they leave and their account goes with them, expect this connection to stop. If they leave and their account *stays*, you have a standing credential to someone's pipeline held by someone who no longer works there. Make the box's token from an account that will outlive any one person, and rotate it when the people around it change.

---

## Revocation

**You control this entirely. We cannot revoke on your behalf**, and Droplet finds out only on its next call.

**To stop Droplet reading Capsule:**

- **On the box:** `Connectors → Capsule CRM → Manage → Disconnect`. This purges the stored token and stops all reading. Because the opportunities were copied into Customers, the box then asks what to do with them: **keep** them as ordinary deals your team can edit (they stop syncing), or **delete** them (any that carry a note your team wrote are archived instead, so the note is kept). Tasks were never copied, so there is nothing to delete for them.
- **At Capsule:** open **My Preferences → API Authentication** and revoke the token — Capsule's page is explicit that this is where you "revoke tokens that you don't need anymore". Do this as well as disconnecting. Disconnecting stops Droplet using the token; only revoking it at Capsule stops the token existing.

**Do both, in that order**, if you are decommissioning a box or handing it back.

**If you suspect the box has been tampered with**, revoke the token at Capsule **first**. That takes effect immediately and does not depend on the box being reachable or cooperative — which is the whole reason the vendor-side step is not optional.

**What a revoked token looks like on the dashboard:** the connection moves to a named state saying the credential no longer works, and reading pauses. It does not show an empty pipeline. "You have no opportunities" is a completely believable answer, and there would be no way for you to tell it apart from a broken connection — so Droplet never gives it. A problem is always reported as a problem, never as an empty list.

---

**Related:** [`credential-handling.md`](credential-handling.md) · [`SETUP.md`](SETUP.md#3-track-b--a-cloud-service-you-already-pay-for-cloudsaas-providers) · [`README.md`](README.md)
