# `<Vendor>` — getting your credential

> **Template, not a guide.** Copy this file to `docs/integrations/<vendor>.md` when a cloud connector ships, replace every angle-bracket placeholder, and add a link to it in [`SETUP.md`](SETUP.md) §8. Delete this blockquote.
>
> **Audience:** the business owner or office manager who has an account with `<Vendor>` and is being asked, by the Droplet dashboard, to paste something they do not have yet.
>
> Written for someone with **no IT department**. No jargon that is not defined on the page; no step that assumes a console the reader has never opened.

The five headings below are **required and fixed**. They exist because per-vendor guides written freehand end up answering different questions, and a customer comparing two connectors cannot tell whether an omission means "not applicable" or "the author forgot". Where a heading does not apply, say so under it — never delete it.

---

## 1. Who obtains this credential

<!-- REQUIRED. One of exactly three answers, stated plainly:
       • "You do" — the customer creates it inside their own <Vendor> account.
         This is the case for every connector planned today.
       • "Warp Lab does" — Warp Lab must register or publish an application
         with <Vendor> before any customer can connect. That is a fleet-wide
         commitment, not something the reader can act on; say what is
         outstanding and link the ticket.
       • "Neither" — <Vendor> needs no credential for what Droplet reads.
     Do not leave this to inference. A reader who cannot tell whose job this is
     will either wait for someone else or go hunting through a console for a
     screen that does not exist. -->

## 2. Click-path

<!-- REQUIRED. The literal sequence, as the reader will see it, from signing in
     to holding the value:

       1. Sign in to <Vendor> at <url>.
       2. <Menu> → <Submenu> → <Button>.
       3. …

     Name what is on the screen, not what it is called internally. If the value
     is shown ONCE and cannot be retrieved again, say so at the step where it
     appears — not afterwards. -->

## 3. Plan prerequisite

<!-- REQUIRED. Which <Vendor> plan or edition exposes this, and what a reader on
     a lower tier sees instead. "Any paid plan" and "no prerequisite" are
     complete answers; silence is not. A reader who follows the click-path and
     finds no such menu must be able to tell a missing feature from a wrong
     turn. -->

## 4. Scopes / permissions to tick

<!-- REQUIRED. Exactly which permissions to grant, and — just as important —
     which to leave OFF.

     Droplet reads. Grant the narrowest scope that serves the datasets this
     connector declares; a broader grant is not "more convenient", it is a
     larger blast radius on a credential that lives on the box. If <Vendor>
     offers a restricted or read-only key type, that is the one to create, and
     this section says so in as many words. -->

## 5. What it costs the customer

<!-- REQUIRED. Any charge <Vendor> levies for API access, a required plan
     upgrade, or metered call pricing. "Included at no extra cost" is a
     complete answer. Never leave a cost to be discovered on an invoice. -->

## 6. Rotation and expiry

<!-- REQUIRED. Does this credential expire? On what schedule should it be
     rotated, and what does the customer see when it lapses?

     Tie it to the dashboard: an expired or revoked credential surfaces as
     **"Credential rejected — replace it"**, NOT as "Not connected". Say that
     here, so a reader who meets that state knows it means "create a new one at
     <Vendor>" and not "paste the same key again". -->

---

## Pasting it into Droplet

`Integrations → Credentials` in the sidebar, owner/admin only. Paste the value into `<field label>` and Save.

Droplet encrypts it on the box, never displays it again, and records only *whether* a credential is set — never its value. Leave the field blank on a later edit to keep the stored credential; clear it explicitly to remove it. Full behaviour: [`SETUP.md` §8](SETUP.md#8-cloud--saas-connectors--pasting-a-credential-warp-2275).

## If it stops working

A credential the vendor refuses shows as **"Credential rejected — replace it"**. That state means Droplet still holds what you pasted and `<Vendor>` said no — so create a fresh credential using the click-path above and paste the new one. Re-pasting the old value will not clear it.
