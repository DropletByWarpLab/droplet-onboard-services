# Connecting Todoist

> **Audience:** the person who owns the Todoist account whose tasks you want the box to read.
> **Time:** about two minutes. Nothing to install, nothing to pay for, nothing to apply for.
> **What Droplet does with what you paste:** [`credential-handling.md`](credential-handling.md).
> **Sources checked 2026-09-18** — against Todoist's own unified API v1 reference (its Authorization, Pagination, Request limits and Migrating-from-v9 sections, and the OpenAPI document embedded in that page) and Todoist's help article *Find your API token*. **Not yet walked through with a live personal token by us**, so treat the tab names below as a close guide rather than a screenshot. One question on this page is explicitly still open — whether the "who am I" check accepts a personal token — and it is flagged as open rather than guessed at.

---

## Three things to know before you start

**1. Droplet reads your *active* tasks. It does not read completed ones.**

Todoist's list-tasks endpoint returns the tasks that are still open — its own description is *"Get all active tasks for the user"* — and that is the endpoint this connector reads. A task you complete does not arrive on the box marked as done; it simply stops appearing the next time the box reads your list. Completed tasks live on a different Todoist endpoint that has to be asked for a specific time window every time, and this connector's design does not do that yet. So if the question you want the box to answer is "what did I finish last week", **this connector does not answer it**. It answers "what is on my list", with each task's project, priority, who it is assigned to, and when it was added and last changed.

**2. The token is your whole account, and there is nothing to narrow.**

A Todoist personal API token has no scopes and no permission list. Todoist's API reference only ever calls it *your personal API token*, documents no way to narrow it, and where an endpoint names the scope an OAuth token would need, accepts the personal token in its place. So the token is your whole account, and that is the whole of it. **Droplet reads one endpoint and cannot write to Todoist at all** — it cannot add, complete, reopen, move or delete a task, because the connector family Todoist runs on has no write path in it to switch off. But *us* being read-only does not make *the token* read-only. Keep it where you keep passwords.

**3. Rotating the token signs you out everywhere.**

This is the one Todoist-specific surprise. The button that gives you a fresh token — **Issue a new API token** — is, in Todoist's own help article, also the way you *"log out of Todoist on all your devices"*. So the day you rotate the box's credential is also the day every phone, browser and desktop app you use Todoist on asks you to sign in again. It is not a fault; it is how Todoist built it. Plan the rotation for a moment that suits you, not the box.

---

## Plan prerequisite

**None. Any Todoist plan works, including the free one.** The API token is available on every plan; neither Todoist's help article nor its API reference mentions a plan gate for API access, and nothing in this connector touches the features Todoist does gate by plan (extra labels, file uploads). There is no application to submit and nobody at Todoist reviews anything. Warp Lab is not in the loop either: you copy the token inside your own account and paste it into your own box, so there is no consent screen with our name on it and nothing of ours that can be revoked on your behalf. [`SETUP.md`](SETUP.md#31-why-you-create-the-credential-and-we-do-not) explains why that is the shape for every connector in this set.

**The real prerequisite is not the plan — it is whose account you use.** The token is a person's. See the note at the end of [Rotation and expiry](#rotation-and-expiry).

---

## Cost

**None.** Todoist does not charge for API tokens or for the calls Droplet makes. Copying a token is free, and it is free on the free plan. Connecting Droplet adds nothing to your Todoist bill.

There is one thing to know that is not a cost but behaves like one. **Todoist does not publish a request ceiling for the endpoint Droplet reads** — the limits it does publish are for a different, bulk-sync endpoint that Droplet does not use. So the box does not pace itself against an invented number; it reads your list in pages of 200 and, if Todoist ever answers "slow down", it waits for exactly as long as Todoist says to. In practice you will not notice this. The reason it is written here is that the allowance, whatever it is, belongs to your account — so if you also run another tool against the same Todoist account, the two of you are sharing it.

---

## Click-path

