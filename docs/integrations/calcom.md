# Connecting Cal.com

> **Audience:** the person who owns the Cal.com account whose bookings you want the box to read.
> **Time:** about five minutes. Nothing to install, nothing to pay for.
> **What Droplet does with what you paste:** [`credential-handling.md`](credential-handling.md).
> **Sources checked 2026-09-07** — against Cal.com's own API v2 reference, its rate-limit documentation and its help article on API keys. **Not yet walked through the live Cal.com console by us**, so treat the screen and button names below as a close guide rather than a screenshot. One question on this page is explicitly still open — exactly *whose* bookings a key can see on a team account — and it is flagged as open rather than guessed at.

---

## Three things to know before you start

**1. This works with the Cal.com *service*, not with a Cal.com you host yourself.**

There are two products with the same name and they do not answer the same API. Droplet connects to the hosted service at **`api.cal.com`** — the one you use if you signed up at cal.com and your booking links live under it. If you run your own installation (**cal.diy**, the self-hosted edition), **this connector will not work for you yet**, and the reason is not a setting you can change. See [Plan prerequisite](#plan-prerequisite) below. It is better to know that now than after you have made a key.

**2. A Cal.com API key has no scopes. There is nothing to tick.**

Unlike Klaviyo, Cal.com does not ask you to choose what a key may do. The creation form asks for a name and an expiry date, and that is the whole of it. So the key you create is as capable as your Cal.com account is. **Droplet reads bookings and nothing else, and it cannot write to Cal.com at all** — it cannot create, move, confirm or cancel a booking, because the connector Cal.com runs on has no write path in it to switch off. But *us* being read-only does not make *the key* read-only. Name it for the box, and delete it when the box goes.

**3. Do not worry about what the key looks like.**

Droplet does not check the key's format — only that you actually pasted something. That is deliberate: Cal.com issues keys with more than one prefix depending on how the key was made, and a self-hosted installation can be configured to use any prefix its operator likes. A format check would reject perfectly valid keys and tell the owner their key was wrong when it was not. So if your key does not look like an example you saw somewhere, that is not a problem, and it is not the reason if something later fails.

---

## Plan prerequisite

**None. Any Cal.com plan works, including the free one.** There is no tier to upgrade to, no application to submit, and nobody at Cal.com reviews anything. Warp Lab is not in the loop either: you create the key inside your own account and paste it into your own box, so there is no consent screen with our name on it and nothing of ours that can be revoked on your behalf. [`SETUP.md`](SETUP.md#31-why-you-create-the-credential-and-we-do-not) explains why that is the shape for every connector in this set.

**The real prerequisite is not the plan — it is which Cal.com you are on.**

| You use | Can you connect? |
|---|---|
| **The hosted service** — you sign in at `app.cal.com` and your booking pages are served by Cal.com | **Yes.** This guide is for you. |
| **A self-hosted installation (cal.diy)** — your team runs Cal.com on your own server or your own domain | **Not yet.** |

Self-hosting is not blocked out of preference. The two products run genuinely different API contracts: the hosted service and a self-hosted install page through results differently, answer to different API version dates, and the self-hosted edition ships without some features entirely. Droplet would have to speak a second dialect, and shipping one we have never run against a real self-hosted instance would be a guess presented as an integration. It is a second connector waiting to be built, with its own guide — not a switch we have declined to flip. If you self-host and want this, say so; it changes the queue.

---

## Cost

**None.** Cal.com does not charge for API keys or for the calls Droplet makes. Creating a key is free, and it is free on the free plan. Connecting Droplet adds nothing to your Cal.com bill.

There is one thing to know that is not a cost but behaves like one. **Cal.com allows 120 requests a minute for API-key authentication.** Droplet paces itself against that figure deliberately — one request every half-second — rather than sprinting and being cut off. Cal.com says the limit can be raised on request; the box assumes the floor, because the floor is what you get without asking for anything. In practice you will not notice this. The reason it is written here is that the allowance is your account's, so if you also run another tool against the same Cal.com account, the two of you are sharing it.

---

## Click-path

Do this in a browser, signed in to Cal.com **as the person whose bookings you want the box to read** — see the note at the end of [Scopes and permissions](#scopes-and-permissions) about why that matters.

1. Sign in at **`app.cal.com`**.
2. Click the **dropdown menu beside your name**, in the top right, and choose **My Settings**.
3. Scroll down to the **Developer** section and click **API keys**. (Direct link, and the one to use if the menu has moved: `https://app.cal.com/settings/developer/api-keys`)
4. Click **+ Add**, in the upper right of that page.
5. **Name it something you will still recognise in two years.** `Droplet — <your office name>` beats `key 2`. The name is the only thing that will later tell you which key belongs to the box, and you will want that on the day you rotate or revoke it.
6. **Set the expiry, and decide it on purpose.** Cal.com makes you choose a date, and it also offers a key that never expires. A dated key gives you a connection that works perfectly on install day and then dies silently on a Tuesday months later — and Cal.com's warning, if any, goes to you, never to the box. Either choose never-expiring, or **write the date in your calendar now**, because nothing else will remind you.
7. Click **Save**, then **copy the key immediately.** Cal.com's own wording: *"immediately copy the key as you won't be able to see this code again later."* There is no reveal button and no support recovery — if you navigate away, the fix is to delete that key and make another.
8. In Droplet: **Integrations → Cal.com → Connect**, read the capability statement, paste the key, and confirm. The box checks it with a single call to Cal.com's "who am I" endpoint, which returns the user the key belongs to and nothing else — so a failure here is unambiguous evidence about the key rather than about your bookings.

---

## Scopes and permissions

**There are none to set** — Cal.com's key-creation form offers a name and an expiry, and no permission list. This section is therefore not a set of choices; it is a description of what the box actually does with a key that could do more.

| What Droplet reads | Cal.com endpoint | Why |
|---|---|---|
| **Bookings** | `/v2/bookings` | Each booking's own identifier, its start time, who is hosting it, and its status — confirmed, cancelled, pending. |
| **The key's own user** | `/v2/me` | Not stored as business data. It is the single cheap call the box uses to check the key still works. |

The box opens outbound connections to exactly one address, **`api.cal.com`**, and to nothing else. That is a registered destination in the box's own egress list, not a matter of trust — an address that is not on that list is not reachable from the connector at all.

**Droplet does not write to Cal.com.** It cannot create a booking, reschedule or cancel one, confirm a pending request, edit an event type, or change your availability. Those surfaces do not exist in the connector at any level: the whole connector family Cal.com runs on is read-only by construction, with no write path to disable.

### Three things Droplet deliberately leaves blank

Bookings on the box are stored in a record shape that came from clinical practice management, where an appointment has a patient and a treatment room. Cal.com is a general booking product and does not have either of those things. Rather than fill the gaps with something that looks close, Droplet leaves them empty — and this is the section to read if you were expecting them.

- **Who the booking is with.** Cal.com's record of an attendee has no identifier on it at all — just a name, an email address, a time zone and a language. The only candidate would be the email, and putting an email address into an identifier field would quietly turn your customers' email addresses into the key that joins their records together across the box. Droplet will not do that, so the field stays empty.
- **Where the booking is.** Cal.com's location is free text, and it is variously a meeting link, a phone number, a street address, or the literal words "Cal Video". Four different kinds of value for one field is not a room number, so the field stays empty.
- **Which host, when there is more than one.** A round-robin or collective event type has several hosts and the box records one. Droplet takes the first host in Cal.com's own ordering, which is the organiser — the closest honest answer to "who is running this". If you rely on round-robin, know that the box is recording the organiser and not the full list.

### One open question, stated as open

**Cal.com's reference does not say whose bookings a key can see by default**, and we have not confirmed it against a live team or organisation account. On a single-person account the answer is obvious. On a team it is not, and we would rather tell you that than assert something and have you plan around it.

**What to do about it:** create the key as the person (or the team owner) whose bookings you want read, and check the first sync shows what you expected. Droplet reports what it actually got rather than a spinner, so this is a two-minute check rather than a leap of faith. If the answer surprises you, we would like to hear about it — it decides what this page says next.

**One note on API versions, which costs you nothing but is worth knowing.** Cal.com versions its bookings endpoint by date, and stating the version is *required* — leave it out and Cal.com quietly serves an older version of the endpoint with a differently shaped answer. Droplet always states the version it was written against, so the passage of time cannot silently change the shape of what the box reads. If Cal.com ever retires that version, you will see a clear message saying the box needs updating, not months of subtly wrong numbers.

---

## Rotation and expiry

**A Cal.com key expires if you told it to.** This is the exception to the general rule on the shared page ([`credential-handling.md`](credential-handling.md)) that these credentials do not expire: Cal.com asks you for an expiry date at creation, so whether this connection has an end date is a decision you already made in step 6 of the click-path. If you set one, it is yours to diary — the box cannot see the date, and there is nothing it can do about it in advance.

**Rotating on purpose is clean here, because Cal.com puts no limit on how many keys you can have.** Create the new key in **My Settings → Developer → API keys**, paste it into Droplet at **Integrations → Credentials** — the page that exists for exactly this, and which does not mean redoing the connect wizard — confirm the connection reports healthy, and only then delete the old key. Done in that order there is no outage. Rotation replaces the stored credential and leaves everything else alone: the connection keeps its identity, and everything already synced stays.

**You navigated away before copying the key.** Not recoverable, and not a support call. Create a **new** key, paste that one into Droplet, and then delete the orphan so you are not left with a live key nobody is using.

**Treat the key as belonging to a person, and rotate when that person leaves.** Cal.com keys are created inside an individual's own **My Settings**, and the box's check call returns that individual as the key's owner. So if they leave and their Cal.com account goes with them, expect this connection to stop — and if they leave and their account *stays*, you have a standing key held by someone who no longer works there. Either way, create the box's key on an account that will outlive any one person, and rotate it when the people around it change.

---

## Revocation

**You control this entirely. We cannot revoke on your behalf**, and Droplet finds out only on its next call.

**To stop Droplet reading Cal.com:**

- **On the box:** `Integrations → Cal.com → Manage → Disconnect`. This purges the stored key from the box and stops all reading. Data already synced stays until you delete it.
- **At Cal.com:** go to **My Settings → Developer → API keys**, find the key by the name you gave it, and **delete** it. Do this as well as disconnecting. Disconnecting stops Droplet using the key; only deleting it at Cal.com stops the key existing.

**Do both, in that order**, if you are decommissioning a box or handing it back.

**If you suspect the box has been tampered with**, delete the key at Cal.com **first**. That takes effect immediately and does not depend on the box being reachable or cooperative — which is the whole reason the vendor-side step is not optional.

**What a revoked or expired key looks like on the dashboard:** the connection moves to a named state saying the credential no longer works, and sync pauses. It does not show an empty diary. That distinction matters for a booking system more than for most things on this list: "you have no appointments" is a completely believable answer for a quiet week, and there would be no way for you to tell it apart from a broken connection — so Droplet never gives it. A problem is always reported as a problem, never as an empty list.

**Deleting your data.** Droplet can delete everything it has read from a Cal.com connection, on request, scoped to that one connection — so a box serving two Cal.com accounts cannot lose the wrong one's data. Ask, and it is done as a single action.

---

**Related:** [`credential-handling.md`](credential-handling.md) · [`SETUP.md`](SETUP.md#3-track-b--a-cloud-service-you-already-pay-for-cloudsaas-providers) · [`README.md`](README.md)
