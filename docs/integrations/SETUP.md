# Connecting an integration — setup guide

> **Audience:** the person setting up an integration on a Droplet — a business owner or office manager, with help from whoever administers the system being connected.
> **Applies to:** every integration, but **in two tracks**. Read §1 first and follow the one you are on; §4–§7 apply to both.
> **How it works under the hood:** [`README.md`](README.md).

Everything here is done from the Droplet **dashboard** — `Integrations` in the sidebar.

---

## 1. Which track are you on?

Droplet connects to two structurally different kinds of system, and they are set up in different places by different people. Picking the wrong track is the most common way to get stuck, because half the steps will not exist.

| | **Track A — on your own network** | **Track B — a cloud service you already pay for** |
|---|---|---|
| Where the data lives | A server in your building | The vendor's cloud |
| Examples | Eaglesoft, Dentrix, Open Dental, QuickBooks Desktop | Stripe, HubSpot, Mailchimp, Shopify, Xero |
| What you supply | A **server address**, and one run of a short setup script | A **credential you create on the vendor's own website** and paste into Droplet |
| Who has to be involved | Whoever administers that database | Whoever owns the vendor account (often you) |
| Does anything leave the building? | **No. Never.** | **Yes** — Droplet dials out to that one vendor, to a destination that is registered, screened and audited |
| Follow | **[§2](#2-track-a--a-system-on-your-own-network-landatabase-providers)** | **[§3](#3-track-b--a-cloud-service-you-already-pay-for-cloudsaas-providers)** |

> **Read-only is the default on both tracks.** Connecting an integration only lets Droplet **read**. Writing back is a separate, explicit opt-in ([§4](#4-turning-writes-on-and-off)) and is off until you turn it on.

---

## 2. Track A — a system on your own network (LAN/database providers)

Droplet drives this setup; you supply the server address and (once) have your database admin run a short grant script. Eaglesoft-specific values are called out and detailed in [`eaglesoft.md`](eaglesoft.md).

### 2.1 Before you start

| Requirement | Why |
|---|---|
| **Network reachability** | The Droplet box must reach the external system's database host on its port over the **LAN** (Eaglesoft: TCP `2638`). Both are usually on the same office network. A host firewall / VLAN may need to allow Droplet → server:port. |
| **Someone who can administer the external database** | Provisioning Droplet's dedicated account runs **once** with database-admin rights. You do not give Droplet that admin credential — it uses it once to create its own least-privilege account, then forgets it. |
| **Legal / compliance sign-off** | Reading patient/financial data is **PHI**. Before connecting a **real** system you need the compliance gate cleared ([§6](#6-compliance-gates-clear-these-before-a-real-connection)). Connecting a **test copy** is also PHI if the copy contains real data. |

### 2.2 Connect — the wizard

`Integrations → Connect` on the provider's card launches a short wizard. Four steps + a result.

#### Step 1 · Find the server

Enter the **server address** (host or IP) of the machine running the external system, and the **port** (prefilled — Eaglesoft `2638`). Droplet can **scan the network** for candidate hosts answering on that port. **Test connection** probes reachability; only a successful test advances. A failure tells you the cause in plain words ("nothing answered there — check the address, or that the server is on").

#### Step 2 · Give Droplet its own account

This is the heart of the Track A model: Droplet connects using **its own dedicated, view-only account inside the external database** — never a shared password, never an admin.

Droplet shows a generated **username** (`droplet_ro`) and a one-time strong **password**, plus a copyable **setup script** (the `GRANT` SQL). Two paths:

- **"I have admin access"** — enter the database admin credentials; Droplet runs the provisioning itself. The admin credential is **used once and never stored** (only a `secretRef` pointer to Droplet's own account is kept afterward).
- **"Send to my database admin"** — hand off the script; whoever manages the database runs it, and you **resume** the wizard afterward.

Droplet then **verifies** the account: it connects as `droplet_ro`, confirms it can **read** and **cannot write**, and records the external system's version.

#### Step 3 · Choose what Droplet can see

Tick the data scopes Droplet may read (all on by default; each labelled where it is PHI or financial). At the bottom is a single **off-by-default** toggle to allow writing back (see [§4](#4-turning-writes-on-and-off)). Leave it off for a read-only connection.

#### Step 4 · Confirm and connect

Review the summary (server, database, account, version, scopes, mode) and **Connect**. Droplet starts reading the data you chose. Nothing leaves your network.

**Result:** the connection goes green ("Connected"), and the provider's dashboard surface (e.g. `/integrations/eaglesoft`) populates — schedule, patients, financials — each time-stamped ("synced N min ago").

> While the live driver for a provider is still being finished, a successful setup lands the connection in **"connecting / not connected"** rather than green — Droplet never shows a fake "connected". See [`README.md`](README.md) §7.

### 2.3 The "dedicated user in their database" model

Droplet never uses a shared or default credential. It provisions, at most, **two least-privilege accounts** inside the external database:

| Account | Rights | When |
|---|---|---|
| **`droplet_ro`** | `SELECT` only, on the specific tables/views Droplet reads. | Always — this is the read connection. |
| **`droplet_rw`** | Narrow `INSERT`/`UPDATE` on only the columns its allow-listed write commands touch. **No** `DELETE`, DDL, or admin. | Only if you enable writes ([§4](#4-turning-writes-on-and-off)), and only for the enabled capability. |

The provisioning `GRANT` script (and a matching `revoke` teardown) ships with each provider. Passwords are generated by Droplet, unique per box, and stored via an encrypted **`secretRef` pointer** — never in logs, config, or the database rows. Provisioning is **idempotent / self-healing**: Droplet can re-run the grants on a connection failure (e.g. after a database rebuild dropped the account).

> **Never rely on the external system's built-in/default credential.** Several PMSs historically shipped well-known hardcoded credentials — using them is insecure, unauditable, over-privileged, and may break on upgrade. Droplet always provisions its own. (Eaglesoft specifics: [`eaglesoft.md`](eaglesoft.md).)

> **This section is Track A only.** A cloud service has no database in which to create a user, and nobody gives Droplet an account inside it — see [§3](#3-track-b--a-cloud-service-you-already-pay-for-cloudsaas-providers).

---

## 3. Track B — a cloud service you already pay for (cloud/SaaS providers)

There is no server to find and no database to create a user in. Instead you go to the vendor's own website, create a credential there, and paste it into Droplet.

### 3.1 Why you create the credential, and we do not

Warp Lab has no account with your payment processor, your CRM, or your accounting system, and does not want one. So for every cloud connector the shape is the same:

1. **You** sign in to the vendor's own site as the account owner.
2. **You** create a credential — an API key, a token, or an app's client id and client secret — ticking whatever permissions the vendor lets you tick.
3. **You** paste it into Droplet's connect screen.
4. The box uses it to read, from your premises, over an outbound connection to that one vendor.

Three consequences follow, and they are worth reading before you start rather than after.

- **Nothing of ours is in the trust path.** We mint nothing, ship nothing, and hold nothing on your behalf. The credential was created inside your account and you can destroy it without asking us.
- **We cannot rotate or revoke it for you.** If you delete the key in the vendor's dashboard, Droplet finds out on its next call — never before. Rotation and revocation stay yours. See [`credential-handling.md`](credential-handling.md).
- **The permissions are only as narrow as the vendor's own console allows.** Stripe lets you grant read on individual resources. Mailchimp does not let you narrow anything at all — its key is full account access, because that is the only kind Mailchimp issues. Each guide says plainly which of the two you are getting.

There is no vendor consent screen in this shape. Nothing shows you what you are granting except Droplet's own connect screen — which is why [`credential-handling.md`](credential-handling.md) exists, and why it is written as a capability statement rather than as a reassurance.

### 3.2 Before you start — what stops a cloud setup dead

Cloud setups fail for reasons that have nothing to do with Droplet, and several of them cannot be worked around from inside the dashboard. Check these **before** you open the vendor's site.

| Blocker | Who it hits | Where it is written up |
|---|---|---|
| **Your plan does not include the data.** Shopify's protected customer data — names, emails, phones, addresses — needs the **Grow** plan. A Basic-plan store cannot give the box that data at all, short of upgrading. | Shopify | [`shopify.md`](shopify.md) |
| **The connection itself costs money**, billed to you monthly and **per organisation**. | Xero | [`xero.md`](xero.md) |
| **The vendor does not offer it in your country.** Xero Custom Connections exist in AU, NZ, UK and US only. | Xero | [`xero.md`](xero.md) |
| **Only a specific person can create it** — and the connector breaks later if that person's role changes. | HubSpot | [`hubspot.md`](hubspot.md) |
| **Droplet will refuse the credential the vendor shows you first.** Stripe's most prominent key is a secret key; the box accepts only a restricted one, by design. | Stripe | [`stripe.md`](stripe.md) |
| **The credential has a tail that looks like noise and is not optional.** Trimming it points the box at the wrong host. | Mailchimp | [`mailchimp.md`](mailchimp.md) |

### 3.3 The per-vendor setup guides

Each guide is written for the person who owns the vendor account, and each covers the same six things: the click-path, the plan prerequisite, the scopes to tick, what it costs you, rotation and expiry, and how to revoke.

| Vendor | What you will end up pasting | Guide |
|---|---|---|
| **Stripe** | A restricted API key (`rk_live_…` / `rk_test_…`) | [`stripe.md`](stripe.md) |
| **HubSpot** | A private app access token (`pat-…`) | [`hubspot.md`](hubspot.md) |
| **Mailchimp** | An API key, pasted whole including its `-us14`-style tail | [`mailchimp.md`](mailchimp.md) |
| **Shopify** | A client id **and** client secret from your own Dev Dashboard app | [`shopify.md`](shopify.md) |
| **Xero** | A Custom Connection's client id and client secret | [`xero.md`](xero.md) |

> Microsoft 365 is also a cloud connector, but it uses the older sign-in-with-Microsoft flow rather than a pasted credential, so it has no guide in this set.

### 3.4 What Droplet does with your credential

One page, shared by every vendor, rather than five paraphrases that could drift apart: **[`credential-handling.md`](credential-handling.md)**. It states what is encrypted, what is never shown again, what happens when you disconnect, and what happens on a factory reset. Read it once; the vendor guides link back to it rather than restating it.

### 3.5 Connect — the wizard (cloud)

`Integrations → Connect` on the provider's card. There is no network scan and no grant script — the steps are:

1. **Read what will be read.** The connect screen states, before you paste anything, what the box will read and that the credential is copied onto the box. If that statement does not match what you expected, stop there.
2. **Paste the credential.** One field for most vendors, two for the ones that issue a client id and a client secret. Droplet checks the shape before it stores anything — a credential of the wrong kind is refused at this point, with the reason, and is not written anywhere.
3. **Choose what Droplet can see.** The same scope list as Track A, bounded by what you actually granted in the vendor's console. Asking here for something the credential does not permit surfaces as a named error, not as an empty screen.
4. **Confirm and connect.** Droplet makes its first call. A credential that authenticates but cannot read a resource you asked for is reported as exactly that, naming the permission you need to go and tick.

---

## 4. Turning writes on (and off)

Writing back into a live system of record is deliberate and reversible-by-design. **Applies to both tracks.**

- **Enable:** `Integrations → <provider> → Manage → Turn writes on`. This is a confirmed state change; on Track A it provisions the narrow `droplet_rw` account for the specific capability, and on either track it flips the mode pill to **"Writes enabled"**. The change is audited (who turned it on).
- **What actually happens on a write:** Droplet **never writes silently**. A proposed change (e.g. an appointment reschedule) is **staged** and shown to you in a **write-confirm** dialog; only when a human confirms does Droplet apply it, then re-read to verify. The assistant/voice can *propose* a write but can **never** authorize it — the confirmation always comes to a person on the dashboard.
- **Kill-switch:** `Manage → Turn writes off` instantly returns the integration to read-only. Writes are also frozen automatically if the external system's schema changes after an upgrade (drift-lock, [§5](#5-reading-the-connections-state)).
- **What Droplet will not write:** financial ledgers, transactions, insurance claims, and clinical records are **never** written — they're impossible targets by design. Writes are limited to a small, vetted, tested allow-list.

---

## 5. Reading the connection's state

The provider's dashboard hero always shows the honest current state. **Applies to both tracks.**

| State | Meaning | What to do |
|---|---|---|
| **Connected** | Reading normally; sync time-stamped. | Nothing. |
| **Not connected / connecting** | No live connection yet (or the driver for this provider isn't finished). | Finish the wizard, or wait for the provider's driver. |
| **Needs attention — updated** (drift-lock) | The external system was **updated**; Droplet paused writes and is re-checking the data before it trusts it. | **Re-check now**. Writes stay frozen until the schema is re-verified — this is a feature. |
| **Can't reach the server** (degraded) | The server, or the vendor, didn't answer. Droplet shows the **last-synced** data, clearly labelled stale. | Track A: check the server is on and on the network. Track B: check the vendor's own status page. **Retry**. |
| **Account can't read anymore** | Track A: a grant was revoked or the password rotated. Track B: the credential was deleted or regenerated, or the person who created it lost the permission it depends on. | Track A: **Re-run setup**. Track B: create a new credential in the vendor's console and paste it in — see that vendor's guide. |
| **Waiting for setup** | You chose the admin-handoff path and the script hasn't been run yet. | Have your database admin run the setup script; **Resume setup**. |

The **manage menu** (`Re-test connection` · `Sync now` · `Turn writes on/off` · `Disconnect`) is where you re-check, force a sync, toggle writes, or disconnect. **Disconnect** stops Droplet reading; it never alters the external system's data. On Track B it also purges the stored credential from the box — see [`credential-handling.md`](credential-handling.md).

> **A permission problem is never shown as "no data".** An under-scoped credential, an exhausted quota and a revoked key each render as their own named state. An empty result means the answer is genuinely empty.

---

## 6. Compliance gates (clear these before a real connection)

Access to a third-party system of record is powerful and regulated. **Applies to both tracks.** Before connecting a **production** system (or restoring a **real** copy of its database, which is itself PHI):

- [ ] **BAA** — a signed Business Associate Agreement is in place for the PHI Droplet will read. The on-box design is the strongest posture for this, but the agreement is still required.
- [ ] **EULA / vendor terms** — counsel has reviewed whether this access is permitted under the external system's license, support terms, or developer terms. Some vendors restrict third-party access or steer to an authorized-integration program; some cloud vendors additionally restrict what their data may be used for once you hold it.
- [ ] **Encryption in transit** — Track A: enable the database link's TLS where the server supports it; otherwise capture a written risk analysis for interim plaintext-on-LAN. Track B: always HTTPS, to a destination registered in the box's egress allow-list.
- [ ] **Encryption at rest** — Droplet's cache, audit, and outbox that hold PHI are encrypted on the box (built-in). Cloud credentials are encrypted separately — [`credential-handling.md`](credential-handling.md).
- [ ] **Audit + retention** — every access is audited (PHI-free scope), retained per policy.

For Eaglesoft, these gates and their specifics (EULA §5(a), authorized-vendor program, driver licensing) are detailed in [`eaglesoft.md`](eaglesoft.md) and tracked as **WARP-1100**.

---

## 7. Verifying a connection (for the installer)

**Applies to both tracks.** After setup, confirm:

1. The hub shows the provider **Connected**, with a recent sync time.
2. The provider surface populates with real, time-stamped data.
3. Track A only: `droplet_ro` **cannot** write — Droplet's own connect-time verification asserts this; you can double-check with your DBA that the account has `SELECT` only.
4. Track B only: the credential you pasted is the narrow one the guide asked for. Sign in to the vendor's console and confirm the key or app listed there is the one Droplet is using, and that its permissions are the ones you meant to grant.
5. If you enabled writes: stage a harmless write and confirm it goes through the **confirm** dialog and applies, then verify it in the external system's own UI.
6. Audit rows are being written (`Activity` / the audit log) with **no** patient names, customer names, or PHI in the scope.

*(While a provider's live driver is still being finished, steps 2–5 run against a copy database or the vendor's test mode, not production — see [`eaglesoft.md`](eaglesoft.md).)*