Do this in a browser, signed in to Todoist **as the person whose tasks you want the box to read** — see [Rotation and expiry](#rotation-and-expiry) for why that matters.

1. Open the **Todoist web app** and sign in.
2. Click your **avatar** (top left) and choose **Settings**.
3. Open the **Integrations** tab.
4. Open the **Developer** tab inside it.
5. Click **Copy API token**. That is it — there is no form, no name to give it, no expiry to choose. The token that is copied is the one your account already has.
6. In Droplet: **Integrations → Todoist → Connect**, read the capability statement, paste the token, and confirm. The box checks it with a single call to Todoist's "who am I" endpoint, which returns the user the token belongs to and nothing else — so a failure here is unambiguous evidence about the token rather than about your tasks.

**If step 5 shows no token, or you want a fresh one**, the same Developer tab has **Issue a new API token**. Read [Rotation and expiry](#rotation-and-expiry) before you click it: it signs you out of every device.

---

## Scopes and permissions

**There are none to set** — a personal API token has no permission list. This section is therefore not a set of choices; it is a description of what the box actually does with a token that could do more.

| What Droplet reads | Todoist endpoint | Why |
|---|---|---|
| **Active tasks** | `/api/v1/tasks` | Each task's own identifier, its project, its title, its priority, who it is assigned to, and when it was added and last changed. |
| **The token's own user** | `/api/v1/user` | Not stored as business data. It is the single cheap call the box uses to check the token still works. |

The box opens outbound connections to exactly one address, **`api.todoist.com`**, and to nothing else. That is a registered destination in the box's own egress list, not a matter of trust — an address that is not on that list is not reachable from the connector at all.

**Droplet does not write to Todoist.** It cannot add a task, complete or reopen one, move it between projects, change its priority or due date, or delete it. Those surfaces do not exist in the connector at any level: the whole connector family Todoist runs on is read-only by construction, with no write path to disable.

### Three things to know about what lands on the box

- **Completed tasks are not read.** Said above and worth saying again here, because it is the one thing people expect and do not get. The endpoint the box reads returns active tasks only. A task you complete disappears from the next read; it does not arrive marked as done.
- **"Status" is Todoist's own checkbox, not a word.** Todoist has no status like "open" or "in progress"; what it has is whether the task is checked off. Because the box only ever sees active tasks, every task it holds shows that checkbox as *not checked*. If you ask the box for tasks "in a status", ask for that — it has no other status to offer.
- **Priority is Todoist's number, unchanged.** In Todoist, priority 1 is normal and priority 4 is the most urgent — the reverse of most other tools. Droplet passes the number through exactly as Todoist sends it, rather than guessing at a translation that would make your urgent tasks look like the least important ones.

### One open question, stated as open

**Todoist's reference describes the "who am I" endpoint in terms of OAuth tokens** and does not say in so many words that a personal API token is accepted there. On every other endpoint the personal token is the documented way in, and we expect it to work here too — but we have not confirmed it with a live token. **What to do about it:** connect, and watch the first check. If the box reports the token as refused even though you just copied it, tell us; the fix on our side is a one-line change to which endpoint the check uses, and it changes what this page says next.

---

## Rotation and expiry

**A Todoist token does not expire on its own.** It is the general rule on the shared page ([`credential-handling.md`](credential-handling.md)): a personal API token stays valid until you replace it. There is no date to diary and no inactivity timeout.

**Rotating on purpose has a side effect you must plan for.** Todoist gives every account exactly one token at a time. **Issue a new API token**, on the same Developer tab you copied the first one from, replaces it — and Todoist's help article is explicit that this is also how you *"log out of Todoist on all your devices"*. So:

1. Pick a moment when signing back in on your phone and desktop is not a nuisance.
2. Click **Issue a new API token**, then **Copy API token**.
3. Paste it into Droplet at **Integrations → Credentials** — the page that exists for exactly this, and which does not mean redoing the connect wizard — and confirm the connection reports healthy.
4. Sign back in on your other devices.

There is no "old token still works for a while" grace period, because there is only ever one token. The connection will report the old token as refused from the moment you issue the new one until you paste it. Rotation replaces the stored credential and leaves everything else alone: the connection keeps its identity.

**Treat the token as belonging to a person, and rotate when that person leaves.** The token is copied from an individual's own Settings, it carries that individual's whole account, and the box's check call returns that individual as its owner. If they leave and their Todoist account goes with them, expect this connection to stop. If they leave and their account *stays*, you have a standing credential to someone's whole task list held by someone who no longer works there. Either way, create the box's connection from an account that will outlive any one person, and rotate it when the people around it change.

---

## Revocation

**You control this entirely. We cannot revoke on your behalf**, and Droplet finds out only on its next call.

**To stop Droplet reading Todoist:**

- **On the box:** `Integrations → Todoist → Manage → Disconnect`. This purges the stored token from the box and stops all reading. Nothing from Todoist is copied onto the box in the first place — tasks are read when asked for and are not stored — so there is no synced data to delete afterwards.
- **At Todoist:** open **Settings → Integrations → Developer** and click **Issue a new API token**. Todoist has no "delete token" button; issuing a new one is how the old one dies. Do this as well as disconnecting. Disconnecting stops Droplet using the token; only re-issuing it at Todoist stops the old token existing. Expect to be signed out of your other devices — that is the same side effect as rotation, and it is the point here.

**Do both, in that order**, if you are decommissioning a box or handing it back.

**If you suspect the box has been tampered with**, re-issue the token at Todoist **first**. That takes effect immediately and does not depend on the box being reachable or cooperative — which is the whole reason the vendor-side step is not optional.

**What a revoked token looks like on the dashboard:** the connection moves to a named state saying the credential no longer works, and reading pauses. It does not show an empty task list. That distinction matters here as much as anywhere: "you have nothing to do" is a completely believable answer, and there would be no way for you to tell it apart from a broken connection — so Droplet never gives it. A problem is always reported as a problem, never as an empty list.

---

**Related:** [`credential-handling.md`](credential-handling.md) · [`SETUP.md`](SETUP.md#3-track-b--a-cloud-service-you-already-pay-for-cloudsaas-providers) · [`README.md`](README.md)
