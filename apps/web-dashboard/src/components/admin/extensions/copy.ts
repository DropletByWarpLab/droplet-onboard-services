/**
 * WARP-2900 (ADR-056 slice H4) — the words on `/admin/extensions`.
 *
 * Kept in one place because two of them carry a security fact the owner acts
 * on: what promoting does, and that an extension's tools stay blocked for the
 * assistant until somebody reviews them (or until the confirm-before-change
 * step for runtime tools, WARP-2321, exists).
 */
import type { BadgeKind } from "@/components/shell/primitives";
import { ExtensionRequestError } from "@/lib/api";
import type { ExtensionStatus } from "@/lib/types";

export const EXTENSIONS_SUB =
  "Tools built in the workshop, promoted by an owner, and run by this box in its sandbox.";

export const WHAT_PROMOTING_DOES =
  "Promoting signs the exact code of a workshop proposal with this box's key, runs it in the sandbox with no internet, and adds its tools to the assistant.";

/** The WARP-2321 caveat, in the owner's terms. */
export const TOOLS_START_BLOCKED =
  "Its tools start blocked. The assistant can use one only after an owner reviews it as read-only, or once Droplet can ask you before each change an extension makes — that step is not built yet.";

export const OWNER_ONLY =
  "Only the owner of this box can promote, disable or uninstall an extension.";

export const STATUS_BADGE: Record<ExtensionStatus, { kind: BadgeKind; label: string }> = {
  live: { kind: "ok", label: "Running" },
  installed: { kind: "warn", label: "Installed, not attached" },
  signed: { kind: "muted", label: "Signed, not installed" },
  disabled: { kind: "muted", label: "Disabled" },
  failed: { kind: "danger", label: "Failed" },
  uninstalled: { kind: "muted", label: "Uninstalled" },
};

/** A refused request, said specifically when the code says what happened. */
export function explainExtensionError(err: unknown): string {
  if (err instanceof ExtensionRequestError) {
    switch (err.code) {
      case "TOKEN_OPERATION_MISMATCH":
      case "manifest_changed":
        return "The proposal changed after you read it back, so nothing was signed. Review it again.";
      case "preflight_changed":
        return `This box changed after you read it back, so nothing was signed: ${err.message}`;
      case "TOKEN_EXPIRED":
      case "TOKEN_MISSING":
        return "This review expired or was already used, so nothing was signed. Review it again.";
      case "TOKEN_USER_MISMATCH":
        return "This review was started by someone else. Review it yourself.";
      case "device_identity_svc_unreachable":
        return "This box's signing service is not available, so nothing was signed.";
      case "extensions_disabled":
        return "Extensions are switched off on this box.";
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}
