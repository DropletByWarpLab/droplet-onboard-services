# Connect services through the existing Droplet chat

Ask AI keeps its existing composer, navigation, and message layout. A person asks
"show my connections" or "connect Stripe" in the conversation. The device agent
uses canonical tools to answer with a **card in the thread**, under the assistant's
message, the way the run card and the media cards already render. The person
fills the card in and continues in the same chat.

The design authority for the cards is the handoff packet in the shared brain,
`content/brand/handoffs/chat-connect/` (brief, 12 states with verbatim copy, safety
contract, protocol; ticket WARP-3904). The first iteration of this feature (#2728)
opened the existing Settings and Integrations dialogs from chat, with provider
sign-in in a popup window; the inline cards replaced that flow (decision D-I in the
brief). The contract, the orchestrator routes and the tools are the same in both.

## Interaction

```mermaid
flowchart TD
  Chat[Existing Ask AI chat] --> Ask{Person's request}
  Ask -->|Show connections| List[list_connections]
  Ask -->|Connect a named service| Start[start_connection]
  Ask -->|Disconnect a service| Stop[disconnect_connection]
  List --> Overview[Connections card in the thread: rows with status, pills to add]
  Overview -->|Pick a pill| Start
  Start --> Card[Connect card in the thread: credentials · oauth · mailbox · calendar · wizard · blocked]
  Card -->|Credentials, mailbox, calendar| REST[Existing authenticated setup routes, posted by the browser]
  Card -->|Google / Microsoft| Consent[Provider sign-in in this tab, returnTo /chat]
  Card -->|LAN track| Hub[/integrations?connect=id opens the hub's own setup]
  Stop --> Approve[Existing approval card, 60 s challenge]
  REST --> Result[Card flips to connected or failed, in place]
  Consent --> Return[/chat?provider=outcome reopens the conversation]
  Return --> Result
  Result --> Turn[One quiet follow-up turn: "Name is connected now."]
  Turn --> Chat
```

No Connections button is added to the composer. A card is a live form only on the
newest assistant message of a conversation open in this session; a loaded
transcript, an older turn, or a surface that cannot send a turn shows a compact
row with a link to where the connection is managed. "Not now" collapses the card
without a turn. A failure shows a `role="alert"` block inside the card, clears
every secret field, and sends nothing to the model.

## Device architecture

The orchestrator owns the connection overview and provider resolution. The
`packages/tools-core` registry exposes `list_connections`, `start_connection`, and
`disconnect_connection` through the existing agent and MCP dispatch paths. The
connection domain is selected for connection-related requests. Descriptors use the
canonical provider registry, covering personal Google and Microsoft accounts,
mailboxes, calendar subscriptions, and catalog integrations. Unsupported providers
retain truthful setup instructions rather than inventing a connection flow.

The dashboard validates tool-result descriptors with the shared-types parsers
before rendering anything: POST targets are allowlisted (the hub's connect and
credential routes, the mailbox and calendar routes, the two OAuth starts), hrefs
must be same-origin, and a secret field never arrives pre-filled. Model-provided
input fields and paths never define a credential form beyond what the descriptor
allows. Passwords and keys go directly from the card's form to the existing
authenticated route; the tool, transcript, and model never receive them. Outcomes
contain only fixed product copy. The Patterson API track is a wizard hand-off to
the Integrations hub, which mounts its own descriptor-driven setup; chat never
opens the SQL wizard for it.

Owner/admin roles manage shared integrations and mailboxes. Family users manage
their own supported account and calendar connections. MCP requests resolve the
asserted person's canonical identity and role on the server; a browser cannot
impersonate another person with the assertion header. Removing a connection uses
the existing approval mechanism, owned-record checks, teardown services, and audit
semantics.

## Account approval and the way back

Google and Microsoft sign-in starts from the card with the existing
`POST /api/google/connect` / `POST /api/m365/connect` call and `returnTo: "/chat"`,
an exact entry in the server-side allowlist (no queries, hashes, or arbitrary
paths). Before leaving, the card stores a short-lived record (conversation id,
provider, display name) in sessionStorage. The callback lands on the box, seals the
token, and redirects to `/chat?<provider>=<outcome>`. The chat page reads and clears
the record, strips the parameter, reopens that conversation, and sends the quiet
follow-up turn only for the success outcome; any other outcome is a toast and no
turn. A record older than fifteen minutes, or one for a different provider, is
ignored. Signing out clears the record so the next person on the tab does not
inherit it. Draft text and staged attachments survive the round trip; the
follow-up turn never consumes files waiting in the composer.

## Availability and validation

Existing provider availability, permission, network, and administrator
configuration requirements still determine which connections can complete. No live
vendor account is connected during validation.

Tests exercise registry/MCP wiring, prompt budgets, provider resolution, descriptor
validation, identity isolation, the card forms (what is posted, and that nothing
typed reaches the follow-up turn, the console, or a URL), the return record, history
replay, draft/file preservation, and the strict OAuth return destination. This does
not prove live vendor OAuth or credential verification on a deployed Droplet.
