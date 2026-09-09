# Connecting Atlassian (Jira and Confluence)

Connecting Atlassian lets Droplet **read** your Jira issues and Confluence pages so it can answer questions about your team's work without you going and looking. It cannot change anything — see [What Droplet can and cannot do with this](#what-droplet-can-and-cannot-do-with-this) below, which is a shorter list than you might expect and deliberately so.

> **What Droplet does with what you paste:** [`credential-handling.md`](credential-handling.md).
> **Sources checked 2026-09-02** — against Atlassian's own documentation for API tokens and the Rovo MCP server, and the credential facts recorded in ADR-042 §2 (pinned to WARP-2316). **Not yet walked through a live Atlassian admin console by us**, so treat the screen and button names below as a close guide rather than a screenshot. Atlassian moved the Rovo controls into the admin console during 2026; anything you read elsewhere describing a per-user toggle is out of date.

## Two things have to be true before this works, and only one of them is yours

This is the connector where a setup most often fails for a reason the person doing it cannot fix alone. Both conditions are checked below, in the order that saves you time.

1. **The site has to be on a paid plan.** Rovo — and therefore the MCP server Droplet talks to — is not available on the **Free plan**.
2. **Somebody with Atlassian org admin has to switch the MCP server on.** It is off by default and it is an organisation-level setting, not a per-user one. If you are not an org admin, you will need one for about a minute.

If either is missing, you can still create the token in step 1 below and it will look perfectly valid — it just will not be able to reach anything. That is the failure this section exists to prevent.

## Plan prerequisite

**A paid Atlassian cloud plan.** Standard, Premium or Enterprise. The **Free plan** does not include Rovo, and without Rovo there is no MCP server for Droplet to connect to.

**Cloud only.** This connector talks to Atlassian's hosted MCP server. Jira or Confluence **Data Center / Server** (self-hosted on your own machines) is not reachable this way — there is no self-hosted build of the MCP server to point Droplet at.

**The org admin step is a hard prerequisite, not a nicety.** In the Atlassian **Administration** console: **Rovo → Rovo MCP server → Authentication**, and enable it. Whoever holds org admin has to do this once for the whole organisation. Nobody at Warp Lab can do it, and Droplet cannot do it on your behalf.

## Cost

**Droplet charges nothing for this connector, and Atlassian charges nothing extra for the API token.** An API token is free to create and free to use.

What it *depends on* costs money: the paid plan above. If your site is on the Free plan, the cost of connecting Atlassian is the cost of upgrading it, and that is a decision to make before you start rather than after. Atlassian prices per user per month and the current figure is on their pricing page — we deliberately do not quote a number here that would be stale by the time you read it.

## Click-path

### 1. Create the API token

1. Sign in to Atlassian as **the account whose access you want Droplet to have**. This matters: the token inherits exactly that person's permissions, no more and no less. A token made by someone who can only see two Jira projects gives Droplet two Jira projects.
2. Go to **id.atlassian.com → Security → API tokens** (reachable from your profile menu as *Account settings → Security → Create and manage API tokens*).
3. Click **Create API token**, give it a name you will recognise in a year — `Droplet` is a good one — and set an expiry.
4. **Copy it now.** Atlassian shows the token exactly once. If you lose it, you delete it and make another; there is no way to view it again.

### 2. Find your site id (`cloudId`)

Droplet needs to know **which** Atlassian site to read, because one token can reach every site your account belongs to and we will not guess.

The simplest way: open `https://<your-site>.atlassian.net/_edge/tenant_info` in a browser while signed in. It returns a single value labelled `cloudId`. Copy it.

If you only have one Atlassian site, this is still required — Droplet asks for it explicitly rather than picking for you, so that adding a second site later cannot silently change what the box is reading.

### 3. Paste all three into Droplet

In Droplet: **Integrations → Atlassian → Connect**, and supply

- the **email address** of the account that created the token,
- the **API token** itself,
- the **site id** from step 2,
- and the **expiry date** you chose in step 1.

