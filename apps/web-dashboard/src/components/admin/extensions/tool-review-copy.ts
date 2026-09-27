/**
 * WARP-3205 — the words of the owner's tool review on `/admin/extensions`.
 *
 * Every sentence here is the box's. The only values interpolated are a tool
 * name (the manifest's TOOL_NAME_PATTERN: snake_case) and an extension id
 * (EXTENSION_SLUG_PATTERN); nothing the extension wrote as prose — its
 * description, a server message, an error it raised — is ever spliced into
 * one of them. A refusal this file does not know reads as a fixed sentence.
 */
import { ExtensionRequestError } from "@/lib/api";

export const TOOL_REVIEW_INTRO =
  "Each tool an extension brings is blocked until you decide what it may do. Decide from the arguments it takes and what you know about the extension — never from what the tool says about itself.";

export const TOOL_REVIEW_OWNER_ONLY = "Only the owner can change how a tool is treated.";

export const ARGUMENTS_LABEL =
  "The arguments it takes, as its signed manifest declares them. Droplet checks that the running tool takes exactly these — not what it does with them.";

export const AUTHOR_WORDS_SUMMARY = "What its author says it does";

export const AUTHOR_WORDS_NOTE =
  "Droplet does not check this and decides nothing from it. The assistant is shown these words when it is offered the tool, so a review covers them: if they change, the tool is blocked again until an owner reviews it.";

export const NO_ARGUMENTS_SHOWN =
  "Droplet can't show the arguments and description this tool was recorded with — the extension's current version declares different ones, or none — so it can't be reviewed here. It can be once that version has run.";

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
