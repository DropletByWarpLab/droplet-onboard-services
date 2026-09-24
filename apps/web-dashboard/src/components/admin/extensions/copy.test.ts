/**
 * WARP-2900 (ADR-056 slice H4), review #2326 — the owner's lifecycle surface
 * speaks only in words this box wrote.
 *
 * A failure reason, a promote's installError and a refused request carry
 * text the box did not write: the tail of the extension's TypeScript build,
 * tool names the extension's code chose, its JSON-RPC error text. Those are
 * read by CODE only and mapped to a fixed sentence, like STATUS_BADGE; the
 * default is a fixed sentence too, never `err.message` (MUTATION: fall
 * through to `err.message` → red).
 */
import { describe, it, expect } from "vitest";
import { ExtensionRequestError } from "@/lib/api";
import {
  LIFECYCLE_COPY,
  displayVersion,
  explainExtensionError,
  explainLifecycleFailure,
  explainProposalReason,
  lifecycleFailureCode,
} from "./copy";

const MARKER = "EXTENSION-WORDED-9d41";

describe("explainExtensionError", () => {
  const codes = [
    "install_failed",
    "attach_refused",
    "verify_failed",
    "wrong_state",
    "not_promoted",
    "statement_mismatch",
    "preflight_changed",
    "manifest_invalid",
    "sandbox_error",
    "some_code_this_page_has_never_seen",
    null,
  ];

  it.each(codes)("never repeats the server's message (code %s)", (code) => {
    const text = explainExtensionError(new ExtensionRequestError(`tsc: error TS2304 ${MARKER}`, 409, code));
    expect(text).not.toContain(MARKER);
    expect(text.length).toBeGreaterThan(0);
  });

  it("never repeats a plain error's message either", () => {
    expect(explainExtensionError(new Error(MARKER))).not.toContain(MARKER);
    expect(explainExtensionError(MARKER)).not.toContain(MARKER);
  });

  it.each(["install_failed", "attach_refused", "verify_failed", "wrong_state", "not_promoted", "statement_mismatch"])(
    "says what %s means, in its own sentence",
    (code) => {
      const text = explainExtensionError(new ExtensionRequestError(MARKER, 409, code));
      expect(text).toBe(LIFECYCLE_COPY[code]);
      expect(text).not.toBe(explainExtensionError(new ExtensionRequestError(MARKER, 409, "unknown_code")));
    },
  );
});

describe("a lifecycle failure reason is read by its code only", () => {
  it("takes the code before the first colon", () => {
    expect(lifecycleFailureCode(`install_failed: tsc exited 2: ${MARKER}`)).toBe("install_failed");
    expect(lifecycleFailureCode(`attach_refused: wc: word_count's description is not the signed one ${MARKER}`)).toBe(
      "attach_refused",
    );
    expect(lifecycleFailureCode("process_failed: exit code 1 after 5 restarts")).toBe("process_failed");
    expect(lifecycleFailureCode("statement_mismatch")).toBe("statement_mismatch");
  });

  it("has no code for free text, and none for nothing", () => {
    expect(lifecycleFailureCode(`did not answer its health check ${MARKER}`)).toBeNull();
    expect(lifecycleFailureCode(`Install Failed: ${MARKER}`)).toBeNull();
    expect(lifecycleFailureCode(null)).toBeNull();
    expect(lifecycleFailureCode(undefined)).toBeNull();
  });

  it("explains a known code, and anything else with a fixed sentence", () => {
    expect(explainLifecycleFailure(`install_failed: ${MARKER}`)).toBe(LIFECYCLE_COPY.install_failed);
    expect(explainLifecycleFailure(`statement_mismatch: the stored commit is not the signed commit`)).toBe(
      LIFECYCLE_COPY.statement_mismatch,
    );
    for (const reason of [`${MARKER}`, `not_a_known_code: ${MARKER}`, null]) {
      const text = explainLifecycleFailure(reason);
      expect(text).not.toContain(MARKER);
      expect(text.length).toBeGreaterThan(0);
    }
  });
});

describe("a proposal's reason is read by its code only", () => {
  it("maps the orchestrator's reasons and never repeats their detail", () => {
    expect(explainProposalReason("already promoted")).toMatch(/Already promoted/);
    expect(explainProposalReason("not an extension (no manifest)")).toMatch(/no manifest/);
    expect(explainProposalReason(`manifest invalid: provides.tools.0.name: ${MARKER}`)).not.toContain(MARKER);
    expect(explainProposalReason(`the sandbox said ${MARKER}`)).not.toContain(MARKER);
    expect(explainProposalReason(null)).toBeTruthy();
  });
});

describe("displayVersion", () => {
  it("shows major.minor.patch, and a pre-release only as the fact of one", () => {
    expect(displayVersion("0.1.0")).toBe("0.1.0");
    expect(displayVersion("1.2.3-reviewed-and-approved-by-warp-lab")).toBe("1.2.3 (pre-release)");
    expect(displayVersion(`not a version ${MARKER}`)).not.toContain(MARKER);
  });
});
