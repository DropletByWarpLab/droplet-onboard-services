# Connecting Klaviyo

> **Audience:** the person who owns the Klaviyo account.
> **Time:** about five minutes, plus two more if you want campaign performance numbers.
> **What Droplet does with what you paste:** [`credential-handling.md`](credential-handling.md).
> **Sources checked 2026-09-03** — against Klaviyo's own developer documentation, its help centre, its versioning policy and its pricing page. **Not yet walked through the live Klaviyo console by us**, so treat the screen and button names below as a close guide rather than a screenshot. Two questions on this page are explicitly still open, and they are flagged as open rather than guessed at. Where Klaviyo's own two documentation sites disagree, this page says so instead of picking one.

---

## Three things to know before you start

**1. Klaviyo lets you choose how much the key can see. Choose the smallest.**

Unlike some of the other services here, Klaviyo does not hand out one all-powerful key. When you create one you pick a scope, and **Read-only is the one you want**. Droplet never writes to Klaviyo — it does not send campaigns, edit lists, add or remove people, or change anyone's subscription status — so a Full Access key would grant powers we have no feature for.

Be clear-eyed about what Read-only still means, though. **A Read-only key can read essentially everything in the account**: every profile and their email addresses, every list and who is on it, every campaign you have sent, and every recorded event — opens, clicks, orders. It cannot change anything, but it is not a narrow view of your marketing data. It is your whole marketing data, in read mode.

If you want to go further, Klaviyo also offers a **Custom** scope, where you tick individual permissions. Droplet needs read access to **profiles, lists, campaigns, events and metrics** and nothing else. That is the tightest key that will work.

**2. Klaviyo shows a private key exactly once, and can never show it again.**

There is no reveal button and no support recovery. If you navigate away before copying it, the fix is entirely in your hands: create a new key with the same scope, paste that one into Droplet, and then delete the orphan at Klaviyo so it is not left lying around.

The same is true of the scope. **A key's scope cannot be edited after it is created.** Narrowing or widening access always means delete-and-recreate — so it is worth getting the scope right the first time.

**3. Klaviyo's rate limits are shared across your whole account, not per key.**

This one has a consequence you should know about before you connect. Klaviyo meters API usage **per account**, and every integration you have — your ecommerce platform's sync, your agency's scripts, anything else you have plugged in — draws on the same allowance. Droplet's polling is deliberately conservative for exactly this reason, but it is honest to say plainly: **we share your allocation, not our own.**

The flip side is also true, and it is why Droplet does not treat this as a fault. If Klaviyo tells the box to slow down, that may be because something else on your account is busy, not because anything is wrong here. Droplet waits and tries again rather than reporting a problem.

---

## Plan prerequisite

**We do not know whether Klaviyo's Free plan can use the API, and we are not going to assert either answer until we have tested it.**

That is deliberately blunt. Here is the state of it:

- Klaviyo's free plan is real and generous enough for a small business: up to **250 active profiles** and **500 email sends a month**, indefinitely.
- Nothing in Klaviyo's API-key or authentication documentation names a plan tier as a gate on creating a key.
- **But no Klaviyo page says affirmatively that a Free account may make API calls.** The pricing page talks about which *integrations* the free plan supports, which is a different question from whether the developer API is open to it.
- **Nobody at Warp Lab has confirmed it against a real Free-plan account.**

**What to do if you are on the Free plan:** try it. The setup takes five minutes and costs nothing, and Droplet will tell you plainly whether the key works — it makes one cheap test call the moment you connect and reports the actual answer rather than sitting on a spinner. If it fails, that is a genuine finding and we would like to hear about it, because it decides whether we can offer this connector to Free-plan businesses at all.

Beyond that, the prerequisite is simply that you can sign in to the Klaviyo account that owns the lists you want read, **with a role that can create API keys** — see the click-path below, where Klaviyo's own two documentation pages disagree about which roles those are.

---

## Cost

**Klaviyo does not charge for API keys or API calls.** Creating a key is free, and the reads Droplet makes are not billed to you. Connecting Droplet adds nothing to your Klaviyo invoice.

Two things that cost you something other than money:

- **Your account's shared rate allowance**, as described above. Droplet's default polling is deliberately slow.
- **Campaign performance numbers have a hard daily cap.** The Klaviyo report that carries send, open and click counts is limited to **225 calls a day for the whole account** — again shared with everything else you have connected. Droplet asks for all your campaigns in a single call rather than one per campaign, so in normal use this is nowhere near a problem. But if those numbers are ever unavailable for a while, this is why, and it clears on its own.

The only open money question is the plan question above: if it turns out the Free plan cannot use the API, then the cost of connecting Klaviyo is the cost of Klaviyo's cheapest paid tier — and we will say so here as soon as we know.

---

## Click-path

Do this in a browser, signed in to Klaviyo.

