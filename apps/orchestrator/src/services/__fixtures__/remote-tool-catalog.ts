/**
 * WARP-2348 — representative REMOTE tool catalogs, for sizing and for the
 * selection tests that must exercise the dynamic half of the universe.
 *
 * WARP-2440 asks for the serialised cost of "134 local + a 50-tool remote
 * catalog" as a MEASURED number rather than an estimate. That measurement
 * needs a remote catalog to measure, and the two catalogs actually queued
 * behind this story are Atlassian (~50 tools, WARP-2316) and Slack (~15,
 * WARP-2317). Neither transport exists yet — WARP-2300 owns the MCP client
 * and multiplexer — so these fixtures stand in for the tool *shapes* those
 * servers advertise: the names are the real ones those servers expose, and
 * the descriptions and schemas are sized to match what an MCP server of that
 * kind actually sends.
 *
 * They are deliberately NOT wired into the registry: `TOOL_CATALOG` is
 * registry-derived and CI-gated for completeness (`catalog.test.ts`), and a
 * remote tool has no registry entry by definition. That is precisely the
 * condition this story exists to handle — see `tool-selection.service.ts`.
 *
 * SIZING HONESTY — read before quoting any number measured against these.
 * `tool-budget.service.test.ts` prints both means on every run; at the SHA
 * this fixture was written the local registry averaged ~705 chars per
 * serialised tool and these fixtures averaged ~388. So the remote figures
 * derived from them are a FLOOR, not a forecast: a real Atlassian server
 * shipping schemas as rich as the local registry's would cost roughly 1.8x
 * what is measured here.
 *
 * That direction is the safe one for this story's purpose — the numbers still
 * show a remote catalog blowing the budget, and they under-state rather than
 * over-state by how much. It would NOT be safe to size a headroom decision
 * against them. When the real transport lands (WARP-2300), re-measure against
 * the server's actual `tools/list` response and replace these fixtures rather
 * than trusting the floor.
 */
import type { RuntimeToolDescriptor } from "../runtime-tool-registry.service.js";

/** Shorthand for a fixture entry before the domain/source stamp. */
interface RemoteToolShape {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required?: string[];
}

function shape(
  name: string,
  description: string,
  properties: Record<string, { type: string; description: string }>,
  required: string[] = [],
): RemoteToolShape {
  return { name, description, properties, required };
}

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const bool = (description: string) => ({ type: "boolean", description });

/**
 * Atlassian MCP server — the Jira/Confluence/Compass surface (WARP-2316).
 * 50 tools, matching the count the server advertises.
 */
