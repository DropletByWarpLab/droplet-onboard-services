# Microsoft 365 — connecting your organisation's account

> **Audience:** the owner or administrator whose organisation uses Microsoft 365, and whoever can sign in to its Microsoft admin centre. Set up the provider once in **Settings → Connected accounts → Account connection setup**. Each person can then select **Connect Outlook** without entering app IDs.

Each person **signs in with Microsoft** and approves access as themselves. Droplet keeps OneDrive and optional SharePoint file metadata. People can also opt in to read-only local copies of their received and sent Outlook emails and primary Outlook calendar. Imported emails can be read and searched in Droplet; Outlook sending is not available. Contacts are checked without being stored. What your organisation sets up once is the **app** people sign in through.

---

## 1. Who obtains this credential

**You do — once, for the whole practice.** Someone who can sign in to the Microsoft Entra admin centre (`entra.microsoft.com`) for your organisation (usually whoever set up Microsoft 365, with the *Application Administrator* or *Global Administrator* role) registers an app in **your own** Microsoft tenant. Warp Lab does not register one for you, and there is nothing to wait for from us.

Why your own app rather than one of ours: an app that lives in your tenant is yours to see, restrict and delete; it needs no review by Microsoft; and nothing about it is shared with any other Droplet customer.

After that, each person connects their own account from **Settings → Connected accounts → Outlook (Microsoft 365)**. Nobody can connect anyone else's. Existing per-person app registrations remain available under the card's advanced options.

## 2. Click-path

As an owner or administrator, open **Settings → Connected accounts → Account connection setup**. Copy the Microsoft **redirect URI** — a web address on your Droplet ending in `/api/m365/callback`. The browser used to connect must be able to reach this address over your LAN or VPN and trust its HTTPS certificate. No public inbound port or cloud callback broker is required.

1. Sign in to the Microsoft Entra admin centre at `entra.microsoft.com`.
2. Open **App registrations** (under *Entra ID*, or *Identity → Applications* on older layouts — the search box finds it) and select **New registration**.
3. **Name:** `Droplet`. **Supported account types:** *Accounts in this organizational directory only (Single tenant)*. Leave **Redirect URI** empty for now. Select **Register**.
4. On the new app: **Authentication → Add a platform → Mobile and desktop applications.** In **Custom redirect URIs**, paste the redirect URI Droplet showed you, exactly. Select **Configure**.
   - Not **Web**, and not **Single-page application**. Those two need a secret or a browser-only sign-in, and Droplet's sign-in will fail with a message naming the redirect.
5. Still under **Authentication**, set **Allow public client flows** to **Yes** and **Save**. (This is only used if your organisation still allows sign-in by code on another device; it is harmless otherwise.)
6. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**, and tick the permissions listed in §4. Include `Sites.Read.All` if anyone will use SharePoint (you can add it later; then repeat step 7). Select **Add permissions**.
7. **Grant admin consent for <your organisation>.** On Microsoft's default setting, **Let Microsoft manage your consent settings** (the default for new tenants), people cannot approve the Files, Mail, Calendars or Contacts permissions themselves, so an administrator must select **Grant admin consent** here, once, before anyone signs in. Without it Microsoft stops each person's sign-in at *Need admin approval*. Selecting it approves the app for everyone in your organisation.
8. **Overview.** Copy the **Application (client) ID** and the **Directory (tenant) ID** into **Account connection setup** in Droplet, then save the setup.
9. Each person opens **Connected accounts** and selects **Connect Outlook**.

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
| `Mail.ReadWrite` | When **Import Outlook emails into Droplet** is enabled, reads full received and sent message bodies into the local inbox for reading and search. This existing scope covers the `Mail.Read` requirement; Droplet does not change or delete Outlook mail. |
| `Mail.Send` | Nothing yet. Outlook sending from Droplet is not available. |
| `Calendars.ReadWrite` | When **Show Outlook calendar in Droplet** is enabled, reads the primary calendar's events into Droplet's Calendar. Droplet does not create, change or delete events in Microsoft. |
| `Contacts.ReadWrite` | Checks contact changes. Contacts are not yet saved locally. Droplet does not change them. |
| `Files.ReadWrite.All` | Reads the list of files in your OneDrive and, if you turn on SharePoint, in the SharePoint document libraries you can open (names and dates, not contents). |
| `Sites.Read.All` | Only if you turn on SharePoint: finds the SharePoint sites and document libraries you can open, so Droplet can list their files (names and dates, not contents). |

