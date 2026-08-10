/**
 * WARP-882 / WARP-1686 — in-browser viewing/editing document-server client.
 *
 * The Droplet integrates a WOPI document engine via a Nextcloud connector app.
 * WHICH engine is a CONFIG choice (DOCS_ENGINE, ADR-034), not a code
 * dependency — this module is the orchestrator's thin, ENGINE-AWARE seam:
 *
 *   - It NEVER speaks the raw WOPI/Document-Server wire protocol. That
 *     handshake (file fetch + save callback + token verification) is owned by
 *     the Nextcloud connector and the engine itself. Keeping the engine behind
 *     WOPI means swapping it changes DOCS_* config + the two engine-keyed
 *     branches below (health path + connector page), nothing else.
 *   - `ncMintEditorSession` resolves the Nextcloud numeric fileId for the path
 *     (via `ncGetFileId(token, ncUser, path)` — 3 args) and returns the editor
 *     URL the dashboard iframe loads, plus a short-lived signed access token
 *     the editor presents back on its WOPI calls.
 *   - `docServerHealthy` is a bounded reachability probe used by the
 *     `/files/docs/status` route.
 *
 * ENGINES (DOCS_ENGINE):
 *   - "collabora" (default) — Collabora CODE (LibreOffice technology; MPLv2
 *     core, free-of-charge binaries — NO licensing fee, which is why ADR-034
 *     made it the default). Connector app: `richdocuments`. Readiness =
 *     GET {DOCS_INTERNAL_URL}/hosting/discovery returning the WOPI discovery
 *     XML (coolwsd has no /healthcheck).
 *   - "onlyoffice" — OnlyOffice Document Server CE (AGPLv3; an OnlyOffice
 *     OEM/commercial license is required to SHIP this engine — kept selectable
 *     for a future OEM-licensed SKU). Connector app: `onlyoffice`. Readiness =
 *     GET {DOCS_INTERNAL_URL}/healthcheck returning the literal `true`.
 */
import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import {
  ncGetFileId,
  ncCreateRichdocumentsDirectUrl,
} from "./nextcloud.client.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("docserver-client");

/**
 * WARP-1688 — the ONLY path shape accepted from a richdocuments direct-editing
 * mint. Matches both the default (`/index.php/apps/richdocuments/direct/…`) and
 * the pretty-URL (`/apps/richdocuments/direct/…`) forms.
 */
const RICHDOCUMENTS_DIRECT_PATH = "/apps/richdocuments/direct/";

/**
 * WARP-1688 — re-base a richdocuments direct-editing URL onto the gateway's
 * browser-facing Nextcloud path.
 *
 * richdocuments returns the URL ABSOLUTE against Nextcloud's own configured
 * origin (observed on the box: `http://localhost/index.php/apps/richdocuments/
 * direct/<token>`), which is a compose-internal address no browser can resolve
 * — the exact WARP-882 class of bug WARP-1686 fixed for the connector URL. So
 * only the PATH (+ query/fragment) survives, re-prefixed with
 * NEXTCLOUD_PUBLIC_PATH. Staying path-relative keeps the editor same-origin
 * with whatever hostname the user browsed in on (FQDN, .local, .lan).
 *
 * The result is fed straight into the dashboard's iframe `src`, so the shape is
 * VERIFIED rather than trusted: anything that is not a richdocuments
 * direct-view path returns null and the caller keeps the known-good connector
 * URL. An off-origin absolute URL likewise cannot survive, since only the path
 * is carried over — and a path that does not match the direct-view prefix is
 * refused outright.
 *
 * The check is on `pathname` ALONE, deliberately. Testing the concatenated
 * path+query+fragment would only require the literal to appear SOMEWHERE, so
 * `/index.php/settings/admin?next=/apps/richdocuments/direct/` and
 * `/index.php/login#/apps/richdocuments/direct/` would both pass and land in
 * the iframe — the exact opposite of "refused outright". The query and fragment
 * are still carried into the RETURNED value (richdocuments' route is
 * `directView#show`, so the fragment is load-bearing); they just get no say in
 * whether the URL is accepted.
 */
