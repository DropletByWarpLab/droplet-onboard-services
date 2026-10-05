# Work webhooks and chat-app notifications

> **Status:** shipped with WARP-3532 (Work Suite WS-16, [ADR-069](ADR-069-work-suite-projects-service-desk.md) §7 and §9).
> **Owner:** Projects. **Audience:** whoever builds a receiver, and whoever builds the next consumer of the `PmActivity` outbox.

A webhook sends one message to an address you choose each time work changes on this Droplet: a work item is created, moves to another state, is assigned, is commented on, is archived, or is otherwise changed. The same event can be rendered for Slack, Microsoft Teams, Discord or Google Chat, or sent as signed JSON to anything else, such as a local n8n or Home Assistant.

Set them up under **Settings → Integrations → Work notifications** (`/integrations/work-notifications`). Owners and admins only.

## What may leave the box

Nothing leaves unless an owner decides it may. Two independent rules apply to every delivery.

| Destination | Needs the switch? | Guarded by |
|---|---|---|
| An address on the box's own LAN (RFC 1918 `10/8`, `172.16/12`, `192.168/16`, or an IPv6 ULA `fc00::/7`) | No | The SSRF guard, always |
| Anything else (the internet) | **Yes**: the owner's *Send work updates outside your network* switch, off by default | The switch, then the SSRF guard |

The switch is the `work_integrations` channel of the off-LAN allowlist ([ADR-012](ADR-012-phone-home-egress-control.md)). One switch, not one per integration: the decision an owner makes is "may work data leave this box", and each webhook still needs to be configured explicitly. With it off, deliveries to the internet are **kept, not dropped**: they stay `Waiting` in the delivery log with the error *Blocked by egress setting*, are looked at again every minute, and go out within about a minute of the owner turning the switch on. A delivery older than 48 hours is dropped whatever its state.

### The address guard

Before every request the box resolves the host **once**, checks **every** address it answered with, and connects to the address it checked. It refuses:

| Refused | Examples |
|---|---|
| Anything that is not `http` or `https`; a URL with a username or password | `file:`, `ftp:`, `https://user:pass@host/` |
| Loopback | `127.0.0.0/8`, `::1`, `localhost`, `*.localhost` |
| Link-local | `169.254.0.0/16`, `fe80::/10` |
| Multicast and broadcast | `224.0.0.0/4`, `ff00::/8`, `255.255.255.255` |
| Unspecified and "this network" | `0.0.0.0/8`, `::` |
| Cloud instance-metadata addresses | `169.254.169.254`, `169.254.170.2`, `fd00:ec2::254`, `*.internal` |
| Other special-purpose space | CGNAT `100.64.0.0/10`, benchmarking, reserved, 6to4 and NAT64 prefixes |
| **This box itself**, in every shape it can be addressed | its own interface addresses, the compose bridge and `host.docker.internal`, sibling containers, the host's LAN address |
| A name that resolves to any of the above | a public name pointed at `127.0.0.1` (a DNS-rebind attempt) |

IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is judged by the IPv4 address inside it. A name with one acceptable answer and one refused answer is refused outright. The request then goes to the address that was checked, with the **original hostname as `Host` and as the TLS server name**, certificate verification on, **no redirects followed** (a `3xx` is a failed attempt), and the response body never read.

Consequences worth knowing:

- A LAN receiver over **HTTPS must present a certificate that verifies for the name in the address**. A self-signed certificate fails with *TLS certificate not trusted*; use `http://` on a LAN, or a certificate your devices trust.
- An address that only makes sense on the Droplet itself cannot be a webhook target. That is deliberate.
- The guard runs when an address is saved (a bad address is refused immediately with one fixed sentence that does not say which rule fired) **and again on every send**, so a name that later starts resolving somewhere forbidden stops working.

## Delivery

One event, one `POST` per webhook subscribed to it:

```
POST <your address>
Content-Type: application/json
User-Agent: Droplet-Webhooks/1
X-Droplet-Event: work_item.state_changed
X-Droplet-Delivery: 7c0f0e0e-3d5a-4a37-9b2e-5d2f2f7b6a10
X-Droplet-Signature: t=1791115200,v1=5b1f…e0
```

| Header | Meaning |
|---|---|
| `X-Droplet-Event` | The event name. |
| `X-Droplet-Delivery` | This delivery's id. A re-delivery has a new one. |
| `X-Droplet-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA-256>`. See below. |

**Success is any `2xx`**, answered within 10 seconds. Anything else, including a redirect, a timeout and a refused connection, is a failed attempt.

**Retries.** After the first failure the box tries again 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, 12 hours and 24 hours later: eight attempts in all, then it gives up. If a webhook fails **20 attempts in a row** (any success resets the count) the box turns it off and tells the owners and admins; its queued deliveries are given up rather than held, so turning it back on does not replay a stale burst.

**Delivery is at-least-once.** A delivery can arrive twice (the receiver answered but the box did not hear it), and deliveries for one webhook can arrive out of order when an earlier one is being retried. Deduplicate on the payload's `id` and order by `occurredAt`.

