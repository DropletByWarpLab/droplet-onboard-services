/**
 * WARP-2900 (ADR-056 slice H4) — the words on `/admin/extensions`.
 *
 * Kept in one place because two of them carry a security fact the owner acts
 * on: what promoting does, and that an extension's tools stay blocked for the
 * assistant until somebody reviews them (or until the confirm-before-change
 * step for runtime tools, WARP-2321, exists).
 *
 * EVERY SENTENCE HERE IS THE BOX'S (review #2326). A lifecycle failure
 * reason (`<code>: <detail>`), a promote's `installError` and a refused
 * request's message carry text this box did not write: the tail of the
 * extension's TypeScript build, tool names the extension's code chose, its
 * JSON-RPC error text. The page reads them by CODE only and says what the
 * code means, the way STATUS_BADGE names a status; an unknown code gets a
 * fixed sentence, never the text that came with it.
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

/**
 * What each lifecycle code means: the code of a `failureReason`
 * (`<code>: <detail>`), a promote's `installError.code`, or a refused
 * enable / disable / uninstall. Keyed by the orchestrator's codes
 * (extension-lifecycle.service.ts and the statement verifier).
 */
export const LIFECYCLE_COPY: Readonly<Record<string, string>> = {
  install_failed: "The sandbox could not build or start it, so nothing is running.",
  attach_refused: "It started, but its tools were not the ones that were signed, so this box stopped it.",
  attach_pending: "It is running, but its tools are not attached yet. This box keeps trying.",
  verify_failed: "Its signed code no longer checks out on this box, so it was not started.",
  statement_mismatch: "What this box stored for it does not match what was signed, so it was not started.",
  extension_key_changed:
    "This box's signing key changed since it was promoted, for example after a disk rebuild. Promote it again.",
  signature_failed: "Its signature does not check out on this box, so it was not started.",
  extension_digest_mismatch: "Its stored code is not the code that was signed, so it was not started.",
  extension_schema_invalid: "Its signed record is not one this box accepts, so it was not started.",
  extension_kind_missing: "Its signed record is not one this box accepts, so it was not started.",
  key_usage_mismatch: "Its signed record is not one this box accepts, so it was not started.",
  cosign_unavailable: "This box could not check its signature, so it was not started.",
  process_failed: "It kept stopping, so this box stopped restarting it.",
  process_exited: "It kept stopping, so this box stopped restarting it.",
  supervision_off: "Extensions are switched off on this box.",
  extensions_disabled: "Extensions are switched off on this box.",
  wrong_state: "It changed state while this was happening. The list shows where it is now.",
  not_promoted: "It has no signed version to start.",
  not_found: "This box has no extension by that name.",
  preflight_blocked: "Something on this box now blocks it, such as another extension using one of its tool names.",
  sandbox_error: "The sandbox did not answer. Try again.",
};

/** A failure whose code this page does not know. */
export const LIFECYCLE_FAILURE_DEFAULT = "It failed for a reason this page does not show.";

/** A refused request whose code this page does not know. */
export const EXTENSION_ERROR_DEFAULT = "That did not go through. Try again.";

/**
 * The code of a lifecycle failure reason: the lowercase identifier before
 * the first colon (or the whole reason, when it is only a code). Free text
 * has none.
 */
export function lifecycleFailureCode(reason: string | null | undefined): string | null {
  const m = /^([a-z][a-z0-9_]*)(?::|$)/.exec(reason ?? "");
  return m ? m[1] : null;
}

/** An extension's `failureReason`, in this box's words: by its code, never its detail. */
export function explainLifecycleFailure(reason: string | null | undefined): string {
  const code = lifecycleFailureCode(reason);
  return (code !== null && LIFECYCLE_COPY[code]) || LIFECYCLE_FAILURE_DEFAULT;
}

/** Why a proposal cannot be promoted, by the orchestrator's reason code (the text before any colon). */
const PROPOSAL_REASON_COPY: Readonly<Record<string, string>> = {
  "already promoted": "Already promoted: it is listed under Installed.",
  "not an extension (no manifest)": "Not an extension: this version has no manifest.",
  "manifest invalid": "Its manifest is not valid.",
};

export function explainProposalReason(reason: string | null | undefined): string {
  const code = (reason ?? "").split(":")[0].trim();
  return PROPOSAL_REASON_COPY[code] ?? "The sandbox could not read this proposal.";
}

/** A refused request, said by its code. Never the server's message: see the header. */
export function explainExtensionError(err: unknown): string {
  if (err instanceof ExtensionRequestError) {
    switch (err.code) {
      case "TOKEN_OPERATION_MISMATCH":
      case "manifest_changed":
        return "The proposal changed after you read it back, so nothing was signed. Review it again.";
      case "preflight_changed":
        return "This box changed after you read it back, so nothing was signed. Review it again.";
      case "TOKEN_EXPIRED":
      case "TOKEN_MISSING":
        return "This review expired or was already used, so nothing was signed. Review it again.";
      case "TOKEN_USER_MISMATCH":
        return "This review was started by someone else. Review it yourself.";
      case "device_identity_svc_unreachable":
        return "This box's signing service is not available, so nothing was signed.";
      case "already_promoted":
        return "This version is already promoted.";
      case "not_promotable":
      case "not_proposed":
        return "The workshop no longer proposes this version.";
      case "slug_taken":
        return "Another extension already runs under this name.";
      case "slug_reserved":
        return "This name is reserved on this box.";
      case "manifest_invalid":
        return "Its manifest is not valid, so nothing was signed.";
      case "invalid_domain":
        return "That area is not one this box knows.";
      default:
        return (err.code !== null && LIFECYCLE_COPY[err.code]) || EXTENSION_ERROR_DEFAULT;
    }
  }
  return EXTENSION_ERROR_DEFAULT;
}
