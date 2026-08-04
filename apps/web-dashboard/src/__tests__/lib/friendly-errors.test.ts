import { describe, it, expect } from "vitest";

import { translateError, type ErrorDomain } from "@/lib/friendly-errors";

/**
 * WARP-294 — Tests for the typed-error → friendly-copy translator.
 *
 * Per-domain code mappings are intentionally incremental: the test suite
 * pins a small known set (the ones we actively rely on at migrated
 * callsites) and exercises the universal contracts:
 *
 *   1. Each domain has a fixed-string fallback for unknown codes.
 *   2. `err.message` is NEVER returned verbatim — even if it looks
 *      friendly, the helper substitutes a fallback so future regressions
 *      can't leak internal strings.
 *   3. `null` / `undefined` / `{}` produce the same fallback as an
 *      unknown code.
 *
 * Defense in depth: a fictitious "SECRET_INTERNAL_DETAIL" message is
 * passed in for every domain and asserted to be absent from the result.
 */

const SECRET = "SECRET_INTERNAL_DETAIL_DO_NOT_LEAK";

const DOMAINS: ErrorDomain[] = [
  "auth",
  "files",
  "share",
  "share-bulk",
  "chat",
  "invite",
  "calendar",
  "subscription",
  "provider-key",
  "push",
  "knowledge",
  "media",
  "network",
  "vpn",
  "camera",
  "projects",
  "device",
  "generic",
];

describe("translateError — universal contracts", () => {
  it("returns a non-empty fallback for unknown errors in every domain", () => {
    for (const domain of DOMAINS) {
      const result = translateError({ code: "TOTALLY_UNKNOWN_CODE" }, domain);
      expect(result, `domain=${domain}`).toBeTypeOf("string");
      expect(result.length, `domain=${domain}`).toBeGreaterThan(0);
    }
  });

  it("never echoes err.message verbatim — even when it looks friendly", () => {
    for (const domain of DOMAINS) {
      const result = translateError({ message: SECRET }, domain);
      expect(result, `domain=${domain}`).not.toBe(SECRET);
      expect(result, `domain=${domain}`).not.toContain(SECRET);
    }
  });

  it("handles null / undefined / empty / non-object inputs with the domain fallback", () => {
    for (const domain of DOMAINS) {
      const fallback = translateError({ code: "TOTALLY_UNKNOWN_CODE" }, domain);
      expect(translateError(null, domain), `domain=${domain} null`).toBe(fallback);
      expect(translateError(undefined, domain), `domain=${domain} undefined`).toBe(fallback);
      expect(translateError({}, domain), `domain=${domain} empty`).toBe(fallback);
      expect(translateError("just a string", domain), `domain=${domain} string`).toBe(fallback);
      expect(translateError(42, domain), `domain=${domain} number`).toBe(fallback);
    }
  });

  it("accepts native Error instances and still returns a friendly fallback (never `err.message`)", () => {
    for (const domain of DOMAINS) {
      const e = new Error(SECRET);
      const result = translateError(e, domain);
      expect(result, `domain=${domain}`).not.toContain(SECRET);
    }
  });
});

