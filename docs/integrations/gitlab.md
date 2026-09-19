# Connecting GitLab

> **Audience:** the person whose GitLab account can see the issues you want the box to read.
> **Time:** about five minutes. Nothing to install, nothing to pay for.
> **What Droplet does with what you paste:** [`credential-handling.md`](credential-handling.md).
> **Sources checked 2026-09-18** — against GitLab's own REST API reference (issues, users, authentication, pagination), its personal-access-token and token-scope documentation, its token overview (the table that gives the `glpat-` prefix), its fine-grained-token documentation together with the fine-grained *REST API permissions* reference (the table that names **Work Item: Read** for `GET /issues` and **User: Read** for `GET /user`), and its gitlab.com rate-limit page. **Not yet walked through the live gitlab.com console by us**, so treat the screen and button names below as a close guide rather than a screenshot. One thing on this page is explicitly still unconfirmed — whether the `read_api` scope alone is enough for the box's "who am I" check — and it is flagged as unconfirmed rather than assumed.

---

## Three things to know before you start

**1. This works with GitLab.com, not with a GitLab you run yourself.**

Droplet connects to the hosted service at **`gitlab.com`** — the one you use if your projects live under `gitlab.com/your-group/…`. If your company runs its own GitLab on its own hostname (self-managed, or GitLab Dedicated), **this connector will not work for you yet**, and the reason is not a setting you can change. See [Plan prerequisite](#plan-prerequisite) below. Better to know that now than after you have made a token.

**2. The token sees what *you* see — every project, every group, confidential issues included.**

The box reads issues through one endpoint that returns every issue the token's owner can see, across all the projects and groups they belong to: personal projects, the company's groups, and any open-source or former-employer groups they are still a member of. That includes issues marked **confidential** in projects where they have access. So *whose* account creates the token is the access decision. Create it as the person — or better, a dedicated account — whose visibility matches what the business actually wants on the box.

**3. The token expires, and GitLab makes you pick the date.**

A GitLab personal access token must have an expiry — the form will not let you leave it blank — and the default is **365 days**. On that day the connection stops and the dashboard tells you to paste a new one. It is not a fault; it is the date you chose. Write it in your calendar now.

---

## Plan prerequisite

**None. Any GitLab.com tier works, including Free.** Personal access tokens and the REST API are available on Free, Premium and Ultimate alike. There is no tier to upgrade to, no application to submit, and nobody at GitLab reviews anything. Warp Lab is not in the loop either: you create the token inside your own profile and paste it into your own box, so there is no consent screen with our name on it and nothing of ours that can be revoked on your behalf. [`SETUP.md`](SETUP.md#31-why-you-create-the-credential-and-we-do-not) explains why that is the shape for every connector in this set.

**The real prerequisite is not the tier — it is which GitLab you are on.**

| You use | Can you connect? |
|---|---|
| **GitLab.com** — you sign in at `gitlab.com` and your projects are served from it | **Yes.** This guide is for you. |
| **Self-managed or Dedicated** — your company runs GitLab on its own hostname | **Not yet.** |

Self-managed is not blocked out of preference. Every connector on this box opens connections only to addresses on a fixed, reviewed list, and a hostname that is different for every customer cannot be put on that list in advance. Supporting it means a second connector with its own per-customer address check — a piece of work waiting to be done, with its own guide, not a switch we have declined to flip. If you self-host and want this, say so; it changes the queue.

**One thing that is *not* a prerequisite:** the box never reads the fields GitLab reserves for paid tiers — issue weight, epic, health status. A Free-tier account gives the box a complete row.

---

## Cost

**None.** GitLab does not charge for personal access tokens or for the calls Droplet makes. Creating a token is free, and it is free on the Free tier. Connecting Droplet adds nothing to your GitLab bill.

There is one thing to know that is not a cost but behaves like one. **GitLab caps how fast one user may call its API.** The cap in force today is generous (2,000 requests a minute); GitLab has announced tier-based limits that will replace it, under which the Free tier gets **5,000 requests an hour**. Droplet paces itself against that announced Free figure deliberately — one request every 0.72 seconds — rather than sprinting and being cut off, and rather than needing to be updated the day the new limits land. In practice you will not notice: the box's first full read of a large tracker takes a few minutes, and everything after that is a small incremental pass. The reason it is written here is that the allowance is *your account's*, so if you also run another tool against the same GitLab account, the two of you are sharing it.

---

## Click-path

Do this in a browser, signed in to GitLab.com **as the account whose issues you want the box to read** — see the second note at the top of this page about why that matters.

1. Sign in at **`gitlab.com`**.
2. Click your **avatar**, in the top right, and choose **Edit profile**.
3. In the left sidebar, click **Access**, then **Personal access tokens**. (Direct link, and the one to use if the menu has moved: `https://gitlab.com/-/user_settings/personal_access_tokens`)
4. Click **Generate token**. It is a dropdown with two kinds of token; **either works** — the difference is only how you say what it may do:
   - **Legacy token** — asks you to tick *scopes*. Tick **`read_api`** and nothing else. This is the older, simpler kind.
   - **Fine-grained token** — asks you to grant *permissions* instead. Under the **User** boundary grant **Work Item: Read** and **User: Read**. Use this kind if your group's Owner has switched legacy tokens off (GitLab lets a top-level group enforce that after a date), or if you simply prefer the narrower model.
5. **Name it something you will still recognise in two years.** `Droplet — <your office name>` beats `token 2`. The name is the only thing that will later tell you which token belongs to the box, and you will want that on the day you rotate or revoke it.
6. **Set the expiry, and decide it on purpose.** GitLab requires one; the default is a year from today, and a year is also the furthest it will let you go. That is the day this connection stops unless you paste a new token first — GitLab's reminder email goes to *you*, never to the box. **Write the date in your calendar now**, because nothing else will remind you.
7. Click **Create personal access token**, then **copy the token immediately.** GitLab shows it once, on that page, and never again. There is no reveal button and no support recovery — if you navigate away, the fix is to revoke that token and make another.
8. In Droplet: **Integrations → GitLab → Connect**, read the capability statement, paste the token, and confirm. The box checks it with a single call to GitLab's "who am I" endpoint, which returns the user the token belongs to and nothing else — so a failure here is unambiguous evidence about the token rather than about your issues.

**What the token looks like.** It starts with **`glpat-`**. Newer tokens are longer and contain two dots partway along; that is normal. Droplet does not check the format — only that you actually pasted something — precisely because GitLab has changed the shape once already and a format check would have rejected every new token the day it did. If your token does not look like an example you saw somewhere, that is not a problem, and it is not the reason if something later fails.

---

## Scopes and permissions

**Tick `read_api` (Legacy) or grant Work Item: Read + User: Read (Fine-grained). Nothing more.** This is one of the connectors where the vendor's console *does* let you narrow the credential, so take the offer: a `read_api` token cannot create, edit, close or reassign anything, whatever the box asked it to. Droplet cannot write to GitLab in any case — the whole connector family GitLab runs on is read-only by construction, with no write path to disable — but a read-only *token* means that stays true even if the box is not the only thing that ever sees it.

| What Droplet reads | GitLab endpoint | Why |
|---|---|---|
| **Issues** | `/api/v4/issues` | Each issue's own identifier, which project it belongs to, its title, whether it is open or closed, who it is assigned to, and when it was created, closed and last changed. |
| **The token's own user** | `/api/v4/user` | Not stored as business data. It is the single cheap call the box uses to check the token still works. |

The box opens outbound connections to exactly one address, **`gitlab.com`**, and to nothing else. That is a registered destination in the box's own egress list, not a matter of trust — an address that is not on that list is not reachable from the connector at all. When GitLab hands the box a "next page" link, the box checks that link points back at `gitlab.com` before following it, every time.

**Droplet does not write to GitLab.** It cannot open an issue, close one, comment, change an assignee, edit a label, or touch a merge request, pipeline, repository or group. Those surfaces do not exist in the connector at any level.

### What the box reads from an issue, and the one thing it leaves blank

Issues on the box are stored as work items: an identifier, a project, a title, a state, an assignee, and the created / closed / last-changed times. GitLab fills every one of those except one:

- **Priority.** GitLab issues do not have a priority field. The closest things GitLab offers are all wrong for a different reason: *severity* exists only on incidents (a plain issue reads "unknown"); *weight* is a paid-tier field and means effort, not priority; and a `priority::high` **label** is a naming convention some projects adopt, not a field on the issue. Rather than guess, Droplet leaves priority empty. If your team runs on priority labels, know that the box sees the issue but not that label's meaning.
- **Assignee, when there is more than one.** Premium and Ultimate allow several assignees on one issue and the box records one — the first in GitLab's own ordering. If you rely on multi-assignee issues, know that the box is recording one name, not the list.
- **Which number is which.** Every GitLab issue has two numbers: the small one you see in the URL (`#6`), which repeats across projects, and a long instance-wide one you rarely see. The box keys on the long one, so two projects' `#6` never collide.

### What "every issue you can see" means in practice

The box reads through the endpoint that lists issues across **all** of the token owner's visibility, not one project at a time — so there is nothing to configure per project, and a new project the owner joins shows up on the next pass. The flip side is the one at the top of this page: if the owner belongs to groups the business would rather not have on the box, the box gets those too. A dedicated account that is a member of exactly the right groups is the clean answer.

### One thing still unconfirmed, stated as unconfirmed

GitLab documents `read_api` as read access to the API and documents `read_user` as the narrower scope for the user endpoints. We expect `read_api` alone to cover the box's "who am I" check — read access to the API should include reading your own profile — but **no GitLab page states that combination outright**, and we have not yet proved it on a live account. If the connect step fails immediately with a token you *know* is right and scoped `read_api`, add the **`read_user`** scope as well and try again. Tell us if that was the fix; it decides what this page says next.

---

## Rotation and expiry

**A GitLab token always expires, on the date you chose.** This is the exception to the general rule on the shared page ([`credential-handling.md`](credential-handling.md)) that these credentials do not expire — and it is a harder exception than Cal.com's, where expiry is optional: GitLab makes you pick a date, defaults it to **365 days**, and will not go further. Whether this connection has an end date is not a question; *when* is the decision you made in step 6 of the click-path. It is yours to diary — the box cannot see the date, and there is nothing it can do about it in advance. GitLab does send its own reminder emails ahead of expiry, to the token's owner.

**Rotating on purpose is clean here, because GitLab puts no practical limit on how many tokens you can have.** Create the new token in **Edit profile → Access → Personal access tokens** (same scope or permissions as before), paste it into Droplet at **Integrations → Credentials** — the page that exists for exactly this, and which does not mean redoing the connect wizard — confirm the connection reports healthy, and only then revoke the old token. Done in that order there is no outage. Rotation replaces the stored credential and leaves everything else alone: the connection keeps its identity, and everything already synced stays.

**GitLab can also rotate a token for you** — there is a rotate action beside each token that issues a replacement and revokes the original in one step. If you use it, paste the replacement into Droplet straight away: the old one is dead the moment the new one exists.

**You navigated away before copying the token.** Not recoverable, and not a support call. Create a **new** token, paste that one into Droplet, and then revoke the orphan so you are not left with a live token nobody is using.

**Treat the token as belonging to a person, and rotate when that person leaves.** GitLab tokens are created inside an individual's own profile, carry that individual's visibility exactly, and the box's check call returns that individual as the token's owner. So if they leave and their GitLab account is removed from your groups, expect this connection to go quiet — it will still *work*, but it will see only what that account can still see, which may be nothing. And if they leave and their account *stays*, you have a standing token held by someone who no longer works there. Either way, create the box's token on an account that will outlive any one person, and rotate it when the people around it change.

---

## Revocation

**You control this entirely. We cannot revoke on your behalf**, and Droplet finds out only on its next call.

**To stop Droplet reading GitLab:**

- **On the box:** `Integrations → GitLab → Manage → Disconnect`. This purges the stored token from the box and stops all reading. Data already synced stays until you delete it.
- **At GitLab:** go to **Edit profile → Access → Personal access tokens**, find the token by the name you gave it, and **revoke** it. Do this as well as disconnecting. Disconnecting stops Droplet using the token; only revoking it at GitLab stops the token existing.

**Do both, in that order**, if you are decommissioning a box or handing it back.

**If you suspect the box has been tampered with**, revoke the token at GitLab **first**. That takes effect immediately and does not depend on the box being reachable or cooperative — which is the whole reason the vendor-side step is not optional.

**What a revoked or expired token looks like on the dashboard:** the connection moves to a named state saying the credential no longer works, and sync pauses. It does not show an empty tracker. That distinction matters here: "no open issues" is a completely believable answer for a quiet project, and there would be no way for you to tell it apart from a broken connection — so Droplet never gives it. A problem is always reported as a problem, never as an empty list.

**Deleting your data.** Droplet can delete everything it has read from a GitLab connection, on request, scoped to that one connection — so a box serving two GitLab accounts cannot lose the wrong one's data. Ask, and it is done as a single action.

---

**Related:** [`credential-handling.md`](credential-handling.md) · [`SETUP.md`](SETUP.md#3-track-b--a-cloud-service-you-already-pay-for-cloudsaas-providers) · [`README.md`](README.md)
