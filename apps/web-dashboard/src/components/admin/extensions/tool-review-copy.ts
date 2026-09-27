/**
 * WARP-3205 — the words of the owner's tool review on `/admin/extensions`.
 *
 * Every sentence here is the box's. The only values interpolated are a tool
 * name (the manifest's TOOL_NAME_PATTERN: snake_case) and an extension id
 * (EXTENSION_SLUG_PATTERN); nothing the extension wrote as prose — its
 * description, a note inside its input schema, a server message, an error it
 * raised — is ever spliced into one of them. A refusal this file does not
 * know reads as a fixed sentence.
 */
import { ExtensionRequestError } from "@/lib/api";
import type { JsonType } from "./tool-arguments";

export const TOOL_REVIEW_INTRO =
  "Each tool an extension brings is blocked until you decide what it may do. Decide from the arguments it takes and what you know about the extension — never from what the tool says about itself.";

export const TOOL_REVIEW_OWNER_ONLY = "Only the owner can change how a tool is treated.";

export const ARGUMENTS_LABEL =
  "The arguments it takes, as Droplet reads them from its signed input schema: each one's name, type, and whether it must be given. Droplet checks that the running tool declares exactly that schema — not what it does with it. Everything else the schema says is in its author's words, below.";

export const NO_DECLARED_ARGUMENTS = "It declares no named arguments.";

/** Stands in for a property name that is not a plain identifier: a name can be a sentence too. */
export const ARGUMENT_NAME_WITHHELD = "(its name is not a plain identifier; see its author's schema)";

export function argumentFacts(types: readonly JsonType[], required: boolean): string {
  const type = types.length > 0 ? types.join(" or ") : "type not stated";
  return `${type} · ${required ? "required" : "optional"}`;
}

export const AUTHOR_WORDS_SUMMARY = "What its author says about it";

export const AUTHOR_WORDS_NOTE =
  "Its author wrote all of this: the description, and the full input schema with any notes inside it. Droplet checks only that the running tool declares exactly this, not that any of it is true, and decides nothing from it. The assistant is shown all of it when it is offered the tool, so a review covers it: if any of it changes, the tool is blocked again until an owner reviews it.";

/**
 * For a tool the orchestrator sends no schema for. That covers a newer
 * version not yet run AND a tool the current version dropped (nothing deletes
 * its row), so a review is promised only for the first.
 */
export const NO_ARGUMENTS_SHOWN =
  "Droplet can't show the arguments and description this tool was recorded with — the extension's current version declares different ones, or does not provide this tool — so it can't be reviewed here. If that version provides it, it can be reviewed once that version has run.";

export const NO_TOOLS_YET = "Its tools are listed here once it has run.";

export const TOOLS_UNREADABLE = "Could not read this extension's tools.";

export type ToolReviewKind = "read" | "block";

export function confirmSentence(kind: ToolReviewKind, tool: string, extensionId: string): string {
  return kind === "read"
    ? `Treat ${tool} as read-only? Your assistant will run it without asking you first. Decide from the arguments above and what you know about ${extensionId} — not from what the tool says about itself.`
    : `Block ${tool}? Every call your assistant makes to it is refused until an owner treats it as read-only.`;
}

export function savedSentence(kind: ToolReviewKind, tool: string): string {
  return kind === "read" ? `Saved. ${tool} is now read-only.` : `Saved. ${tool} is now blocked.`;
}

/** A refused review, said by code. Never the server's own text. */
export function explainToolReviewError(err: unknown, tool: string): string {
  if (err instanceof ExtensionRequestError) {
    if (err.status === 403) return TOOL_REVIEW_OWNER_ONLY;
    switch (err.code) {
      case "STALE_REVIEW":
        return `${tool}'s arguments or description changed since this page loaded, so nothing was saved. Look at it again.`;
      case "NOT_FOUND":
        return `This box has no record of ${tool} any more, so nothing was saved.`;
    }
  }
  return "Droplet could not save this review. What is shown is what the box has now.";
}
