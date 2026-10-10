# Connecting Atlassian (Jira and Confluence)

Connecting Atlassian lets Droplet **read** your Jira issues and Confluence pages so it can answer questions about your team's work without you going and looking. It cannot change anything — see [What Droplet can and cannot do with this](#what-droplet-can-and-cannot-do-with-this) below, which is a shorter list than you might expect and deliberately so.

There is **nothing to copy and paste.** You sign in with your Atlassian account, approve access on Atlassian's own screen, and Droplet reads which site you picked from that sign-in. There is no API token, no email address and no site id to type.

> **What Droplet does with what you approve:** [`credential-handling.md`](credential-handling.md).
> **Sources checked 2026-10-10** — against Atlassian's own documentation for the Rovo MCP server and its OAuth sign-in. **Not yet walked through a live Atlassian admin console by us**, so treat the screen and button names below as a close guide rather than a screenshot. Atlassian moved the Rovo controls into the admin console during 2026; anything you read elsewhere describing a per-user toggle is out of date.

## Two things have to be true before this works, and only one of them is yours

This is the connector where a setup most often fails for a reason the person doing it cannot fix alone. Both conditions are checked below, in the order that saves you time.

1. **The site has to be on a paid plan.** Rovo — and therefore the MCP server Droplet talks to — is not available on the **Free plan**.
2. **Somebody with Atlassian org admin has to switch the MCP server on.** It is off by default and it is an organisation-level setting, not a per-user one. If you are not an org admin, you will need one for about a minute.

If either is missing, the sign-in will be refused by Atlassian. That is the failure this section exists to prevent.

## Plan prerequisite

**A paid Atlassian cloud plan.** Standard, Premium or Enterprise. The **Free plan** does not include Rovo, and without Rovo there is no MCP server for Droplet to connect to.

**Cloud only.** This connector talks to Atlassian's hosted MCP server. Jira or Confluence **Data Center / Server** (self-hosted on your own machines) is not reachable this way — there is no self-hosted build of the MCP server to point Droplet at.

**The org admin step is a hard prerequisite, not a nicety.** In the Atlassian **Administration** console: **Rovo → Rovo MCP server → Authentication**, and enable it. Whoever holds org admin has to do this once for the whole organisation. Nobody at Warp Lab can do it, and Droplet cannot do it on your behalf.

## Cost

**Droplet charges nothing for this connector, and Atlassian charges nothing extra for signing in.**

What it *depends on* costs money: the paid plan above. If your site is on the Free plan, the cost of connecting Atlassian is the cost of upgrading it, and that is a decision to make before you start rather than after. Atlassian prices per user per month and the current figure is on their pricing page — we deliberately do not quote a number here that would be stale by the time you read it.

## Click-path

### 1. Let your Droplet's address sign in (org admin, once)

In **Atlassian Administration → Rovo → Rovo MCP server → Domain settings**, add your Droplet's callback address (for example `https://droplet-ai.lan/**`, or your box's own name) and `http://localhost:*/**`. Until that is done Atlassian refuses the sign-in with "Your organization admin must authorize access from this redirect URL".

### 2. Sign in

In Droplet: **Connectors → Atlassian → Connect**. Atlassian opens in your browser. Sign in as **the account whose access you want Droplet to have**, choose the site, and approve. Droplet then acts as that person and sees only what they can see.

An owner or admin can also create a **Workspace connection**, which makes everyone allowed to use the server act as one shared account; Droplet asks you to acknowledge that first.

If the browser ends on a page that does not load, copy the full address from its address bar and paste it into the box on the card.

### 3. Which site Droplet reads

Atlassian lets you choose **one site** on its consent screen. Droplet asks Atlassian which site you chose, remembers it, and sends **every** request to that site and no other — the name of the site is shown next to your sign-in in Droplet. If you belong to several sites and want a different one, sign in again and choose it on Atlassian's screen. If Atlassian grants no site at all, the sign-in ends with an error and nothing is stored: sign in again and tick a site on the consent screen.