describe("translateError — auth domain", () => {
  it("maps 401 / INVALID_CREDENTIALS to a friendly login-failed string", () => {
    const a = translateError({ status: 401 }, "auth");
    const b = translateError({ code: "INVALID_CREDENTIALS" }, "auth");
    expect(a.toLowerCase()).toMatch(/username|password|sign in|credential/);
    expect(b.toLowerCase()).toMatch(/username|password|sign in|credential/);
  });

  it("falls back to a friendly string for unknown auth errors (no orchestrator leakage)", () => {
    const result = translateError({ message: "OCS 401" }, "auth");
    expect(result).not.toContain("OCS");
    expect(result).not.toContain("401");
  });

  // The two-factor (TOTP) codes live in CODES.auth but had no coverage; the
  // generic auth fallback talks about username/password, which is wrong for
  // a 2FA flow, so these must map to their own dedicated strings.
  it("maps the two-factor enrollment codes to 2FA-specific copy", () => {
    const notEnrolled = translateError({ code: "TOTP_NOT_ENROLLED" }, "auth");
    const alreadyEnabled = translateError({ code: "TOTP_ALREADY_ENABLED" }, "auth");
    expect(notEnrolled.toLowerCase()).toContain("two-factor");
    expect(notEnrolled.toLowerCase()).not.toMatch(/username|password/);
    expect(alreadyEnabled.toLowerCase()).toContain("two-factor");
    expect(alreadyEnabled.toLowerCase()).not.toMatch(/username|password/);
  });

  // WARP-989 — a provisioning 500 from POST /auth/setup used to fall through
  // to the auth fallback ("check your username and password"), telling the
  // owner their brand-new credentials were wrong when the box simply failed
  // to finish creating the account (live .87 incident). The orchestrator now
  // types these; they must map to honest try-again copy, never the sign-in
  // fallback.
  it("maps the setup provisioning codes to honest 'couldn't finish creating your account' copy", () => {
    for (const code of ["SETUP_PROVISIONING_FAILED", "SETUP_FAILED"]) {
      const result = translateError({ code, status: 500 }, "auth");
      expect(result.toLowerCase(), code).toContain("creating your account");
      expect(result.toLowerCase(), code).toContain("try again");
      // Never the misleading sign-in copy — the credentials were fine.
      expect(result.toLowerCase(), code).not.toMatch(/username|password|sign you in/);
    }
  });

  it("keeps the raw orchestrator OCS message out of the setup-failure copy", () => {
    const result = translateError(
      {
        code: "SETUP_PROVISIONING_FAILED",
        status: 500,
        message: "OCS error creating user: Group household does not exist",
      },
      "auth",
    );
    expect(result).not.toContain("OCS");
    expect(result).not.toContain("Group household");
  });
});

describe("translateError — vpn domain", () => {
  // Parity gap fix (WARP-646 review): inferCodeFromMessage can infer TIMEOUT
  // for a VPN op (e.g. addWireguardDevice hitting a network timeout), but the
  // vpn domain previously had no TIMEOUT entry, so it silently fell through to
  // the domain fallback. Assert TIMEOUT now resolves to its own string.
  it("maps a TIMEOUT code (and an inferred timeout message) to the timeout string", () => {
    const fallback = translateError({ code: "TOTALLY_UNKNOWN_CODE" }, "vpn");
    const byCode = translateError({ code: "TIMEOUT" }, "vpn");
    const byMessage = translateError({ message: "connection timed out" }, "vpn");
    expect(byCode).not.toBe(fallback);
    expect(byCode.toLowerCase()).toContain("too long");
    // The message-inferred path lands on the same dedicated TIMEOUT copy,
    // not the generic vpn fallback.
    expect(byMessage).toBe(byCode);
  });
});

describe("translateError — chat domain", () => {
  it("maps an upload-too-large code to a size-aware friendly string", () => {
    const result = translateError({ code: "UPLOAD_TOO_LARGE" }, "chat");
    expect(result.toLowerCase()).toMatch(/large|size|smaller/);
  });

  it("falls back to a 'something went wrong' string for unknown chat errors", () => {
    const result = translateError({ code: "GIBBERISH" }, "chat");
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toMatch(/GIBBERISH/);
  });

  // WARP-305: brain-ingest reasons land on AttachmentChip's `error`
  // string in their raw lowercase form. They must NOT fall through to
  // the generic "Something went wrong on this turn" copy — that lies
  // to the user about a chat that's actually fine.
  it("maps `empty_extraction` (raw reason) to a friendly 'still attached, can't search' string", () => {
    const result = translateError({ message: "empty_extraction" }, "chat");
    expect(result).not.toMatch(/Something went wrong on this turn/i);
    expect(result.toLowerCase()).toMatch(/text|search|attached/);
  });

  it("maps `image_only` (raw reason) to an image-stored friendly string", () => {
    const result = translateError({ message: "image_only" }, "chat");
    expect(result).not.toMatch(/Something went wrong on this turn/i);
    expect(result.toLowerCase()).toMatch(/image|stored|attached/);
  });

  it("maps the IMAGE_ONLY code directly when it comes in as a typed error", () => {
    const result = translateError({ code: "IMAGE_ONLY" }, "chat");
    expect(result.toLowerCase()).toMatch(/image|stored/);
  });
});

