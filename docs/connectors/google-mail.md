# Google / Gmail and Calendar — connecting your account

> **Audience:** the Droplet owner or administrator who sets up Google access, and each person who connects their Gmail or Google Calendar account.

Set up the Google app once. Each person chooses **Gmail**, **Google Calendar**, or both, then selects **Connect Google**, chooses their account on Google's website, and approves the permissions. Droplet never asks for their Google password. Calendar-only connections do not request mailbox access.

## 1. Who obtains this credential

Your organisation owns the Google Cloud project and OAuth app. An owner or administrator saves its client ID and client secret once in **Settings → Connected accounts → Account connection setup**. Ordinary users only see their connection card.

The secret is encrypted on Droplet and is never returned to the dashboard. Each person's refresh grant is encrypted separately and belongs to their Droplet account. App setup is local to this appliance, with no shared Warp Lab app or callback service.

## 2. Click-path

1. Open **Account connection setup** in Droplet and copy the Google redirect URI ending in `/api/google/callback`.
2. In the Google Cloud console, create or select your organisation's project. Enable the **Google Calendar API** for calendar access. Gmail reading and sending use Google's IMAP/SMTP service.
3. Configure the OAuth app's branding, audience and data access. Choose **Internal** if all users belong to your Google Workspace organisation; otherwise choose **External** and meet Google's publishing requirements before broad use.
4. Configure the scopes below for the features people will use. During testing, add the people who will connect as test users.
5. Create an OAuth client of type **Web application**. Add the exact URI from Droplet to **Authorized redirect URIs**. No JavaScript origin is needed for this server-side flow.
6. Save its **Client ID** and **Client secret** in Droplet's **Account connection setup**. When editing the same client, leaving the secret field untouched retains the saved secret. Replacing the client ID requires its matching secret.
7. Enable Droplet's **Calendar** module to show imported events and **Email** to read connected mailboxes. Sending approved replies also requires **Outgoing email**. Calendar-only connections work without the mail service.
8. Each person opens **Settings → Connected accounts**, chooses Gmail and/or Google Calendar, and selects **Connect Google**. Google shows the account chooser and permission screen, then returns to Droplet. To add Calendar to an existing Gmail link, select **Update Google permissions** and approve the additional access.

Google requires a real HTTPS hostname for this web application's callback. A `.local` name, raw IP address or plain HTTP appliance URL cannot be used. Use the appliance's provisioned device hostname, with a trusted certificate. The person's browser must reach that address over the LAN or VPN. This does not require opening a public inbound port.

## 3. Plan prerequisite

A Google account with Calendar, and Gmail enabled if mailbox access is selected. Google Workspace administrators may restrict third-party OAuth apps or IMAP access; they must allow this customer-owned app and the access it needs.

An **External** app requesting Gmail's restricted scope may require Google verification and a security assessment before public use, depending on Google's requirements and applicable exemptions. External apps in testing are limited to test users, and their refresh grants generally expire after seven days for these permissions. An Internal app is limited to the organisation that owns it. Complete the appropriate setup before inviting everyone to connect.

## 4. Scopes / permissions to tick

| Permission | What Droplet does with it |
| --- | --- |
| `https://www.googleapis.com/auth/userinfo.email` | Confirms the verified Google email address. Requested for every connection. |
| `https://mail.google.com/` | Requested only when Gmail is selected. Reads mail through Gmail's IMAP OAuth support and sends human-approved replies through SMTP when outgoing email is enabled. |
| `https://www.googleapis.com/auth/calendar.events.readonly` | Requested only when Google Calendar is selected. Reads events from the person's primary calendar into Droplet's calendar. |

Google requires the full mail scope for IMAP and SMTP. When Gmail is selected, its consent screen describes broad mailbox access, including deleting messages. Droplet reads mail and sends approved replies; it does not delete messages from Gmail. Calendar access is read-only: creating, editing or removing events in Google is outside this integration. Drive and Contacts are not connected by this card.

The connection card confirms authorization. The local inbox's mailbox status reports whether reading and indexing have started. Initial mailbox import uses the existing email indexer's recent-mail backfill.

Calendar status separately confirms the first successful import. Events from the primary calendar, including recurring instances and all-day dates, appear in Droplet's **Calendar** as read-only events. Sync runs approximately every five minutes while Calendar is enabled, within a window of one year before and after today. A failed or incomplete fetch preserves the last complete local copy.

## 5. What it costs the customer

Droplet adds no per-account connection fee. Your existing Gmail or Google Workspace subscription and any costs of satisfying Google's OAuth publishing requirements remain yours.

## 6. Rotation and expiry

Rotate the OAuth app's secret in Google Cloud and save the replacement under **Account connection setup**. Existing grants retain the credentials they were issued with, so reconnect affected accounts before disabling their old client credentials.

If Google revokes access, the card shows **Needs reconnect**. Select **Reconnect Google** and approve access again. If consent is cancelled, retry from the card. For setup problems, the owner should check the client, exact callback address, app audience, test-user list and organisation policies.

## Disconnecting

Select **Disconnect Google** on your card. Droplet removes the connected local mailbox, imported calendar events and encrypted grant, and attempts to revoke the Google grant. If Google cannot be reached, local removal still completes. Messages and events in Google stay there. You can also remove the app's access from your Google account's third-party connections. To stop calendar imports while keeping Gmail, remove that calendar subscription in Droplet's Calendar. To remove the local Gmail archive while keeping Calendar, remove its mailbox under **Mailboxes Droplet reads**.

## Provider documentation

The setup follows Google's [web server OAuth flow and redirect URI rules](https://developers.google.com/identity/protocols/oauth2/web-server#uri-validation), [Gmail XOAUTH2 requirements](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol), [Calendar events API](https://developers.google.com/workspace/calendar/api/v3/reference/events/list), and [restricted-scope verification requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).