const ATLASSIAN_SHAPES: RemoteToolShape[] = [
  shape("jira_get_issue", "Fetch a single Jira issue by key or id, returning its summary, description, status, assignee and the fields requested. Use when the user names a specific ticket.", { issueIdOrKey: str("Issue key such as PROJ-123, or the numeric issue id."), fields: str("Comma-separated field names to return; omit for the default set."), expand: str("Extra sections to expand, such as renderedFields or changelog.") }, ["issueIdOrKey"]),
  shape("jira_search_issues", "Search Jira issues with a JQL query and return the matching issues with their key fields. Use for any question about more than one ticket, or when the ticket is described rather than named.", { jql: str("JQL query string, for example 'project = PROJ AND status = Open'."), maxResults: num("Maximum issues to return, 1-100."), fields: str("Comma-separated field names to return."), nextPageToken: str("Continuation token from a previous page.") }, ["jql"]),
  shape("jira_create_issue", "Create a new Jira issue in the given project with the supplied summary, description and issue type. Returns the created issue key.", { projectKey: str("Project key the issue belongs to."), issueType: str("Issue type name, for example Task, Bug or Story."), summary: str("One-line issue summary."), description: str("Issue description body."), assignee: str("Account id of the assignee, optional.") }, ["projectKey", "issueType", "summary"]),
  shape("jira_edit_issue", "Update fields on an existing Jira issue. Only the fields supplied are changed; everything else is left alone.", { issueIdOrKey: str("Issue key or id to edit."), summary: str("Replacement summary, optional."), description: str("Replacement description, optional."), labels: str("Comma-separated labels to set, optional.") }, ["issueIdOrKey"]),
  shape("jira_transition_issue", "Move a Jira issue to a different workflow status, such as In Progress or Done. Use jira_get_transitions first to learn the valid transition ids.", { issueIdOrKey: str("Issue key or id to transition."), transitionId: str("Transition id from jira_get_transitions."), comment: str("Optional comment to record with the transition.") }, ["issueIdOrKey", "transitionId"]),
  shape("jira_get_transitions", "List the workflow transitions currently available on a Jira issue, with their ids and target statuses.", { issueIdOrKey: str("Issue key or id.") }, ["issueIdOrKey"]),
  shape("jira_add_comment", "Add a comment to a Jira issue. The comment is attributed to the connected account.", { issueIdOrKey: str("Issue key or id to comment on."), body: str("Comment text, markdown accepted."), visibility: str("Optional group or role restricting who can see the comment.") }, ["issueIdOrKey", "body"]),
  shape("jira_get_comments", "Read the comment thread on a Jira issue, newest last, with author and timestamp for each comment.", { issueIdOrKey: str("Issue key or id."), maxResults: num("Maximum comments to return.") }, ["issueIdOrKey"]),
  shape("jira_add_worklog", "Log time worked against a Jira issue, optionally with a comment and a start timestamp.", { issueIdOrKey: str("Issue key or id."), timeSpent: str("Time spent, for example '3h 30m'."), comment: str("Optional worklog comment."), started: str("ISO-8601 start timestamp, optional.") }, ["issueIdOrKey", "timeSpent"]),
  shape("jira_list_projects", "List the Jira projects visible to the connected account, with key, name and project type.", { query: str("Optional substring to filter project names and keys."), maxResults: num("Maximum projects to return.") }),
  shape("jira_get_project", "Fetch a single Jira project's metadata: key, name, lead, issue types and components.", { projectIdOrKey: str("Project key or numeric id.") }, ["projectIdOrKey"]),
  shape("jira_list_boards", "List the Jira agile boards available, optionally filtered to one project.", { projectKeyOrId: str("Restrict to boards for this project, optional."), maxResults: num("Maximum boards to return.") }),
  shape("jira_get_board_sprints", "List the sprints on a Jira board, with their state, start and end dates.", { boardId: num("Board id from jira_list_boards."), state: str("Filter by sprint state: active, future or closed.") }, ["boardId"]),
  shape("jira_get_sprint_issues", "List the issues assigned to a Jira sprint, with status and assignee.", { sprintId: num("Sprint id."), maxResults: num("Maximum issues to return.") }, ["sprintId"]),
  shape("jira_create_issue_link", "Link two Jira issues together with a named relationship such as 'blocks' or 'relates to'.", { inwardIssue: str("Issue key on the inward side of the link."), outwardIssue: str("Issue key on the outward side."), linkType: str("Link type name, for example Blocks or Relates.") }, ["inwardIssue", "outwardIssue", "linkType"]),
  shape("jira_get_issue_link_types", "List the issue link types configured on this Jira site, with their inward and outward descriptions.", {}),
  shape("jira_assign_issue", "Assign a Jira issue to an account, or unassign it by passing an empty account id.", { issueIdOrKey: str("Issue key or id."), accountId: str("Account id to assign to; empty string unassigns.") }, ["issueIdOrKey", "accountId"]),
  shape("jira_lookup_account_id", "Resolve a person's display name or email to their Atlassian account id, needed by the assignment tools.", { query: str("Display name or email address to look up.") }, ["query"]),
  shape("jira_get_issue_watchers", "List the accounts watching a Jira issue.", { issueIdOrKey: str("Issue key or id.") }, ["issueIdOrKey"]),
  shape("jira_add_attachment", "Attach a file to a Jira issue from a path the connector can read.", { issueIdOrKey: str("Issue key or id."), filePath: str("Path of the file to attach.") }, ["issueIdOrKey", "filePath"]),
  shape("jira_get_issue_types", "List the issue types available in a Jira project, with the fields each one requires on create.", { projectIdOrKey: str("Project key or id.") }, ["projectIdOrKey"]),
  shape("jira_get_fields", "List the Jira fields on this site, including custom fields, with their ids and types.", { query: str("Optional substring to filter field names.") }),
  shape("jira_get_filters", "List the saved Jira filters the connected account can see, with their JQL.", { maxResults: num("Maximum filters to return.") }),
  shape("jira_get_remote_links", "List the remote links attached to a Jira issue, such as linked pull requests or external pages.", { issueIdOrKey: str("Issue key or id.") }, ["issueIdOrKey"]),
  shape("jira_bulk_get_issues", "Fetch several Jira issues in one call by key, cheaper than one call per issue.", { issueKeys: str("Comma-separated list of issue keys."), fields: str("Comma-separated field names to return.") }, ["issueKeys"]),
  shape("confluence_get_page", "Fetch a Confluence page by id, returning its title, body and version.", { pageId: str("Page id."), bodyFormat: str("Body format to return: storage, view or markdown.") }, ["pageId"]),
  shape("confluence_create_page", "Create a Confluence page in a space, optionally under a parent page.", { spaceKey: str("Space key the page belongs to."), title: str("Page title."), body: str("Page body content."), parentId: str("Parent page id, optional.") }, ["spaceKey", "title", "body"]),
  shape("confluence_update_page", "Update an existing Confluence page's title or body. The version number is incremented for you.", { pageId: str("Page id to update."), title: str("Replacement title, optional."), body: str("Replacement body, optional.") }, ["pageId"]),
  shape("confluence_search", "Search Confluence content with a CQL query, returning matching pages and their spaces.", { cql: str("CQL query string."), maxResults: num("Maximum results to return.") }, ["cql"]),
  shape("confluence_list_spaces", "List the Confluence spaces visible to the connected account, with key, name and type.", { maxResults: num("Maximum spaces to return.") }),
  shape("confluence_get_space_pages", "List the pages in a Confluence space, newest first.", { spaceKey: str("Space key."), maxResults: num("Maximum pages to return.") }, ["spaceKey"]),
  shape("confluence_get_page_children", "List the direct child pages of a Confluence page.", { pageId: str("Parent page id."), maxResults: num("Maximum children to return.") }, ["pageId"]),
  shape("confluence_get_page_descendants", "List every descendant page beneath a Confluence page, not just direct children.", { pageId: str("Ancestor page id."), depth: num("Maximum depth to walk, optional.") }, ["pageId"]),
  shape("confluence_add_footer_comment", "Add a footer comment to a Confluence page.", { pageId: str("Page id to comment on."), body: str("Comment body.") }, ["pageId", "body"]),
  shape("confluence_add_inline_comment", "Add an inline comment anchored to a text selection on a Confluence page.", { pageId: str("Page id."), body: str("Comment body."), selectionText: str("The page text the comment anchors to.") }, ["pageId", "body", "selectionText"]),
  shape("confluence_get_footer_comments", "Read the footer comments on a Confluence page, with author and timestamp.", { pageId: str("Page id.") }, ["pageId"]),
  shape("confluence_get_inline_comments", "Read the inline comments on a Confluence page, with the text each one anchors to.", { pageId: str("Page id.") }, ["pageId"]),
  shape("confluence_get_page_labels", "List the labels applied to a Confluence page.", { pageId: str("Page id.") }, ["pageId"]),
  shape("confluence_add_page_label", "Add a label to a Confluence page so it can be found by label search.", { pageId: str("Page id."), label: str("Label to add.") }, ["pageId", "label"]),
  shape("confluence_get_page_versions", "List the version history of a Confluence page, with author and edit message.", { pageId: str("Page id."), maxResults: num("Maximum versions to return.") }, ["pageId"]),
  shape("confluence_delete_page", "Move a Confluence page to the trash. The page can be restored from the space trash afterwards.", { pageId: str("Page id to delete.") }, ["pageId"]),
  shape("compass_get_component", "Fetch a Compass component by id or slug, with its type, owner team and links.", { componentIdOrSlug: str("Component id or slug.") }, ["componentIdOrSlug"]),
  shape("compass_list_components", "List the Compass components in this site, optionally filtered by type or owning team.", { type: str("Component type filter, optional."), ownerId: str("Owning team id filter, optional."), maxResults: num("Maximum components to return.") }),
  shape("compass_create_component", "Create a Compass component describing a service, library or other tracked asset.", { name: str("Component name."), type: str("Component type, for example SERVICE or LIBRARY."), description: str("Component description, optional.") }, ["name", "type"]),
  shape("compass_create_relationship", "Record a relationship between two Compass components, such as DEPENDS_ON.", { sourceId: str("Source component id."), targetId: str("Target component id."), type: str("Relationship type.") }, ["sourceId", "targetId", "type"]),
  shape("compass_get_custom_fields", "List the custom field definitions configured for Compass components.", {}),
  shape("atlassian_search", "Search across Jira, Confluence and Compass in one call, returning the best matches from each product with their type and url.", { query: str("Free-text search query."), products: str("Comma-separated products to search, defaults to all."), maxResults: num("Maximum results to return.") }, ["query"]),
  shape("atlassian_get_resources", "List the Atlassian sites the connected account can reach, with their cloud ids and urls.", {}),
  shape("atlassian_user_info", "Return the connected Atlassian account's own profile: account id, display name, email and timezone.", {}),
  shape("atlassian_fetch_url", "Fetch an Atlassian resource by its url and return the structured object behind it, for following a link the user pasted.", { url: str("Atlassian url to resolve.") }, ["url"]),
];