The expiry date is not decoration. It is the only way Droplet can warn you before the token stops working — see [Rotation and expiry](#rotation-and-expiry).

## Scopes and permissions

**There are no scopes to tick, and that is worth understanding rather than glossing over.** An Atlassian API token is not scoped. It carries the full permissions of the person who created it, across every Atlassian product that person can reach on every site they belong to.

So the way you limit what Droplet can see is **by choosing whose account creates the token**. If you want the box restricted to one team's projects, have someone whose access is already restricted to those projects create it. There is no setting inside Droplet, and none inside Atlassian, that can narrow it afterwards.

**What Droplet can and cannot do with this**

Even though the token could do more, the box will not. Droplet holds an explicit list of the Atlassian operations it is allowed to perform, that list is in the product rather than in a setting you could change by accident, and in this release **it contains reads only**:

- **Reads run automatically** — fetching an issue, searching Jira with JQL, reading a Confluence page or its comments, searching, and looking up who someone is.
- **Writes are blocked entirely in this release.** Droplet will not create a Jira issue, comment, transition a ticket, log work, or create a Confluence page — even though your token permits all of those.
- **Editing an existing Confluence page is blocked outright and separately**, because Atlassian's own tool for it replaces the whole page body rather than editing part of it. An automated "add a paragraph" would delete everything else on the page, and Confluence would record that as a perfectly normal successful edit. We would rather not offer it than offer it with a warning.

**A caveat about which tools exist at all.** Atlassian gates some of its own tools on *how* you signed in, not on what you can access. Jira Service Management and Bitbucket tools are reachable only with an API token, and Compass tools only with the browser sign-in flow that Droplet deliberately does not use. If you ask Droplet for something in Compass, it will tell you the connection cannot reach it — it will not tell you there is nothing there.

## Rotation and expiry

**An Atlassian API token lasts at most 365 days.** This is the single most important thing on this page, because unlike most of the other connectors there is a hard stop: on the expiry day, every request starts failing and the box looks broken.

Droplet handles this the only honest way available to it:

- It records the expiry date **you type in**, because Atlassian does not tell the box when a token expires.
- From **30 days out** it shows the connection as *expiring soon* rather than as connected, with the number of days left. It keeps working the whole time — the status is a warning, not a fault.
- If you did not supply an expiry date, the connection shows *expiry unknown* rather than a reassuring green tick. Droplet will not imply it can warn you when it cannot.

**There is no grace period and no automatic renewal.** To rotate: create a new token, paste it into Droplet with its new expiry, and then delete the old one. Doing it in that order means no gap.

**If the person who created the token leaves**, or loses access to a project, the token loses that access with them — silently, on the next call. Prefer a token created by an account that will outlive the individual.

## Revocation

**You revoke it, and you can do it without telling us.** At **id.atlassian.com → Security → API tokens**, find the token and delete it. It stops working immediately, everywhere.

Droplet finds out on its next call, not before — see [`credential-handling.md`](credential-handling.md). The connection will show as needing a new credential rather than as an error you have to interpret.

Two other ways the connection can end, both outside Droplet:

- **An org admin turns the Rovo MCP server off.** Every Droplet Atlassian call stops, for everyone, immediately.
- **The account is deactivated.** Its tokens go with it.

And from Droplet's side: **Disconnect** on the Atlassian integration purges the stored token from the box. It never changes anything in your Atlassian site.

## One thing your network team should know

If your organisation restricts Atlassian access by network, be aware that Atlassian's **domain allowlist does not cover this**. The MCP server is reached over Atlassian's own hosted endpoint, and the control that applies to it is the **IP allowlist**, which is a separate Atlassian feature on a separate screen. A domain allowlist that looks like it should permit this will not, and the failure looks like a network timeout rather than a permission error.

Droplet itself dials exactly one Atlassian address and nothing else. It never accepts an incoming connection from Atlassian, and there is no webhook or callback to open a hole for.

---

**Related:** [`credential-handling.md`](credential-handling.md) · [`SETUP.md`](SETUP.md#3-track-b--a-cloud-service-you-already-pay-for-cloudsaas-providers) · [`README.md`](README.md)
