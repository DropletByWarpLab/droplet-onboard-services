# Connecting GitHub

> **Audience:** the person whose GitHub account (or whose organisation's repositories) you want the box to read issues from.
> **Time:** about five minutes. Nothing to install, nothing to pay for.
> **What Droplet does with what you paste:** [`credential-handling.md`](credential-handling.md).
> **Sources checked 2026-09-18** — against GitHub's own REST API reference for issues and for the authenticated user, its authentication and fine-grained-token pages, its pagination and rate-limit guides, its API-versioning and breaking-changes pages, and its help articles on managing personal access tokens. Two facts on this page are **not** written on any GitHub documentation page and were checked by running the actual calls against a public repository: that the "since" filter includes the exact second you give it, and that a malformed date is refused rather than ignored. **Not yet walked through the live GitHub settings screens by us**, so treat the button names below as a close guide rather than a screenshot.

---

## Three things to know before you start

**1. Pull requests come along with issues, and you cannot switch that off.**

GitHub's own API treats every pull request as an issue, and it hands both back from the same endpoint. Droplet reads that endpoint, so **every pull request your token can see becomes a work item on the box, alongside the issues.** There is a parameter on GitHub's side that *looks* like it might filter them out, but GitHub does not document what it does, and Droplet will not send a filter it cannot vouch for. If you do not want pull requests to appear, the only lever is the token itself: do not grant it *Pull requests* access (see [Scopes and permissions](#scopes-and-permissions)). Even then, GitHub may still return pull requests from *public* repositories, because every fine-grained token can read public repositories whether you asked for that or not.

**2. Make a *fine-grained* token, not a *classic* one — Droplet will refuse the classic kind.**

GitHub offers two kinds of personal access token, on two different screens. The **classic** kind (it starts with `ghp_`) cannot be made read-only for a repository: its repository permission is read *and* write over every repository you can reach, all at once. The **fine-grained** kind (it starts with `github_pat_`) lets you name the repositories and grant *Issues: Read-only* and nothing else. Droplet asks for the least it needs, so it accepts only the fine-grained shape — paste a `ghp_` token and the box will tell you it is the wrong kind before it stores anything. This is the same reasoning behind Droplet refusing a Stripe secret key in favour of a restricted one.

**3. The token sees what *you* chose, and the box cannot see that you chose too little.**

A fine-grained token is scoped to the repositories you picked when you made it. If you pick three repositories, the box reads three. If you forgot to grant *Issues: Read-only*, or your organisation has not yet approved the token, GitHub still answers the box's "is this token valid?" check with a cheerful yes — and then returns fewer issues than you expected, or only the ones from public repositories. **The connection will look healthy on the dashboard in both cases.** So after connecting, check the first sync shows the repositories you meant. Droplet reports what it actually got; it just cannot know what you meant to give it.

---

## Plan prerequisite

**None. GitHub Free works, and so does every other plan.** Fine-grained personal access tokens and the REST API are available on GitHub Free; there is no tier to upgrade to, no application to submit, and nobody at GitHub reviews anything. Warp Lab is not in the loop either: you create the token inside your own account and paste it into your own box, so there is no consent screen with our name on it and nothing of ours that can be revoked on your behalf. [`SETUP.md`](SETUP.md#31-why-you-create-the-credential-and-we-do-not) explains why that is the shape for every connector in this set.

**The real prerequisite is not the plan — it is which GitHub you are on, and who owns the repositories.**

| Your situation | Can you connect? |
|---|---|
| **GitHub.com**, repositories owned by your own user account | **Yes.** This guide is for you. |
| **GitHub.com**, repositories owned by an **organisation** | **Yes — with a possible extra step.** An organisation can block fine-grained tokens entirely, or require an organisation owner to **approve** each token before it can read private repositories. Until it is approved, the token can read only public repositories — and the box's connection check will still pass. Ask your organisation owner whether either policy is on. |
| **GitHub Enterprise Server** (your company runs its own GitHub on its own address), or **GitHub Enterprise Cloud with data residency** (your API address is not `api.github.com`) | **Not yet.** Droplet dials GitHub's public API address and no other. A self-hosted or region-specific GitHub is a second connector waiting to be built, not a setting you can change here. If that is you, say so; it changes the queue. |

---

## Cost

**None.** GitHub does not charge for personal access tokens or for the API calls Droplet makes. Creating a token is free, and it is free on the free plan. Connecting Droplet adds nothing to your GitHub bill.

There is one thing to know that is not a cost but behaves like one. **GitHub allows 5,000 API requests an hour per user for a personal access token**, and that allowance belongs to *you*, not to Droplet: every tool that authenticates as your account — a CI job, an editor plug-in, a script — draws from the same 5,000. Droplet paces itself deliberately, one request every 720 milliseconds at most, so it is never the tool that empties the bucket on its own. If the bucket *is* empty (because something else drained it), GitHub answers with a "slow down" that Droplet recognises as exactly that — it waits and retries; it does **not** tell you your token is bad. In practice you will not notice any of this.

---

## Click-path

Do this in a browser, signed in to GitHub **as the account that can see the repositories you want read** — see the note at the end of [Scopes and permissions](#scopes-and-permissions) about why that matters.

1. Sign in at GitHub.
2. Click your **profile photo**, top right, then **Settings**.
3. In the left sidebar, scroll to the bottom and click **Developer settings**.
4. In the left sidebar, click **Personal access tokens**, then **Fine-grained tokens**. (Not *Tokens (classic)* — see [thing 2](#three-things-to-know-before-you-start) above.)
5. Click **Generate new token**.
6. **Name it something you will still recognise in two years.** `Droplet — <your office name>` beats `token 3`. The name is the only thing that will later tell you which token belongs to the box, and you will want that on the day you rotate or revoke it.
7. **Set the expiration, and decide it on purpose.** GitHub offers 7, 30, 60 or 90 days, a custom date, or *No expiration*. A dated token gives you a connection that works perfectly on install day and then dies on a Tuesday months later — GitHub emails *you* a week before, never the box. Either choose no expiration (unless your organisation's policy forbids it), or **write the date in your calendar now**. See [Rotation and expiry](#rotation-and-expiry).
8. Under **Resource owner**, choose *your own account* or *the organisation* that owns the repositories. If you pick an organisation and it requires approval, the token will say so here.
9. Under **Repository access**, choose **Only select repositories** and pick the ones the box should read — or **All repositories** if that is genuinely what you want. Remember that public repositories are readable by the token regardless.
10. Under **Permissions → Repository permissions**, set **Issues** to **Read-only**. If you want pull requests to appear too, set **Pull requests** to **Read-only** as well. Leave everything else at *No access*. You do not need any *Account permissions*.
11. Click **Generate token**, then **copy it immediately.** GitHub shows it once. There is no reveal button and no support recovery — if you navigate away, the fix is to delete that token and make another.
12. In Droplet: **Integrations → GitHub → Connect**, read the capability statement, paste the token, and confirm. The box checks it with a single call to GitHub's "who am I" endpoint, which returns the account the token belongs to and nothing else — so a failure here is unambiguous evidence about the token rather than about your repositories.

---

## Scopes and permissions

Fine-grained tokens are the one credential in this set where **you genuinely choose the permissions**, repository by repository. This section says what to tick and what the box does with it.

| Permission | Set it to | Why |
|---|---|---|
| **Repository permissions → Issues** | **Read-only** | Everything the box reads comes through GitHub's issues endpoint. |
| **Repository permissions → Pull requests** | **Read-only**, *only if you want pull requests on the box* | GitHub returns pull requests from the same endpoint. Without this permission the token should not see pull requests in your private repositories — though, as with everything on a fine-grained token, public repositories are readable regardless. |
| Everything else | **No access** | Droplet asks for nothing else and would not use it. |

**Metadata: Read-only** is added automatically by GitHub to every fine-grained token and cannot be removed. That is GitHub's doing, and it is harmless — it is what lets the token know a repository exists.

| What Droplet reads | GitHub endpoint | Why |
|---|---|---|
| **Issues and pull requests** | `/issues` | Each item's own identifier, which repository it belongs to, its title, whether it is open or closed, who it is assigned to, and when it was created, closed and last updated. |
| **The token's own account** | `/user` | Not stored as business data. It is the single cheap call the box uses to check the token still works. |

The box opens outbound connections to exactly one address, **`api.github.com`**, and to nothing else. That is a registered destination in the box's own egress list, not a matter of trust — an address that is not on that list is not reachable from the connector at all. Every request also states the exact GitHub API version it was written against, so GitHub cannot silently change the shape of what the box reads when it releases a new one.

**Droplet does not write to GitHub.** It cannot open, close, edit, label, assign or comment on an issue, and it cannot touch a pull request. Those surfaces do not exist in the connector at any level: the whole connector family GitHub runs on is read-only by construction, with no write path to disable.

### Three things Droplet deliberately leaves blank or lossy

- **Priority.** A GitHub issue has no priority field. Labels are free text — `bug`, `P1`, `urgent`, `wontfix` — and Droplet will not guess a ranking from them, because a made-up priority in a field the assistant reads as fact is worse than an empty one. The field stays empty.
- **Second and later assignees.** An issue can have several assignees and the box records one: the first in GitHub's own ordering. If you rely on multi-assignee issues, know that the box is recording one name and not the full list.
- **Pull request identity.** A pull request appears on the box under its *issue* identifier, which is what GitHub's issues endpoint returns. It is consistent within Droplet, but it is not the number you would use to look the pull request up by its own API.

### One thing the box cannot check for you

**GitHub's "is this token valid?" endpoint needs no permissions at all, and the issues endpoint itself does not require any either.** That means a token with *no* Issues permission, or an organisation-owned token that is still waiting for approval, connects with a green tick and then reads only what public repositories offer. Droplet cannot tell that apart from "you have very few issues". **After connecting, look at the first sync and confirm the repositories you meant are there.** If they are not, the fix is on the token (add *Issues: Read-only*) or with your organisation owner (approve it), never on the box.

**One note on API versions, which costs you nothing but is worth knowing.** GitHub versions its REST API by date, and Droplet pins the version it was written against on every request. The version it uses is supported by GitHub until March 2028. GitHub's next version removes one field Droplet was careful *not* to depend on, so the box is already correct under both. If GitHub ever retires the pinned version, you will see a clear message saying the box needs updating, not months of subtly wrong lists.

---

## Rotation and expiry

**A GitHub fine-grained token expires if you told it to — and GitHub nudges you toward telling it to.** This is one of the exceptions to the general rule on the shared page ([`credential-handling.md`](credential-handling.md)) that these credentials do not expire: the creation form defaults to a 30-day lifetime, and whether this connection has an end date is a decision you made in step 7 of the click-path. If you set one, GitHub emails *you* a week before it lapses; the box cannot see the date, and there is nothing it can do about it in advance. An organisation or enterprise can also impose a maximum lifetime, in which case *No expiration* is simply not offered.

**GitHub also deletes a token that goes unused for a year.** That does not bite a connected box, which uses the token every day. It does bite a box that was disconnected, put away and reconnected thirteen months later expecting the same token to work — make a new one.

**There is a cap of 50 fine-grained tokens per account.** If you hit it, the fix is to delete tokens you no longer use, not to reuse one between tools.

**Rotating on purpose is clean.** Create the new token in **Settings → Developer settings → Personal access tokens → Fine-grained tokens**, with the same repositories and permissions, paste it into Droplet at **Integrations → Credentials** — the page that exists for exactly this, and which does not mean redoing the connect wizard — confirm the connection reports healthy, and only then delete the old token. Done in that order there is no outage. Rotation replaces the stored credential and leaves everything else alone: the connection keeps its identity, and everything already synced stays.

**You navigated away before copying the token.** Not recoverable, and not a support call. Create a **new** token, paste that one into Droplet, and then delete the orphan so you are not left with a live token nobody is using.

**Treat the token as belonging to a person, and rotate when that person leaves.** A personal access token is exactly that — it is minted inside one person's account settings, and the box's check call returns that person as its owner. If they leave and their GitHub account loses access to the repositories, this connection stops seeing them. If they leave and their account *keeps* access, you have a standing token held by someone who no longer works there. Either way, create the box's token on an account that will outlive any one person — or, for an organisation, on a dedicated account whose only job is this — and rotate it when the people around it change.

---

## Revocation

**You control this entirely. We cannot revoke on your behalf**, and Droplet finds out only on its next call.

**To stop Droplet reading GitHub:**

- **On the box:** `Integrations → GitHub → Manage → Disconnect`. This purges the stored token from the box and stops all reading. Data already synced stays until you delete it.
- **At GitHub:** go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens**, find the token by the name you gave it, and **delete** it. Do this as well as disconnecting. Disconnecting stops Droplet using the token; only deleting it at GitHub stops the token existing.

**Do both, in that order**, if you are decommissioning a box or handing it back.

**If you suspect the box has been tampered with**, delete the token at GitHub **first**. That takes effect immediately and does not depend on the box being reachable or cooperative — which is the whole reason the vendor-side step is not optional.

**What a revoked or expired token looks like on the dashboard:** the connection moves to a named state saying the credential no longer works, and sync pauses. It does not show an empty issue list. That distinction matters here more than it might seem: "you have no open issues" is a completely believable answer for a quiet repository, and there would be no way for you to tell it apart from a broken connection — so Droplet never gives it. A problem is always reported as a problem, never as an empty list.

**What a rate limit looks like, so you do not confuse the two:** if something else on your account has used up the hour's 5,000 requests, GitHub tells the box to wait. Droplet treats that as a temporary vendor condition — it waits and retries, and it does *not* mark your token as bad or ask you to paste a new one. If you *are* asked to paste a new token, it is because GitHub refused the one it had, not because the account was busy.

**Deleting your data.** Droplet can delete everything it has read from a GitHub connection, on request, scoped to that one connection — so a box serving two GitHub accounts cannot lose the wrong one's data. Ask, and it is done as a single action.

---

**Related:** [`credential-handling.md`](credential-handling.md) · [`SETUP.md`](SETUP.md#3-track-b--a-cloud-service-you-already-pay-for-cloudsaas-providers) · [`README.md`](README.md)