## Scopes and permissions

**What Droplet asks Atlassian for** is the smallest set that reads Jira and Confluence: your profile and account, Jira work items, Confluence pages, comments and spaces, plus `offline_access` so the sign-in can renew itself without asking you again. You see the full list on Atlassian's consent screen.

**Droplet acts as the person who signed in.** It can see exactly what that account can see — no more and no less. To limit what the box can see, sign in with an account that is already limited to the projects you want.

**What Droplet can and cannot do with this**

Even though the account could do more, the box will not. Droplet holds an explicit list of the Atlassian operations it is allowed to perform, that list is in the product rather than in a setting you could change by accident, and in this release **it contains reads only**:

- **Reads run automatically** — fetching an issue, searching Jira with JQL, reading a Confluence page or its comments, searching, and looking up who someone is.
- **Writes are blocked entirely in this release.** Droplet will not create a Jira issue, comment, transition a ticket, log work, or create a Confluence page — even though your account permits all of those.
- **Editing an existing Confluence page is blocked outright and separately**, because Atlassian's own tool for it replaces the whole page body rather than editing part of it. An automated "add a paragraph" would delete everything else on the page, and Confluence would record that as a perfectly normal successful edit. We would rather not offer it than offer it with a warning.

**The model can never choose a different site.** The site is fixed when you sign in and is added to every call by Droplet itself, after the model has spoken; a request that names another site is overwritten.

**A caveat about which tools exist at all.** Atlassian gates some of its own tools on *how* you signed in. Jira Service Management and Bitbucket tools are not reachable with a browser sign-in. If you ask Droplet for something there, it will tell you the connection cannot reach it — it will not tell you there is nothing there.

## Rotation and expiry

**There is no token to rotate.** Atlassian gives Droplet short-lived access that Droplet renews on its own. If the renewal ever stops working (you changed your password, an admin removed your access, or Atlassian ended the grant), the connection shows *Sign in again* and Droplet stops using it until you do. It never keeps trying with a dead sign-in.

**If the person who signed in leaves**, or loses access to a project, the connection loses that access with them — on the next call. For a shared **Workspace connection**, use an account that will outlive any one individual.

**A connection made with an old API token no longer works.** Earlier versions of Droplet asked for an API token. After the update that connection is switched to *Sign in with Atlassian to reconnect*; nothing is lost except the old token, which Droplet deletes. You can delete it on Atlassian's side too (**id.atlassian.com → Security → API tokens**).

## Revocation

**You revoke it, and you can do it without telling us.** At **id.atlassian.com**, open your account's connected apps and remove Droplet. It stops working immediately, everywhere.

Droplet finds out on its next call, not before — see [`credential-handling.md`](credential-handling.md). The connection will show as needing a new sign-in rather than as an error you have to interpret.

Two other ways the connection can end, both outside Droplet:

- **An org admin turns the Rovo MCP server off.** Every Droplet Atlassian call stops, for everyone, immediately.
- **The account is deactivated.** Its sign-in goes with it.

And from Droplet's side: **Disconnect** on the Atlassian connection asks Atlassian to end the grant and deletes the stored sign-in from the box. It never changes anything in your Atlassian site.

## One thing your network team should know

If your organisation restricts Atlassian access by network, be aware that Atlassian's **domain allowlist does not cover this**. The MCP server is reached over Atlassian's own hosted endpoint, and the control that applies to it is the **IP allowlist**, which is a separate Atlassian feature on a separate screen. A domain allowlist that looks like it should permit this will not, and the failure looks like a network timeout rather than a permission error.

Droplet itself dials only Atlassian's MCP server and its sign-in service, and nothing else. It never accepts an incoming connection from Atlassian, and there is no webhook or callback to open a hole for.

---

**Related:** [`credential-handling.md`](credential-handling.md) · [`SETUP.md`](SETUP.md#3-track-b--a-cloud-service-you-already-pay-for-cloudsaas-providers) · [`README.md`](README.md)