/**
 * Slack MCP server — the messaging surface (WARP-2317). 15 tools.
 * Slack's per-user OAuth means this catalog is per-connected-person, which
 * is why the budget question is asked once per user rather than once per box
 * (Romain's note on WARP-2348).
 */
const SLACK_SHAPES: RemoteToolShape[] = [
  shape("slack_send_message", "Post a message to a Slack channel or direct message conversation as the connected user.", { channel: str("Channel id or name, for example C0123ABCD or #general."), text: str("Message text, Slack markdown accepted."), threadTs: str("Timestamp of the parent message to reply in a thread, optional.") }, ["channel", "text"]),
  shape("slack_list_channels", "List the Slack channels the connected user can see, with id, name, topic and member count.", { types: str("Comma-separated channel types: public_channel, private_channel, im, mpim."), limit: num("Maximum channels to return.") }),
  shape("slack_get_channel_history", "Read recent messages from a Slack channel, newest last, with author and timestamp.", { channel: str("Channel id to read."), limit: num("Maximum messages to return."), oldest: str("Only messages after this timestamp, optional.") }, ["channel"]),
  shape("slack_get_thread_replies", "Read the replies in a Slack message thread, given the parent message timestamp.", { channel: str("Channel id."), threadTs: str("Parent message timestamp.") }, ["channel", "threadTs"]),
  shape("slack_search_messages", "Search Slack messages across the workspace with a query, returning matches with channel and permalink.", { query: str("Search query, Slack search syntax accepted."), count: num("Maximum results to return.") }, ["query"]),
  shape("slack_add_reaction", "Add an emoji reaction to a Slack message.", { channel: str("Channel id."), timestamp: str("Message timestamp."), name: str("Emoji name without colons, for example thumbsup.") }, ["channel", "timestamp", "name"]),
  shape("slack_list_users", "List the members of the Slack workspace, with id, display name, real name and whether they are a bot.", { limit: num("Maximum users to return.") }),
  shape("slack_get_user_info", "Fetch a single Slack user's profile: display name, real name, title, timezone and presence.", { user: str("Slack user id.") }, ["user"]),
  shape("slack_set_status", "Set the connected user's Slack custom status text, emoji and expiry.", { statusText: str("Status text to display."), statusEmoji: str("Emoji name including colons, optional."), expiration: num("Unix timestamp when the status clears, optional.") }, ["statusText"]),
  shape("slack_upload_file", "Upload a file to a Slack channel with an optional comment.", { channels: str("Comma-separated channel ids to share into."), filePath: str("Path of the file to upload."), title: str("File title, optional."), initialComment: str("Message posted with the file, optional.") }, ["channels", "filePath"]),
  shape("slack_create_channel", "Create a new Slack channel, public or private.", { name: str("Channel name, lowercase with hyphens."), isPrivate: bool("Whether the channel is private.") }, ["name"]),
  shape("slack_invite_to_channel", "Invite one or more users into a Slack channel.", { channel: str("Channel id."), users: str("Comma-separated user ids to invite.") }, ["channel", "users"]),
  shape("slack_get_permalink", "Get the shareable permalink url for a specific Slack message.", { channel: str("Channel id."), messageTs: str("Message timestamp.") }, ["channel", "messageTs"]),
  shape("slack_pin_message", "Pin a message to a Slack channel so it appears in the channel's pinned items.", { channel: str("Channel id."), timestamp: str("Message timestamp to pin.") }, ["channel", "timestamp"]),
  shape("slack_set_channel_topic", "Set the topic line of a Slack channel.", { channel: str("Channel id."), topic: str("New channel topic.") }, ["channel", "topic"]),
];

