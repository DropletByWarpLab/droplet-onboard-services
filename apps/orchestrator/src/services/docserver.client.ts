/**
 * WARP-882 / WS-4 — In-browser editing + co-authoring document-server client.
 *
 * The Droplet integrates an OnlyOffice Document Server (the configured ENGINE)
 * via the Nextcloud `onlyoffice` connector app over a WOPI-style handshake.
 * This module is the orchestrator's thin, ENGINE-AGNOSTIC seam:
 *
 *   - It NEVER speaks the raw WOPI/Document-Server wire protocol. That handshake
 *     (file fetch + save callback + JWT verification) is owned by the Nextcloud
 *     connector and the Document Server itself. Keeping the engine behind WOPI
 *     means the engine is a CONFIG choice (DOCS_INTERNAL_URL + the connector's
 *     DocumentServerUrl), not a code dependency — swapping the Document Server
 *     for any other WOPI-capable engine needs no change here.
 *   - `ncMintEditorSession` resolves the Nextcloud numeric fileId for the path
 *     (via `ncGetFileId(token, ncUser, path)` — 3 args) and returns the editor
 *     URL the dashboard iframe loads, plus a short-lived signed access token the
 *     editor presents back on its WOPI calls.
 *   - `docServerHealthy` is a bounded reachability probe used by the
 *     `/files/docs/status` route.
 *
 * LICENSING NOTE (CE → OEM): we build and test against OnlyOffice Document
 * Server **Community Edition**, which is AGPLv3. Shipping the doc-server engine
 * in the product at GA requires an OnlyOffice OEM/commercial license. There is
 * deliberately NO license-enforcement code here — the engine choice stays
 * config-driven so the commercial swap is an ops/packaging decision, not a code
 * change. See docs/ADR-021 (`docs` profile section) and docs/ENVIRONMENT.md.
 */
import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import pino from "pino";
import { config } from "../config.js";
import { ncGetFileId } from "./nextcloud.client.js";

const logger = pino({ name: "docserver-client" });

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
 * OPT-IN / DEFAULT-OFF (config default "0") — the operator must explicitly turn
 * the ~2 GB AGPLv3 engine on and add `docs` to COMPOSE_PROFILES.
 */
function docsConfigured(): boolean {
  return config.DOCS_ENABLED === true;
}

/**
 * Bounded reachability probe against the internal document-server URL. Returns
 * `false` (never throws) on any failure so `/files/docs/status` can render a
 * calm "unavailable" state instead of 500-ing. The Document Server exposes a
 * `/healthcheck` endpoint that returns `true` when ready.
 */
export async function docServerHealthy(): Promise<boolean> {
  if (!docsConfigured()) return false;
  if (!config.DOCS_INTERNAL_URL.trim()) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const url = `${config.DOCS_INTERNAL_URL.replace(/\/$/, "")}/healthcheck`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return false;
    const body = (await res.text()).trim().toLowerCase();
    // Document Server returns the literal `true`; tolerate a JSON-wrapped boolean.
    if (body === "true") return true;
    try { return JSON.parse(body) === true; } catch { return false; }
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
 *      ONLYOFFICE_JWT_SECRET — the same secret the connector and Document Server
 *      verify — so the engine choice stays config-driven.
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

  // The editor is fronted publicly at DOCS_EDITOR_PUBLIC_PATH (nginx /docs/),
  // but the editable document is opened through the Nextcloud `onlyoffice`
  // connector, keyed by fileId. The dashboard loads this URL in the iframe.
  const editorBase = `${config.NEXTCLOUD_URL.replace(/\/$/, "")}/index.php/apps/onlyoffice/${ncFileId}`;
  const editorUrl = `${editorBase}?mode=${requestedMode}`;

  // `documentKey` namespaces the co-authoring session in the engine: OnlyOffice
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

  if (!config.ONLYOFFICE_JWT_SECRET.trim()) {
    throw new DocServerUnavailableError(
      "ONLYOFFICE_JWT_SECRET is not configured — document editing is unavailable",
    );
  }

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
