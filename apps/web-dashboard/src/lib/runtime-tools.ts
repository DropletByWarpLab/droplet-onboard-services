/**
 * WARP-2900 (ADR-056 slice H4) — how a runtime tool's dispatch verdict reads
 * on screen. Shared by the `/tools` Extensions section and the assistant
 * inspector, so the two never word the same verdict two ways.
 *
 * The verdict itself is the orchestrator's (its remote call policy, called);
 * this file only chooses words for the codes it sends. An unknown code reads
 * as refused — never as available.
 */
import type { BadgeKind } from "@/components/shell/primitives";
import type { RuntimeToolClassification } from "./types";

export interface ClassificationLabel {
  kind: BadgeKind;
  label: string;
  /** One sentence for a title attribute or a sub-line. */
  note: string;
}

export function classificationLabel(c: RuntimeToolClassification): ClassificationLabel {
  if (c.decision === "allow") {
    return {
      kind: "ok",
      label: "Reviewed read",
      note: "An owner reviewed it as read-only, so the assistant can use it.",
    };
  }
  switch (c.code) {
    case "REMOTE_WRITE_NOT_PERMITTED":
      return {
        kind: "warn",
        label: "Blocked until reviewed",
        note:
          "It starts as a change that asks first, and the assistant cannot yet ask before a tool it did not build makes a change. An owner can review it as read-only.",
      };
    case "REMOTE_TOOL_DENIED":
      return { kind: "danger", label: "Blocked by an owner", note: "An owner blocked it. Every call is refused." };
    case "REMOTE_TOOL_NOT_CLASSIFIED":
      return { kind: "muted", label: "Not classified", note: "Nobody has classified it yet. Every call is refused." };
    default:
      return { kind: "muted", label: "Refused", note: `Every call is refused (${c.code ?? "unknown"}).` };
  }
}

/** snake_case → "Snake case". */
export function humanizeToolName(name: string): string {
  const spaced = name.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
