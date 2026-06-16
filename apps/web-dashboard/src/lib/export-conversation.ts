/**
 * Export a persisted conversation as a Markdown transcript.
 *
 * The backend already returns everything needed via
 * `GET /api/llm/conversations/:id` (fetchConversation) — export is purely
 * client-side serialization plus the same blob-download glue
 * SessionHeader uses for the brain-memory zip.
 */
import { fetchConversation, type PersistedConversation } from "./api";

/** Pure serializer — exported separately for unit tests. */
export function conversationToMarkdown(conv: PersistedConversation): string {
  const lines: string[] = [];
  lines.push(`# ${conv.title?.trim() || "Chat"}`);
  lines.push("");
  const meta: string[] = [];
  if (conv.model) meta.push(`model: ${conv.model}`);
  if (conv.createdAt) meta.push(`started: ${conv.createdAt}`);
  if (meta.length > 0) {
    lines.push(`_Exported from Droplet AI (${meta.join(" · ")})_`);
    lines.push("");
  }
  lines.push("---");

  for (const m of conv.messages) {
    // The chat surface renders user/assistant only; tool and system rows
    // are plumbing (raw JSON payloads) that don't belong in a transcript.
    if (m.role !== "user" && m.role !== "assistant") continue;
    const content = m.content.trim();
    const toolNames = (m.toolCalls ?? []).map((c) => c.name);
    // Empty assistant placeholders (crashed/aborted turns with no
    // content and no tool activity) add nothing — skip them.
    if (!content && toolNames.length === 0) continue;

    lines.push("");
    lines.push(m.role === "user" ? "**You:**" : "**Droplet:**");
    lines.push("");
    if (content) lines.push(content);
    if (toolNames.length > 0) {
      if (content) lines.push("");
      lines.push(`_Used tools: ${Array.from(new Set(toolNames)).join(", ")}_`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/** Make a filesystem-safe filename stem from the conversation title. */
function filenameStem(title: string | null): string {
  const stem = (title ?? "chat")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return stem || "chat";
}

/**
 * Fetch + serialize + download. Throws when the conversation can't be
 * fetched so the caller can surface the failure (menu item shows an
 * alert / toast at its discretion).
 */
export async function exportConversationMarkdown(id: string): Promise<void> {
  const conv = await fetchConversation(id);
  if (!conv) throw new Error("Conversation not found");
  const blob = new Blob([conversationToMarkdown(conv)], {
    type: "text/markdown",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filenameStem(conv.title)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