**Latency.** A change reaches the receiver about 6 to 16 seconds after it is made: the settle window below, then at most one pass of the delivery worker (it also runs the moment a delivery is queued, so usually much sooner). That is deliberate: the box reads its activity feed only after each row has had time to settle, so it cannot skip an event whose database transaction committed late (see *The PmActivity outbox*, below).

**Log and limits.** Each webhook keeps a delivery log for 30 days: status, attempts, the receiver's response code or a fixed description of what went wrong (never the address, never the response body). *Send again* in the log queues the same event as a new delivery with the same payload and `id`. A workspace holds at most 50 webhooks.

## Verifying a request

The signature proves the message came from this box and was not altered. `secret` is the `whsec_…` string shown **once** when the webhook was created or its secret rotated (rotation takes effect immediately, queued retries included).

```
signature = hex( HMAC_SHA256( secret, t + "." + body ) )
```

`body` is the **exact bytes** of the request body. Verify against the raw body, not a re-serialised copy. Reject a request whose `t` is more than five minutes from your clock: `t` is inside the signed text, so a captured request cannot be replayed under a fresh timestamp.

```js
// Node
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(secret, rawBody, header, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1 ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

```python
# Python
import hashlib, hmac, time

def verify(secret: str, raw_body: bytes, header: str, tolerance: int = 300) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    t = int(parts["t"])
    if abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))