1. **Sign in to Klaviyo with an account that can manage API keys.** Klaviyo's own two documentation sites disagree about which roles those are: its **developer documentation says Owner, Admin *or Manager***, while its **help centre says Owner or Admin**. If you are a Manager, try it — if the **Create Private API Key** button is not there, you need an Owner or Admin to do this step. We would rather tell you the two pages conflict than pick one and have you escalate for no reason.
2. Click your **organization name** in the bottom left.
3. Go to **Settings**.
4. Click **API keys**.
5. Click **Create Private API Key**.
6. **Name it something you will still recognise in two years.** `Droplet — <your office name>` beats `key 3`. This name is the only thing that will later tell you which key belongs to the box.
7. **Choose the scope: pick Read-only.** Droplet never writes to Klaviyo. If you want to be stricter still, choose **Custom** and grant read on **profiles, lists, campaigns, events and metrics** only. Remember you cannot change this later without deleting the key and making a new one.
8. Click **Create**.
9. **Copy the key now.** It begins `pk_`. Klaviyo shows a private key once and will never redisplay it. Check what you pasted did not wrap across two lines and lose its tail — Droplet refuses a key with a line break in it rather than sending a broken credential.
10. In Droplet: **Integrations → Klaviyo → Connect**, read the capability statement, paste the key, and confirm.
11. **Optional — only if you want campaign send, open and click counts.** Those numbers do not live on Klaviyo's campaign records; they come from a separate report that needs to know which event counts as a sale for you. In Klaviyo go to **Analytics → Metrics**, open the metric that represents a sale (usually **Placed Order**), copy its ID from the address bar, and paste it into Droplet's **Conversion metric ID** field. Without it, lists, contacts and activity all work normally; campaign performance does not, and Droplet will say so rather than showing you campaigns that appear to have reached nobody.

---

## Scopes and permissions

**Klaviyo does give you a choice here, and Read-only is the right one.** Droplet asks for read access and nothing more.

| What it reads | Why |
|---|---|
| **Profiles** | The people you market to — name, email, when their record last changed. |
| **Lists** | Your mailing lists and how many people are on each. |
| **List membership** | Who is on which list, and — the important part — **what consent state they are in**. |
| **Campaigns** | What you sent, when, to whom, and how it performed. |
| **Events** | What people actually did: opened, clicked, ordered. |
| **Metrics** | The names of the things you measure. Also the cheap call Droplet uses to check the key works. |

**Droplet does not write to Klaviyo.** It cannot send a campaign, subscribe or unsubscribe anybody, suppress a profile, import a list, or edit a template — those surfaces do not exist in the connector at all, at any level. That is enforced in Droplet's own code and checked by its test suite, and it is also the reason we ask you for a Read-only key: so that our promise and Klaviyo's enforcement say the same thing.

**Two things Droplet cannot see, and one it can only see slowly.**

- **When somebody leaves a list, or changes their mind.** Klaviyo's list-membership data can be searched for people who *joined* since a date, but not for people who left or whose consent changed. So Droplet re-reads membership in full rather than asking for "what changed" — it is slower, and it is the only way to get the answer right.
- **Anything about money.** Droplet deliberately does not read order values out of Klaviyo. Klaviyo records a purchase as a free-form event that carries no guaranteed currency, and a figure whose currency has to be guessed is not a number worth having. Your revenue numbers should come from the system that actually took the payment.
- **Campaign performance**, which needs the optional conversion metric ID from step 11 and is subject to the daily cap described under **Cost**.

---

## Rotation and expiry

**Klaviyo private API keys do not expire.** The one you create today will still work in three years unless you delete it. Nothing on Klaviyo's side will prompt you to reconsider it, and nothing on ours can — see [`credential-handling.md`](credential-handling.md).

**Rotating on purpose.** Create a new key in **Settings → API keys** with the same scope, paste it into Droplet, and then **delete the old one**. Do not assume a grace period: create the new one first, put it in place, then remove the old.

Rotation replaces the stored credential and leaves everything else alone — the connection keeps its identity, and everything already synced stays.

**Do rotate when someone leaves.** A private key never expires, so an old one is a standing key to your marketing database. If the person who created it has left, or the key has ever been pasted into a chat message or a shared document, replace it.

**Changing the scope means a new key.** Klaviyo cannot edit a key's permissions after creation. If you started with Read-only and want to narrow it to Custom (or the other way round), that is delete-and-recreate — treat it as a rotation.

**One expiry that is not the key's.** Klaviyo versions its API by date and retires a version after about two years. Droplet pins a version deliberately, and asks Klaviyo to **fail loudly** rather than quietly serve a different shape of data when that version retires — so if it ever happens, you will see a clear message telling you the box needs updating, not months of subtly wrong numbers. There is nothing for you to do about this in advance.

---

## Revocation

**You control this entirely. We cannot revoke on your behalf**, and Droplet finds out only on its next call.

**To stop Droplet reading Klaviyo:**

- **On the box:** `Integrations → Klaviyo → Manage → Disconnect`. This purges the stored key from the box and stops all reading. Data already synced stays until you delete it.
- **At Klaviyo:** go to **Settings → API keys**, find the key by the name you gave it, and **delete** it. Do this as well as disconnecting. Disconnecting stops Droplet using the key; only deleting it at Klaviyo stops the key existing.

**Do both, in that order**, if you are decommissioning a box or handing it back.

**If you suspect the box has been tampered with**, delete the key at Klaviyo first — that takes effect immediately and does not depend on the box being reachable or cooperative.

**What a revoked key looks like on the dashboard:** the connection moves to a named state saying the credential no longer works, and sync pauses. It does not show an empty contact list. That distinction matters: "you have no contacts" is a believable-looking answer for a small business and there is no way for you to tell it apart from a broken connection, so Droplet never gives it.

**Deleting your data.** Droplet can delete everything it has read from a Klaviyo connection, on request, scoped to that one connection — so a box serving two Klaviyo accounts cannot lose the wrong one's data. Ask, and it is done as a single action.

---

**Related:** [`credential-handling.md`](credential-handling.md) · [`SETUP.md`](SETUP.md) · [`README.md`](README.md)