describe("translateError — provider-key domain", () => {
  it("maps an INVALID_KEY code to a friendly string mentioning the key", () => {
    const result = translateError({ code: "INVALID_KEY" }, "provider-key");
    expect(result.toLowerCase()).toMatch(/key/);
  });

  it("falls back to a 'couldn't save' style string for unknowns", () => {
    const result = translateError({ message: "ECONNREFUSED" }, "provider-key");
    expect(result).not.toContain("ECONNREFUSED");
  });
});

describe("translateError — push domain", () => {
  it("maps a denied-permission code to a friendly string", () => {
    const result = translateError({ code: "PERMISSION_DENIED" }, "push");
    expect(result.toLowerCase()).toMatch(/notification|permission|blocked|denied/);
  });

  it("maps a 'not configured' phrase (substring) to a configured-off friendly string", () => {
    // Existing PushSubscriptionCard probes the orchestrator and falls
    // back on substring matching; the helper must accept the same input.
    const result = translateError({ message: "VAPID not configured" }, "push");
    expect(result).not.toContain("VAPID");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("translateError — media domain", () => {
  it("maps a fatal hls.js details enum to a friendly playback string", () => {
    // bufferStalledError is a real hls.js Hls.ErrorDetails value. The
    // user must never see the enum.
    const result = translateError({ code: "bufferStalledError" }, "media");
    expect(result).not.toContain("bufferStalled");
    expect(result.toLowerCase()).toMatch(/play|video|stream|recording/);
  });

  it("maps a manifest-load failure to a friendly playback string", () => {
    const result = translateError({ code: "manifestLoadError" }, "media");
    expect(result).not.toContain("manifestLoadError");
  });

  it("falls back to a generic playback string for unknown media codes", () => {
    const result = translateError({ code: "WHATEVER" }, "media");
    expect(result).not.toContain("WHATEVER");
  });
});

describe("translateError — calendar / subscription domains", () => {
  it("returns a friendly fallback for calendar errors", () => {
    const result = translateError({ message: "Failed to create reminder" }, "calendar");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns a friendly fallback for subscription errors", () => {
    const result = translateError({ message: "401 Unauthorized" }, "subscription");
    expect(result).not.toContain("401");
  });
});

describe("translateError — invite domain (parity with /invite/[token])", () => {
  it("maps USED / EXPIRED / INVALID_PASSWORD to friendly invite copy", () => {
    expect(translateError({ code: "USED" }, "invite").toLowerCase()).toMatch(/used|already/);
    expect(translateError({ code: "EXPIRED" }, "invite").toLowerCase()).toMatch(/expired|fresh/);
    expect(translateError({ code: "INVALID_PASSWORD" }, "invite").toLowerCase()).toMatch(/password/);
  });
});

// WARP-646 — domains added so the ~46 raw-`err.message` toasts across the
// dashboard (files, network, remote-access, device pairing, cameras, …)
// route through the translator instead of leaking orchestrator strings.
describe("translateError — network / vpn / camera / device domains (WARP-646)", () => {
  it("returns a friendly fallback for every new domain and never leaks the raw message", () => {
    const raw = "ECONNREFUSED 127.0.0.1:3000";
    for (const domain of ["network", "vpn", "camera", "device"] as ErrorDomain[]) {
      const result = translateError({ message: raw }, domain);
      expect(result.length, `domain=${domain}`).toBeGreaterThan(0);
      expect(result, `domain=${domain}`).not.toContain("ECONNREFUSED");
      expect(result, `domain=${domain}`).not.toContain("3000");
    }
  });

  it("maps a NETWORK substring to a connection-aware string per domain", () => {
    for (const domain of ["network", "vpn", "camera", "device"] as ErrorDomain[]) {
      const result = translateError({ message: "Failed to fetch" }, domain);
      expect(result.toLowerCase(), `domain=${domain}`).toMatch(
        /connection|reach|powered|connected|moment/,
      );
    }
  });

  it("camera AUTH_REQUIRED mentions credentials", () => {
    const result = translateError({ code: "AUTH_REQUIRED" }, "camera");
    expect(result.toLowerCase()).toMatch(/username|password|credential/);
  });

  // network was the odd domain out: inferCodeFromMessage returns "TIMEOUT"
  // for timeout-like messages, but the network CODES table only had
  // NETWORK / NOT_FOUND, so a network-op timeout silently fell through to
  // the domain fallback. The TIMEOUT entry restores parity with
  // device / chat / generic.
  it("maps a network-domain timeout message to the TIMEOUT copy, not the fallback", () => {
    const result = translateError({ message: "request timed out" }, "network");
    const fallback = translateError({ code: "TOTALLY_UNKNOWN_CODE" }, "network");
    expect(result.toLowerCase()).toMatch(/took too long/);
    expect(result).not.toBe(fallback);
  });
});

// WARP-1148/1149 — the Share dialog's failures used to translate through the
// "files" domain, so a failed share CREATE rendered the file-LOADING fallback
// ("We couldn't load those files right now…"). The dedicated share domain must
// (1) never produce the file-loading copy, (2) surface a module-gated 404
// (`module_disabled`) honestly, and (3) map Nextcloud's deterministic policy
// rejections (password / expiration / permissions) to actionable copy instead
// of "try again".
describe("translateError — share domain (WARP-1148/1149)", () => {
  const FILE_LOADING_COPY = translateError({ code: "TOTALLY_UNKNOWN_CODE" }, "files");

  it("never renders the file-loading copy for ANY share failure shape", () => {
    const shapes: unknown[] = [
      null,
      {},
      new Error("boom"),
      { code: "module_disabled", status: 404 },
      { status: 500, message: "Internal Server Error" },
      { message: "OCS share create: Password is under the minimum length (400)" },
    ];
    for (const err of shapes) {
      const result = translateError(err, "share");
      expect(result, JSON.stringify(err)).not.toBe(FILE_LOADING_COPY);
      expect(result.toLowerCase(), JSON.stringify(err)).not.toContain("load those files");
    }
  });

  it("falls back to share-specific 'couldn't create that share link' copy for unknown errors", () => {
    const result = translateError(new Error("boom"), "share");
    expect(result.toLowerCase()).toContain("share link");
    expect(result.toLowerCase()).toContain("try again");
  });

  it("surfaces a module-gated failure honestly (module_disabled → sharing is off, ask an admin)", () => {
    // The module gate answers 404 {"error":"module_disabled","module":"files"};
    // the api layer forwards the wire string as err.code. The copy must be
    // honest about the module being off — not a loading error, not a retry.
    const result = translateError({ code: "module_disabled", status: 404 }, "share");
    expect(result.toLowerCase()).toMatch(/turned off|isn't enabled|disabled/);
    expect(result.toLowerCase()).toMatch(/owner or admin/);
    expect(result.toLowerCase()).not.toContain("try again");
    expect(result).not.toContain("module_disabled");
  });

  it("maps the Nextcloud password-policy rejection to password copy (not the retry fallback)", () => {
    // Real OCS message shape from Nextcloud's password_policy app, surfaced by
    // the orchestrator as { error: "OCS share create: …" } with status 400.
    const result = translateError(
      {
        status: 400,
        message: "OCS share create: Password is present in compromised password list. (400)",
      },
      "share",
    );
    expect(result.toLowerCase()).toContain("password");
    expect(result).not.toContain("OCS");
    expect(result).not.toContain("compromised");
  });

  it("maps the expiration-policy rejection to expiration copy", () => {
    const result = translateError(
      {
        status: 400,
        message: "OCS share create: Cannot set expiration date more than 7 days in the future (400)",
      },
      "share",
    );
    expect(result.toLowerCase()).toContain("expiration");
    expect(result).not.toContain("OCS");
  });

  it("maps the file-share permission rejection to access-level copy", () => {
    // Nextcloud generalCreateChecks: a single-file share can't carry
    // CREATE/DELETE bits ("Full access" on a file).
    const result = translateError(
      {
        status: 400,
        message: "OCS share create: File shares cannot have create or delete permissions (400)",
      },
      "share",
    );
    expect(result.toLowerCase()).toContain("access level");
    expect(result).not.toContain("OCS");
  });

  it("maps a 404 without a stable code to gone-file/share copy", () => {
    const result = translateError(
      { status: 404, message: "OCS share create: Wrong path, file/folder does not exist (404)" },
      "share",
    );
    expect(result.toLowerCase()).toMatch(/find that file|moved or deleted/);
  });
});

// WARP-1659 — the same substring inference, one layer down. Nextcloud's
// share-create checks answer 400/403 with prose, so the `share` domain matches
// keywords to recover an actionable code. That is right for the ShareDialog,
// which HAS a password field and an expiry picker. It is wrong for the
// multi-select fan-out, which hardcodes `{ shareType: 3, permissions: 1 }` and
// renders neither control: on a box with enforce-password-on-public-links
// turned on, every row would tell the user their password doesn't meet the
// rules — for a password they were never asked for and cannot supply, pointing
// them away from the real cause (an instance policy only an admin can change).
//
// The bulk path gets its own domain. It is the `share` domain in every respect
// except the two inferences that name a control it does not render; those keep
// their inferred codes but answer with copy that is true of THIS flow and
// names the remedy that exists — share the file on its own, where the controls
// are.
describe("translateError — share-bulk domain (WARP-1659)", () => {
  const PASSWORD_ENFORCED = {
    status: 403,
    message: "OCS share create: Passwords are enforced for link shares (403)",
  };
  const EXPIRY_ENFORCED = {
    status: 400,
    message: "OCS share create: Cannot set expiration date more than 7 days in the future (400)",
  };

  it("never claims the user's password was rejected in a flow with no password field", () => {
    const result = translateError(PASSWORD_ENFORCED, "share-bulk");
    // The exact ShareDialog sentence must not appear here.
    expect(result).not.toBe(translateError(PASSWORD_ENFORCED, "share"));
    expect(result.toLowerCase()).not.toMatch(
      /that password|your password|doesn't meet|longer, less common/,
    );
    expect(result).not.toContain("OCS");
  });

  it("says why the bulk run can't satisfy the password rule, and where the control is", () => {
    const result = translateError(PASSWORD_ENFORCED, "share-bulk").toLowerCase();
    // Not the retry fallback: the rejection is deterministic, so "try again in
    // a moment" is the WARP-1148 defect wearing a different hat.
    expect(result).not.toContain("try again");
    expect(result).toContain("password");
    // The remedy that actually exists without an admin: the single-file dialog.
    expect(result).toMatch(/on its own|one at a time/);
  });

  it("applies the same treatment to the expiry rule", () => {
    const result = translateError(EXPIRY_ENFORCED, "share-bulk");
    expect(result).not.toBe(translateError(EXPIRY_ENFORCED, "share"));
    expect(result.toLowerCase()).not.toMatch(/that expiration date|pick a different date/);
    expect(result.toLowerCase()).toMatch(/on its own|one at a time/);
  });

  it("keeps every other share code identical to the share domain", () => {
    // The two overrides are the whole difference. A bulk row failing for a
    // reason the fan-out CAN be responsible for must read exactly as it does
    // in the dialog — divergence here is how "same 403, two messages one click
    // apart" (WARP-1148) came back.
    const shared: unknown[] = [
      { code: "module_disabled", status: 404 },
      { status: 404, message: "OCS share create: Wrong path, file/folder does not exist (404)" },
      {
        status: 400,
        message: "OCS share create: File shares cannot have create or delete permissions (400)",
      },
      { message: "Failed to fetch" },
      { message: "The operation timed out" },
      new Error("boom"),
    ];
    for (const err of shared) {
      expect(translateError(err, "share-bulk"), JSON.stringify(err)).toBe(
        translateError(err, "share"),
      );
    }
  });

  it("never renders the file-loading copy either", () => {
    const fileLoading = translateError({ code: "TOTALLY_UNKNOWN_CODE" }, "files");
    for (const err of [null, {}, PASSWORD_ENFORCED, EXPIRY_ENFORCED, new Error("boom")]) {
      expect(translateError(err, "share-bulk"), JSON.stringify(err)).not.toBe(fileLoading);
    }
  });

  // WARP-1659 × WARP-1658. WARP-1658 gave `share` a 403 entry; `share-bulk`
  // needs the same one, because POST /files/share is role-gated and
  // `shareBlockedReason` gates on space posture rather than role — a
  // member/guest reaches the fan-out and every row 403s. Without it those rows
  // get FALLBACK["share-bulk"] ("try again in a moment") — the WARP-1658 defect
  // relocated one surface over rather than fixed.
  it("answers a role-denial 403 the way the dialog does, not with the retry fallback", () => {
    const BULK_FALLBACK = translateError({ code: "TOTALLY_UNKNOWN_CODE" }, "share-bulk");
    const DENIALS: unknown[] = [
      { status: 403 },
      {
        status: 403,
        code: "Forbidden: role not permitted",
        message: "Forbidden: role not permitted",
      },
    ];
    for (const err of DENIALS) {
      const result = translateError(err, "share-bulk");
      expect(result, JSON.stringify(err)).not.toBe(BULK_FALLBACK);
      expect(result.toLowerCase(), JSON.stringify(err)).not.toContain("try again");
      expect(result.toLowerCase(), JSON.stringify(err)).not.toContain("in a moment");
      // A reason the fan-out is not responsible for must read exactly as it
      // does in the dialog — "same 403, two messages one click apart" is the
      // WARP-1148 defect this whole domain exists to prevent.
      expect(result, JSON.stringify(err)).toBe(translateError(err, "share"));
    }
  });

  // The carve-out that makes the two tickets coexist: `share-bulk` infers from
  // the message BEFORE it dispatches on status. Nextcloud answers a passwordless
  // link create on an enforce-password box with OCSForbidden — a 403 carrying
  // password prose — so without this the 403 entry above would shadow
  // PASSWORD_REJECTED and every row would read "you don't have permission",
  // which is false and hides the only remedy the user has.
  it("still reaches the bulk password copy when the 403 carries password prose", () => {
    const result = translateError(PASSWORD_ENFORCED, "share-bulk").toLowerCase();
    expect(result).not.toBe(translateError({ status: 403 }, "share-bulk").toLowerCase());
    expect(result).toContain("password");
    expect(result).toMatch(/on its own|one at a time/);
  });

  it("never leaks the raw wire error string on a 403", () => {
    const result = translateError(
      { status: 403, code: "Forbidden: role not permitted", message: SECRET },
      "share-bulk",
    );
    expect(result).not.toContain(SECRET);
    expect(result).not.toContain("Forbidden");
  });
});

// WARP-1658 — a share 403 had no entry in CODES.share, so it fell all the way
// through to FALLBACK.share ("…Try again in a moment."). Every 403 the
// orchestrator can answer a share write with is a DETERMINISTIC policy
// rejection — role denial (requireRole), guest read-only, or insufficient
// space rights (requireSpaceAccess) — so retrying can never succeed. The copy
// must name the blocker and who can lift it, and must not offer a retry.
describe("translateError — share 403 (WARP-1658)", () => {
  const SHARE_FALLBACK = translateError({ code: "TOTALLY_UNKNOWN_CODE" }, "share");

  // The shapes ShareRequestError actually produces for the three 403 flavours:
  // `code` carries the wire `error` string (no stable code exists for these —
  // see the scope note in friendly-errors.ts), `status` carries the 403.
  const FORBIDDEN_SHAPES: unknown[] = [
    { status: 403 },
    {
      status: 403,
      code: "Forbidden: role not permitted",
      message: "Forbidden: role not permitted",
    },
    {
      status: 403,
      code: "Forbidden: manager right required for this space",
      message: "Forbidden: manager right required for this space",
    },
  ];

  it("does not fall through to the retry fallback", () => {
    for (const err of FORBIDDEN_SHAPES) {
      const result = translateError(err, "share");
      expect(result, JSON.stringify(err)).not.toBe(SHARE_FALLBACK);
    }
  });

  it("never tells the user to try again — the rejection is deterministic", () => {
    for (const err of FORBIDDEN_SHAPES) {
      const result = translateError(err, "share").toLowerCase();
      expect(result, JSON.stringify(err)).not.toContain("try again");
      expect(result, JSON.stringify(err)).not.toContain("in a moment");
    }
  });

  it("names the permission problem and who can lift it", () => {
    const result = translateError({ status: 403 }, "share").toLowerCase();
    expect(result).toContain("permission");
    expect(result).toMatch(/owner or an admin|owner or admin/);
  });

  it("covers the stale-rights case a client-side gate cannot pre-empt", () => {
    // No client-side share gate exists on main (files/page.tsx gates the Share
    // item on `!isSingle` only), so plain role denials land here too. But the
    // case a gate can never pre-empt is client state disagreeing with server
    // rights — stale ACL cache, rights revoked mid-session — and a fresh
    // session fixes it. Mirror the storage["403"] precedent and say so.
    const result = translateError({ status: 403 }, "share").toLowerCase();
    expect(result).toMatch(/sign out/);
  });

  it("never leaks the raw wire error string", () => {
    const result = translateError(
      { status: 403, code: "Forbidden: role not permitted", message: SECRET },
      "share",
    );
    expect(result).not.toContain(SECRET);
    expect(result).not.toContain("Forbidden");
  });
});

describe("translateError — auth domain two-factor codes (WARP-646)", () => {
  it("maps TOTP_INVALID to a code-mismatch string, not a username/password one", () => {
    const result = translateError({ code: "TOTP_INVALID" }, "auth");
    expect(result.toLowerCase()).toMatch(/code|authenticator/);
  });

  it("maps RECOVERY_INVALID to a recovery-code string", () => {
    const result = translateError({ code: "RECOVERY_INVALID" }, "auth");
    expect(result.toLowerCase()).toMatch(/recovery|code/);
  });
});

describe("translateError — projects domain (WARP-1154/1155)", () => {
  // The live bug: the orchestrator's module gate answered
  // { error: "module_disabled" } and the raw snake_case code reached a toast
  // verbatim. The projects domain must translate it to honest, permanent
  // "not enabled" copy — never "server error, try again".
  // WARP-1528: `module_disabled` is now emitted by the per-person feature gate
  // too (identical body by design — a denial must not reveal what other people
  // can reach). The copy therefore must NOT name the workspace as the reason.
  it("maps module_disabled to honest, REASON-FREE 'not available' copy", () => {
    const result = translateError(
      { code: "module_disabled", status: 404, message: "module_disabled" },
      "projects",
    );
    expect(result).toContain("Projects isn't available");
    // It must not assert the box-wide reason it can no longer know.
    expect(result).not.toContain("isn't enabled on this Droplet");
    // Both possibilities are named, plus the way out.
    expect(result.toLowerCase()).toMatch(/switched off/);
    expect(result.toLowerCase()).toMatch(/part of your access/);
    expect(result.toLowerCase()).toMatch(/owner or admin/);
    expect(result).not.toContain("module_disabled");
    expect(result.toLowerCase()).not.toMatch(/try again|server error/);
  });

  it("maps the PM wire codes the dashboard flows can hit", () => {
    expect(
      translateError({ code: "project_not_found" }, "projects").toLowerCase(),
    ).toContain("couldn't find that project");
    expect(
      translateError({ code: "work_item_not_found" }, "projects").toLowerCase(),
    ).toContain("couldn't find that item");
    expect(
      translateError({ code: "identifier_taken" }, "projects").toLowerCase(),
    ).toContain("already in use");
    expect(
      translateError({ code: "invalid_state" }, "projects").toLowerCase(),
    ).toContain("refresh");
  });

  // Home-user persona (ADR-002): snake_case internals must never render.
  // An UNKNOWN code — one added to the orchestrator after this dashboard
  // build shipped — must land on the domain fallback, and neither the code
  // nor any snake_case may survive into the copy.
  it("unknown snake_case codes NEVER render snake_case to users", () => {
    for (const code of ["flux_capacitor_offline", "state_is_last", "comment_not_found"]) {
      const result = translateError({ code, message: code, status: 409 }, "projects");
      expect(result, code).not.toContain(code);
      expect(result, code).not.toMatch(/[a-z]+_[a-z]+/);
      expect(result.length, code).toBeGreaterThan(0);
    }
  });
});