```

HMAC-SHA-256 is FIPS-approved, so signing needs no exception on a box running in FIPS mode. The orchestrator's own tests verify its signatures with an independent implementation of exactly this algorithm.

Chat apps ignore these headers; they are sent regardless.

## Events

One activity row is exactly one event, so a receiver subscribed to everything never hears one change twice.

| Event | Fires when |
|---|---|
| `work_item.created` | A work item is created. |
| `work_item.state_changed` | It moves to another state. |
| `work_item.assigned` | Someone is **assigned** to it. |
| `work_item.commented` | Someone comments on it. |
| `work_item.archived` | It is archived. (The archive action itself arrives with WS-4; the event is wired now.) |
| `work_item.updated` | Anything else: title, description, priority, due date, labels, a **person taken off** (`unassigned`), cycles, modules, relations, being restored. `changes` says what, when the change has values. |

`webhook.test` is what *Send test* sends. It can not be subscribed to.

**Reserved, not emitted yet.** `ticket.created`, `ticket.replied`, `ticket.solved` (the service desk, WS-12 to WS-14) and `sla.at_risk`, `sla.breached` (WS-14) are named so receivers can plan for them, but nothing emits them and a webhook cannot subscribe to them: `PmProject.kind` and the SLA engine are not on this branch. They join the subscribable set in the PR that starts emitting them. When `PmProject.kind` lands, a service-desk project's items must stop being reported as `work_item.*`: a ticket fetched through the Projects surface is a 404, and it must not leak out through a webhook either.

## Payload v1

`Content-Type: application/json`. Calendar dates are `YYYY-MM-DD`; instants are ISO 8601 in UTC.

```json
{
  "version": 1,
  "id": "5d1c6d2e-6a53-4a9a-8f0e-0c1f3a9f5b11",
  "event": "work_item.state_changed",
  "occurredAt": "2026-10-04T12:00:00.000Z",
  "workspace": { "id": "…", "slug": "home", "name": "Home" },
  "project": { "id": "…", "identifier": "ENG", "name": "Engineering" },
  "workItem": {
    "id": "…",
    "key": "ENG-12",
    "name": "Fix the login bug",
    "url": "https://droplet.example/projects?p=ENG&item=ENG-12",
    "state": { "id": "…", "name": "In progress", "group": "started" },
    "priority": "high",
    "assignees": [{ "id": "…", "name": "Ben Ortiz" }],
    "startDate": null,
    "dueDate": "2026-10-10"
  },
  "actor": { "kind": "user", "id": "…", "name": "Ana Cruz" },
  "changes": [
    { "field": "state", "from": "…", "to": "…", "fromLabel": "Todo", "toLabel": "In progress" }
  ]
}
```

| Field | Notes |
|---|---|
| `version` | `1`. Fields may be added to v1; one is never removed or retyped without a v2. Ignore fields you do not know. |
| `id` | The event's id: stable across retries, re-deliveries and webhooks. For work-item events it is the activity row's id. **Deduplicate on this.** |
| `occurredAt` | When the change was recorded. |
| `project` | `null` for `webhook.test`. |
| `workItem` | `null` for `webhook.test`. Reflects the item when the event was **processed**, a few seconds after it happened; `changes` carries the event's own before and after. `url` is on the box's canonical address, reachable from the LAN or the VPN, not the internet. |
| `actor` | `kind: "system"` with null `id` and `name` when nobody did it (the assistant, a tool call). |
| `changes` | Empty when the event has no diff (`created`, `commented`, `archived`) or when the change had no values (a title, description, start-date or label edit). Otherwise one entry: `field` is `state`, `priority`, `dueDate`, `assignees`, `department`, `parentId` or `relation` (`KIND:<work item id>`); `from` and `to` are the raw values (ids for `state` and `assignees`), `fromLabel` and `toLabel` the readable form where there is one. |

**Deliberately not sent:** comment text (the event does not point at its comment, and comments are where customer data lives; follow `url`), descriptions, labels, custom fields, and anyone's email address or username.

## Chat apps

Pick the app when you add the webhook and paste the address its admin screen gives you. The box renders the same event as that app's incoming-webhook body at send time, so switching a webhook from Slack to Teams re-renders what is still queued.

| Format | Body | Escaping |
|---|---|---|
| Slack (and Slack-compatible receivers) | `{ "text": "*Ana Cruz* moved <link\|ENG-12 Fix the login bug> to In progress" }`, link previews off | `&`, `<`, `>` entity-escaped, so a title of `<!channel>` cannot page a workspace |
| Microsoft Teams | An Adaptive Card in a `message` envelope, for the Workflows "when a webhook request is received" trigger | Markdown characters escaped; no mention entity is ever set |
| Discord | `{ "username": "Droplet", "content": "…", "allowed_mentions": { "parse": [] } }` | `allowed_mentions` empty: it can name anyone and ping no one |
| Google Chat | `{ "text": "…" }` | `<` and `>` broken so `<users/all>` does not parse |
| JSON | Payload v1, verbatim | n/a |

Everywhere: control characters and newlines in titles and names collapse to a space, and long text is truncated, so a work item's title cannot forge a second line or a wall of text.

## Security notes

- **The address is a credential.** For a chat app, anyone holding the address can post as the integration. The full URL is encrypted at rest with webhook-specific authenticated data. A read never returns it: the page shows the destination (scheme, host, port) and nothing after it, and changing the address means pasting it again. It is never written to a log, an audit row or a notification.
- **The signing secret** is generated by the box (`whsec_` plus 256 random bits), sealed at rest with AES-256-GCM under the same key hierarchy as connector credentials ([ADR-042](ADR-042-customer-supplied-credentials.md)) and bound to its own row, so a copied blob does not open elsewhere. It is returned exactly twice in a webhook's life: when it is created and when it is rotated.
- **Who can do what.** Every route is owner and admin only, reads included (the address is a credential and the log names work items). Only the owner can change the egress switch. The audit feed records who created, changed, paused, resumed, rotated or deleted which webhook, with its destination and format.
- **Not reachable from outside.** This is outbound only. Nothing here opens a port or accepts a request from the internet ([ADR-009](ADR-009-canonical-system-architecture.md)).
- **A scan oracle, bounded.** *Send test* and the delivery log tell an owner or admin whether a LAN address answered. Sending to LAN devices is the feature, so that is inherent; it is limited to owner and admin and rate-limited.

## The PmActivity outbox (for the next consumer)

[ADR-069](ADR-069-work-suite-projects-service-desk.md) §7: every PM mutation already writes a `PmActivity` row inside its own transaction, so the table is a transactional outbox. A consumer reads it; it does not add emit calls to `pm.service.ts`. WS-9 (automation) and WS-19 (live updates) register theirs on `apps/orchestrator/src/services/pm/pm-outbox.ts`:

```ts
registerOutboxConsumer(
  { name: "automation", intervalMs: 5_000, handle: async (row) => { /* idempotent */ } },
  { prisma, cronRuntime },
);
```

- **Cursor.** Each consumer has its own `(createdAt, id)` cursor in `SystemFlag` under `pm-outbox:<name>`. A brand-new consumer starts at *now* and never replays history.
- **Scheduling.** `registerOutboxConsumer` is a `cron-runtime` interval under the advisory lock `droplet:pm-outbox:<name>`, run once at registration. `writeActivity` (and the two bulk write sites) call `nudgeOutbox()` after a write, which wakes every consumer once its newest row has settled. A guard test fails if a new `pmActivity.create` site does not nudge.
- **At-least-once.** The cursor moves after the handler returns, so a crash in between replays the row. **Handlers must be idempotent.** The webhook fan-out keys each delivery `(webhookId, "activity:<row id>")` with `skipDuplicates`.
- **Order, and a failing row.** Rows are handled one at a time, oldest first. A handler that throws stops the sweep at that row, the cursor stays before it, and the error is rethrown so `cron-runtime` logs and counts it. A row that keeps failing for five minutes (at least three failures) is **dead-lettered**: logged at error with its id, verb and work item, and skipped, so one poison row cannot block everything behind it. A database blip fails every row for seconds and is not poison.
- **The settle window.** `createdAt` is stamped when the `INSERT` is issued, not when its transaction commits. A reader that moved its cursor past a younger committed row could skip an older row that commits later, for good. So a consumer reads only rows that have been still for `settleMs`, default **6 s**: Prisma interactive transactions time out at 5 s and no PM write path raises that. A writer that raises its transaction timeout above 5 s must raise this too. A consumer whose events are advisory (WS-19's "something changed, refetch") may pass a smaller `settleMs` and accept a rare missed nudge; one that acts keeps the default.
- **Events that are not activity rows** (WS-14's SLA transitions) call `enqueueWebhookDeliveries` (`webhook-fanout.ts`) with their own idempotence key.