function toDescriptors(
  shapes: RemoteToolShape[],
  serverId: string,
  domain: RuntimeToolDescriptor["domain"],
): RuntimeToolDescriptor[] {
  return shapes.map((s) => ({
    name: s.name,
    serverId,
    domain,
    // Server-derived: these catalogs declare their own surface, so the
    // domain comes from the server registration rather than an operator
    // mapping or the fallback. See resolveRuntimeToolDomain.
    domainSource: "server" as const,
    description: s.description,
    inputSchema: {
      type: "object",
      properties: s.properties,
      required: s.required ?? [],
    },
  }));
}

/** The Atlassian catalog: 50 tools, all in the `pm` domain. */
export const ATLASSIAN_REMOTE_TOOLS: readonly RuntimeToolDescriptor[] =
  toDescriptors(ATLASSIAN_SHAPES, "atlassian", "pm");

/** The Slack catalog: 15 tools, all in the `team_chat` domain. */
export const SLACK_REMOTE_TOOLS: readonly RuntimeToolDescriptor[] =
  toDescriptors(SLACK_SHAPES, "slack", "team_chat");

/** Both remote catalogs together — the "worst case a box actually faces"
 *  once WARP-2316 and WARP-2317 have both landed. */
export const ALL_REMOTE_TOOLS: readonly RuntimeToolDescriptor[] = [
  ...ATLASSIAN_REMOTE_TOOLS,
  ...SLACK_REMOTE_TOOLS,
];