Droplet asks for every permission above except `Sites.Read.All` as one set, and Microsoft's consent screen shows all of them. `Sites.Read.All` is asked for only when a person turns SharePoint on (below), so someone who never does is never asked for it. The table says what each one is used for today, so what you approve and what Droplet actually does are both on record.

Do not add **Tasks** permissions: Droplet does not read Microsoft To Do, and does not ask for them when you sign in.

### Outlook email archive (optional)

After connecting, switch on **Import Outlook emails into Droplet** on your Outlook card. The choice is per person and off by default. Enable Droplet's Email module to import and view messages. If a previous grant lacks full `Mail.Read` or `Mail.ReadWrite` access, the card asks you to **Reconnect Outlook email** before import starts. `Mail.ReadBasic` is insufficient because it excludes message bodies, as documented in [Microsoft's permission reference](https://learn.microsoft.com/en-us/graph/permissions-reference#mailreadbasic).

Droplet imports the received and sent history available in your mailbox, including discovered nested and hidden folders, with no recent-date cutoff. Large mailboxes arrive in batches, so the first imported emails can appear while older history is still being read. Unsent Outlook drafts are excluded. The card shows the first import separately from account authorization, a message count and the last import time; **Open Outlook inbox** opens your local copy.

Import is read-only. You can read and search full plain-text messages locally, but cannot send or reply through this Outlook connection, download its attachment files, or use it as a sending mailbox for a service desk. The local copy records whether attachments exist and any available attachment metadata; attachment bytes stay in Outlook. Droplet keeps a message's first imported content as an archive. Moving or deleting an email in Outlook updates its tracked folder membership and retains the local archived copy. Folder updates use [Microsoft's delta API](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0).

Turning import off asks for confirmation, stops further reads and deletes that mailbox's local messages, attachment metadata and Droplet drafts. It preserves your Microsoft account connection, calendar and file connections. Emails in Outlook stay there. Disconnecting the whole Microsoft account removes the local mail archive along with the other imported data.

### Outlook calendar (optional)

After connecting, switch on **Show Outlook calendar in Droplet**. Calendar access is already included in the delegated consent above; if a prior grant lacks it, select **Reconnect Outlook**. Enable Droplet's Calendar module to view events. The card reports the calendar's first sync separately from account authorization.

Droplet imports primary-calendar events as read-only, including recurring instances and all-day dates. The initial window covers one year before and after today; Droplet periodically renews it so upcoming events remain covered. Updates run approximately every five minutes. Turning the switch off removes the local imported events and stops calendar syncing while keeping the Microsoft account connected. Events in Outlook stay there.

### SharePoint libraries (optional)

By default Droplet keeps a list of the files in each person's OneDrive. Each person can also switch on **Include SharePoint document libraries** on the Outlook card in **Settings → Connected accounts**. Droplet then keeps the same kind of list for every SharePoint document library that person can open: the names, folders, locations and dates of the files. It never reads what is inside the files, and it never reads anyone else's personal OneDrive.

Droplet reads at most 100 libraries per person; the Outlook card says how many more were left out. To stop, switch the same setting off: Droplet deletes the list of SharePoint files it kept and stops reading them. Nothing in Microsoft 365 changes.

SharePoint needs `Sites.Read.All`, which on Microsoft's default setting an administrator must approve (step 7). If it has not been approved when someone switches SharePoint on, the card says **Microsoft needs to approve SharePoint access**; once an administrator has approved it, that person selects **Sign in again**.

## 5. What it costs the customer

Nothing. Registering an app in Entra, and the Microsoft Graph calls Droplet makes for mail, calendar, contacts and files, are included in your Microsoft 365 subscription. Microsoft charges only for a small set of specialised APIs Droplet does not use.

## 6. Rotation and expiry

There is **no secret to rotate**: the app registration holds none, and Droplet never asks for one.

A person's connection lasts until something on Microsoft's side ends it, such as revoked consent or an organisation's sign-in policy. Droplet then shows **"Needs reconnect"** against that person's account; they select **Reconnect Outlook** on the same card.

If Droplet shows **"Error"** instead, check the registered redirect URI, platform and tenant settings. Once the setup is corrected, select **Reconnect Outlook**.

---

## Disconnecting

**Settings → Connected accounts → Outlook (Microsoft 365) → Disconnect.** Droplet deletes the key Microsoft gave it for that person, their local Outlook mail archive and Droplet drafts, imported calendar events and local cloud-file metadata straight away. Emails, events and files in Microsoft stay there. To revoke access on Microsoft's side as well, an administrator can remove the permissions under **Enterprise applications → Droplet → Permissions** in the Entra admin centre, or delete the app registration, which disconnects everyone at once.
