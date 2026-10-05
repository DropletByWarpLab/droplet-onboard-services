# Microsoft 365 — connecting your organisation's account

> **Audience:** the business owner or office manager whose practice uses Microsoft 365 (Outlook, OneDrive, Teams), and whoever can sign in to the Microsoft admin centre for it. Droplet's **Settings → Microsoft 365** card asks for two IDs from an "app registration"; this page is how you get them.

Microsoft 365 is different from the other connectors: there is no key to paste. Each person **signs in with Microsoft**, and Droplet reads their mail, calendar, contacts and files *as them* — never more than they can see themselves. What your organisation sets up once is the **app** they sign in through.

---

## 1. Who obtains this credential

**You do — once, for the whole practice.** Someone who can sign in to the Microsoft Entra admin centre (`entra.microsoft.com`) for your organisation (usually whoever set up Microsoft 365, with the *Application Administrator* or *Global Administrator* role) registers an app in **your own** Microsoft tenant. Warp Lab does not register one for you, and there is nothing to wait for from us.

Why your own app rather than one of ours: an app that lives in your tenant is yours to see, restrict and delete; it needs no review by Microsoft; and nothing about it is shared with any other Droplet customer.

After that, each person who wants Droplet to read their Microsoft 365 connects their own account from **Settings → Microsoft 365**. Nobody can connect anyone else's.

## 2. Click-path

Open **Settings → Microsoft 365** in Droplet first. It shows a **redirect URI** — a web address on your Droplet ending in `/api/m365/callback`. Keep that page open; you will copy that address in step 4.

1. Sign in to the Microsoft Entra admin centre at `entra.microsoft.com`.
2. Open **App registrations** (under *Entra ID*, or *Identity → Applications* on older layouts — the search box finds it) and select **New registration**.
3. **Name:** `Droplet`. **Supported account types:** *Accounts in this organizational directory only (Single tenant)*. Leave **Redirect URI** empty for now. Select **Register**.
4. On the new app: **Authentication → Add a platform → Mobile and desktop applications.** In **Custom redirect URIs**, paste the redirect URI Droplet showed you, exactly. Select **Configure**.
   - Not **Web**, and not **Single-page application**. Those two need a secret or a browser-only sign-in, and Droplet's sign-in will fail with a message naming the redirect.
5. Still under **Authentication**, set **Allow public client flows** to **Yes** and **Save**. (This is only used if your organisation still allows sign-in by code on another device; it is harmless otherwise.)
6. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**, and tick the permissions listed in §4. Include `Sites.Read.All` if anyone will use SharePoint (you can add it later; then repeat step 7). Select **Add permissions**.
7. **Grant admin consent for <your organisation>.** On Microsoft's default setting, **Let Microsoft manage your consent settings** (the default for new tenants), people cannot approve the Files, Mail, Calendars or Contacts permissions themselves, so an administrator must select **Grant admin consent** here, once, before anyone signs in. Without it Microsoft stops each person's sign-in at *Need admin approval*. Selecting it approves the app for everyone in your organisation.
8. **Overview.** Copy the **Application (client) ID** and the **Directory (tenant) ID** into the two fields in Droplet, then select **Sign in with Microsoft**.

Microsoft asks you to sign in and to consent; you land back on Droplet's Settings page, which says whether the connection worked.

## 3. Plan prerequisite

Any Microsoft 365 business plan (Business Basic, Standard or Premium, or an Enterprise plan). Registering an app uses **Microsoft Entra ID**, which every Microsoft 365 tenant includes at no extra charge — no Entra P1/P2 licence is needed.

Personal accounts (`@outlook.com`, `@hotmail.com`, `@live.com`) are **not supported**: they have no organisation to register an app in.

## 4. Scopes / permissions to tick

All **Delegated** — the app can only ever act as the person signed in, never as the whole organisation. Do **not** add any *Application* permission.

| Permission | What Droplet does with it today |
| --- | --- |
| `offline_access` | Keeps the connection working without signing in again every hour |
| `User.Read` | Shows which account is connected |
| `Mail.ReadWrite` | Reads the mailbox. Droplet does not change or delete mail. |
| `Mail.Send` | Nothing yet. Requested for sending replies you approve in Droplet. |
| `Calendars.ReadWrite` | Reads the calendar. Droplet does not create or change events. |
| `Contacts.ReadWrite` | Reads contacts. Droplet does not change them. |
| `Files.ReadWrite.All` | Reads the list of files in your OneDrive and, if you turn on SharePoint, in the SharePoint document libraries you can open (names and dates, not contents). |
| `Sites.Read.All` | Only if you turn on SharePoint: finds the SharePoint sites and document libraries you can open, so Droplet can list their files (names and dates, not contents). |

Droplet asks for every permission above except `Sites.Read.All` as one set, and Microsoft's consent screen shows all of them. `Sites.Read.All` is asked for only when a person turns SharePoint on (below), so someone who never does is never asked for it. The table says what each one is used for today, so what you approve and what Droplet actually does are both on record.

Do not add **Tasks** permissions: Droplet does not read Microsoft To Do, and does not ask for them when you sign in.

### SharePoint libraries (optional)

By default Droplet keeps a list of the files in each person's OneDrive. Each person can also switch on **Include SharePoint document libraries** on **Settings → Microsoft 365**. Droplet then keeps the same kind of list for every SharePoint document library that person can open: the names, folders, locations and dates of the files. It never reads what is inside the files, and it never reads anyone else's personal OneDrive.

Droplet reads at most 100 libraries per person; **Settings → Microsoft 365** says how many more were left out. To stop, switch the same setting off: Droplet deletes the list of SharePoint files it kept and stops reading them. Nothing in Microsoft 365 changes.

SharePoint needs `Sites.Read.All`, which on Microsoft's default setting an administrator must approve (step 7). If it has not been approved when someone switches SharePoint on, the card says **Microsoft needs to approve SharePoint access**; once an administrator has approved it, that person selects **Sign in again**.

## 5. What it costs the customer

Nothing. Registering an app in Entra, and the Microsoft Graph calls Droplet makes for mail, calendar, contacts and files, are included in your Microsoft 365 subscription. Microsoft charges only for a small set of specialised APIs Droplet does not use.

## 6. Rotation and expiry

There is **no secret to rotate**: the app registration holds none, and Droplet never asks for one.

A person's connection lasts until something on Microsoft's side ends it — a password reset by an administrator, a revoked consent, or Droplet being switched off for more than about 90 days. Droplet then shows **"Needs reconnect"** against that person's account; they select **Sign in again** on the same card.

If Droplet shows **"Error"** instead, signing in again will not help on its own: the message names what Microsoft refused (usually the redirect URI or the platform chosen in step 4), and the fix is in the app registration. Once it is changed there, select **Sign in again**.

---

## Disconnecting

**Settings → Microsoft 365 → Disconnect.** Droplet deletes the key Microsoft gave it for that person straight away. To revoke it on Microsoft's side as well, an administrator can remove the permissions under **Enterprise applications → Droplet → Permissions** in the Entra admin centre, or delete the app registration, which disconnects everyone at once.
