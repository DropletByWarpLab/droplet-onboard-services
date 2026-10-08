# Add connections from Ask AI

People should be able to add Droplet accounts and integrations while working in
the device's chat. The composer gets a **Connections** action that works even
when no model is available or a reply is streaming. Opening setup preserves the
message draft and leaves the conversation in place.

## Implemented in this change; unreleased

- Search and category browsing use the same complete catalog and reported
  connection states as the Integrations hub. Providers reported by the device
  without a matching catalog entry remain visible.
- Google, Microsoft, mailbox, and calendar setup reuse their existing device
  forms. Business integration setup reuses the descriptor-driven wizard and
  credential configurator. Setup stays in a dialog inside Ask AI wherever an
  existing reusable form exists; detail routes retain their established
  navigation behavior.
- Owners and administrators can set up shared integrations and mailboxes.
  Family users can set up their own supported accounts and calendars. Guests
  have no connection action. Shared status requests run only during an
  authorized open setup flow.
- Google and Microsoft sign-in return to the allowlisted `/chat` destination.
  Tab-local navigation context restores the conversation and opens the account
  card to show the real callback outcome. A canonical-host handoff carries only
  the provider choice and conversation id; browser session storage, including a
  draft, remains specific to its origin.
- Credentials stay in the existing setup forms and REST requests. Opening or
  completing setup does not send a chat message, add credentials to a transcript,
  or call a model. Connection success is determined by the existing backend
  checks, rather than by saving a credential.

## Conversational direction

The companion wireframe explores both the connection browser and an assistant
response containing a connection card. Assistant-driven discovery and setup
descriptors belong in the existing `packages/tools-core` registry, orchestrator,
MCP surface, and chat tool-result renderer. That separate connection-card work is
not published by this change. This entry point can coexist with it.

The broader product direction includes PDF creation and editable `.pptx` and
`.xlsx` creation through device tools. Those capabilities are outside this
connection entry-point change, and their availability is not asserted here.

## Validation

Behavioral coverage includes complete catalog visibility, available/unavailable
dispatch, unknown reported providers, search, status errors, role transitions,
existing setup reuse, conversation return, and preserving the composer draft.
OAuth route tests exercise the exact `/chat` destination and reject arbitrary
paths, queries, hashes, and trailing slashes. Browser inspection uses mocked API
responses to exercise the real dashboard UI without connecting an account.