function rebaseDirectEditorUrl(
  mintedUrl: string,
  ncPublicBase: string,
): string | null {
  let parsed: URL;
  try {
    // The base is a throwaway: it only lets a path-relative mint parse. Any
    // absolute input keeps its OWN path, and its origin is discarded below.
    parsed = new URL(mintedUrl, "http://nextcloud.invalid");
  } catch {
    return null;
  }
  // Decide on the PATH only…
  if (!parsed.pathname.startsWith("/")) return null;
  if (!parsed.pathname.includes(RICHDOCUMENTS_DIRECT_PATH)) return null;
  // …then carry the query + fragment through untouched.
  return `${ncPublicBase}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * WARP-1688 — the path words a minted URL may reveal in a log line.
 *
 * Fixed Nextcloud routing literals only. A direct-editing token can never BE
 * one of these, which is what makes the redaction below safe by construction
 * rather than by pattern-matching what a token "looks like".
 */
const LOGGABLE_PATH_SEGMENTS = new Set([
  "index.php",
  "apps",
  "richdocuments",
  "theming",
  "direct",
  "directedit",
  "core",
  "dist",
  "ocs",
  "v2.php",
  "v1",
  "document",
]);

/**
 * WARP-1688 — describe a minted direct-editing URL for a LOG line without
 * revealing it.
 *
 * The direct-editing URL is BEARER-EQUIVALENT for its lifetime: whoever holds
 * it can open that file with no cookie and no Authorization header
 * (docs/THREAT_MODEL.md T1.8, accepted risk R6 — "must never be logged,
 * screenshotted into a ticket, or pasted into chat"). Logging it at warn level
 * would put a working credential into the orchestrator's log.
 *
 * Today the only call site fires when the shape check REFUSED the URL, so a
 * live token would not reach it — but that is INCIDENTAL. If richdocuments
 * changes its path layout in a future Nextcloud major, EVERY mint fails the
 * check and that same line starts emitting live tokens. So the redaction is
 * unconditional and structural: each path segment survives only if it is a
 * known Nextcloud routing literal, and everything else becomes `*`.
 *
 * The result is still diagnosable — an engineer sees WHICH shape was refused
 * (`/index.php/apps/richdocuments/*`) plus the length, which is what the
 * "richdocuments changed its route" investigation actually needs.
 */
function describeMintedUrl(mintedUrl: string | null): string {
  if (mintedUrl === null) return "none";
  let shape: string;
  try {
    const parsed = new URL(mintedUrl, "http://nextcloud.invalid");
    shape = parsed.pathname
      .split("/")
      .map((segment) =>
        segment === "" || LOGGABLE_PATH_SEGMENTS.has(segment) ? segment : "*",
      )
      .join("/");
  } catch {
    return `<unparseable ${mintedUrl.length} chars>`;
  }
  // The query string and fragment are dropped WHOLESALE — richdocuments carries
  // a requesttoken there, and there is no diagnostic value worth the risk.
  return `${shape} (${mintedUrl.length} chars)`;
}

/** Editor mode decided SERVER-SIDE by the route layer; never trusted from the client. */
export type DocEditorMode = "edit" | "view";

export interface DocEditorSession {
  /** Absolute-or-relative URL the dashboard iframe loads to open the editor. */
  editorUrl: string;
  /** Short-lived signed token the editor presents on its WOPI/handshake calls. */
  accessToken: string;
  /** TTL of `accessToken` in seconds — the frontend refreshes before expiry. */
  accessTokenTtl: number;
  /** Nextcloud numeric fileId the session is bound to. */
  ncFileId: number;
  /** Resolved server-side mode (edit | view). */
  mode: DocEditorMode;
  /** Opaque co-authoring document key (namespaces the shared session). */
  documentKey: string;
}

/**
 * Thrown when the document server is DISABLED (DOCS_ENABLED=false) or
 * UNREACHABLE (empty DOCS_INTERNAL_URL / connection failure / non-2xx health).
 * The route layer maps this to HTTP 503 — distinct from a missing-file 404 or a
 * missing-NC-token 401, so the dashboard renders an honest "editing unavailable"
 * state rather than a generic error.
 */
export class DocServerUnavailableError extends Error {
  readonly code = "DOCS_UNAVAILABLE" as const;
  readonly status = 503 as const;

  constructor(message = "Document server is unavailable") {
    super(message);
    this.name = "DocServerUnavailableError";
  }

  toJSON(): { code: "DOCS_UNAVAILABLE"; message: string; status: 503 } {
    return { code: this.code, message: this.message, status: this.status };
  }
}

/**
 * True when the engine is enabled via the explicit DOCS_ENABLED flag.
 *
 * State is EXPLICIT (CLAUDE.md): the URL-presence guard lives in
 * docServerHealthy() and the JWT-secret fail-safe lives in ncMintEditorSession()
 * (empty ONLYOFFICE_JWT_SECRET → DocServerUnavailableError, so no document-access
 * JWT is ever signed with a forgeable empty/default key). DOCS_ENABLED itself is
 * DEFAULT-ON on ≥32 GB boxes (config default "1"; scripts/lib/single-box.sh
 * overrides to "0" for ≤8 GB). The operator must add `docs` to COMPOSE_PROFILES.
 */
function docsConfigured(): boolean {
  return config.DOCS_ENABLED === true;
}

/**
 * Bounded reachability probe against the internal document-server URL. Returns
 * `false` (never throws) on any failure so `/files/docs/status` can render a
 * calm "unavailable" state instead of 500-ing. The readiness endpoint is
 * ENGINE-SPECIFIC (see the module header): Collabora's coolwsd serves the WOPI
 * discovery XML at /hosting/discovery; OnlyOffice serves the literal `true` at
 * /healthcheck.
 */
export async function docServerHealthy(): Promise<boolean> {
  if (!docsConfigured()) return false;
  if (!config.DOCS_INTERNAL_URL.trim()) return false;
  if (!config.ONLYOFFICE_JWT_SECRET.trim()) return false;
  const base = config.DOCS_INTERNAL_URL.replace(/\/$/, "");
  const collabora = config.DOCS_ENGINE !== "onlyoffice";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const url = collabora ? `${base}/hosting/discovery` : `${base}/healthcheck`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return false;
    const body = (await res.text()).trim();
    if (collabora) {
      // coolwsd's discovery document — root element `wopi-discovery`. Any 200
      // that carries it means the engine parsed its config and is serving.
      return body.includes("wopi-discovery");
    }
    // OnlyOffice returns the literal `true`; tolerate a JSON-wrapped boolean.
    const lower = body.toLowerCase();
    if (lower === "true") return true;
    try { return JSON.parse(lower) === true; } catch { return false; }
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Mint an editor session for `filePath` acting as `ncUser`.
 *
 * Flow:
 *   1. Refuse early if the engine is disabled/unconfigured (→ 503).
 *   2. Probe the engine; an unreachable engine is a 503, not a generic 500.
 *   3. Resolve the Nextcloud fileId (3-arg `ncGetFileId`). A null id means the
 *      file doesn't exist — surfaced as a plain Error (→ 404 at the route),
 *      explicitly NOT a DocServerUnavailableError.
 *   4. Build the connector editor URL + sign a short-lived access token bound to
 *      {ncFileId, ncUser, mode}. The token is HS256-signed with the shared
 *      ONLYOFFICE_JWT_SECRET (generated unconditionally per-device by
 *      scripts/lib/secrets.sh, so it is present under BOTH engines).
 *
 * The editor URL targets the Nextcloud CONNECTOR PAGE for the configured
 * engine, addressed via the gateway's browser-facing /nextcloud/ leg
 * (NEXTCLOUD_PUBLIC_PATH) — NOT the compose-internal NEXTCLOUD_URL, which a
 * browser can never resolve (the WARP-882 editorUrl host bug WARP-1686 fixes):
 *   - collabora  → {NEXTCLOUD_PUBLIC_PATH}/index.php/apps/richdocuments/index?fileId={id}
 *   - onlyoffice → {NEXTCLOUD_PUBLIC_PATH}/index.php/apps/onlyoffice/{id}?mode={mode}
 *
 * `requestedMode` is the ALREADY-server-decided mode passed by the route; this
 * function does not itself authorize edit-vs-view (the route owns that, via the
 * NC share-permission check). It is recorded into the session + token so the
 * editor opens in the correct mode.
 */
export async function ncMintEditorSession(
  token: string,
  ncUser: string,
  filePath: string,
  requestedMode: DocEditorMode,
): Promise<DocEditorSession> {
  if (!docsConfigured()) {
    throw new DocServerUnavailableError("Document editing is disabled on this appliance");
  }

  if (!config.ONLYOFFICE_JWT_SECRET.trim()) {
    throw new DocServerUnavailableError(
      "ONLYOFFICE_JWT_SECRET is not configured — document editing is unavailable",
    );
  }

  const healthy = await docServerHealthy();
  if (!healthy) {
    throw new DocServerUnavailableError("Document server is not reachable");
  }

  const ncFileId = await ncGetFileId(token, ncUser, filePath);
  if (ncFileId === null) {
    // NOT a DocServerUnavailableError — the engine is fine, the file isn't there.
    throw new Error(`File not found: ${filePath}`);
  }

  const ttl = config.DOCS_ACCESS_TOKEN_TTL_SECONDS;

  // Browser-facing Nextcloud base (gateway `location /nextcloud/`). Kept
  // path-relative by default so the editor stays same-origin with whatever
  // hostname the user browsed in on (FQDN, droplet-ai.local, .lan).
  const ncPublicBase = config.NEXTCLOUD_PUBLIC_PATH.replace(/\/$/, "");
  const connectorUrl =
    config.DOCS_ENGINE === "onlyoffice"
      ? `${ncPublicBase}/index.php/apps/onlyoffice/${ncFileId}?mode=${requestedMode}`
      : `${ncPublicBase}/index.php/apps/richdocuments/index?fileId=${ncFileId}`;

  // WARP-1688 — SESSION-FREE embed, COLLABORA ONLY.
  //
  // The connector page above is session-bound: it needs a Nextcloud session
  // cookie. The dashboard iframes it from the DASHBOARD's origin, where the
  // browser has no such cookie, so the embed renders Nextcloud's LOGIN page
  // instead of the document. richdocuments ships the way out — an OCS
  // direct-editing token whose `/direct/{token}` page renders with no cookies
  // and no auth at all (verified on the box: 200, the real editor, no login
  // bounce). We mint one AS THE USER and iframe that instead.
  //
  // The OnlyOffice connector has NO equivalent direct-editing API, so its leg
  // is deliberately left EXACTLY as WARP-882/WARP-1686 built it. There is no
  // honest way to give that engine the same session-free embed here; faking
  // one would only move the failure. DOCS_ENGINE=onlyoffice therefore keeps
  // the session-bound connector page — a known, documented limitation rather
  // than a silent difference.
  //
  // Every failure DEGRADES to the connector URL: a session-bound editor still
  // works for a user who happens to hold a Nextcloud cookie, and it is always
  // better than a 500 on a file the user asked to open.
  let editorUrl = connectorUrl;
  if (config.DOCS_ENGINE !== "onlyoffice") {
    try {
      const minted = await ncCreateRichdocumentsDirectUrl(token, ncFileId);
      const rebased = minted ? rebaseDirectEditorUrl(minted, ncPublicBase) : null;
      if (rebased) {
        editorUrl = rebased;
      } else {
        // `mintedShape` is REDACTED, not the URL — see describeMintedUrl().
        logger.warn(
          { ncFileId, ncUser, mintedShape: describeMintedUrl(minted) },
          "richdocuments direct-editing URL unusable — falling back to the session-bound connector page",
        );
      }
    } catch (err) {
      logger.warn(
        { err, ncFileId, ncUser },
        "richdocuments direct-editing mint threw — falling back to the session-bound connector page",
      );
    }
  }

  // `documentKey` namespaces the co-authoring session in the engine: the engine
  // treats two opens with the SAME documentKey as ONE shared live document
  // (real-time co-authoring) and two opens with DIFFERENT keys as separate
  // documents. Co-authoring is the whole point of WS-4, so the key MUST be
  // identical for every user opening the same file — it is therefore derived
  // from the stable per-file identity (ncFileId) ONLY, NEVER from ncUser. A
  // per-user key (the prior `${ncFileId}:${ncUser}:${filePath}` hash) silently
  // forked every user into their own session, so two people editing one file
  // never saw each other's changes. The FileEditSession row is likewise keyed on
  // ncFileId (one shared session per file), so the two now agree.
  //
  // ncFileId (not filePath) is the identity: a rename/move changes the path but
  // not the fileId, so an in-progress shared session survives a move instead of
  // splitting. The mode/user authorization still rides the JWT claims below
  // (and is decided server-side), so dropping them from the key does not weaken
  // access control — the editorUrl + token are still bound to {ncFileId, mode}.
  const documentKey = createHash("sha256")
    .update(`${ncFileId}`)
    .digest("hex")
    .slice(0, 20);

  const accessToken = jwt.sign(
    {
      ncFileId,
      ncUser,
      mode: requestedMode,
      documentKey,
      path: filePath,
    },
    config.ONLYOFFICE_JWT_SECRET,
    { algorithm: "HS256", expiresIn: ttl },
  );

  logger.debug({ ncFileId, ncUser, mode: requestedMode }, "minted doc editor session");

  return {
    editorUrl,
    accessToken,
    accessTokenTtl: ttl,
    ncFileId,
    mode: requestedMode,
    documentKey,
  };
}
