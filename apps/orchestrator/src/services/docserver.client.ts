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

/** True when the engine is configured to run at all (explicit flag + a URL). */
function docsConfigured(): boolean {
  return config.DOCS_ENABLED === true && config.DOCS_INTERNAL_URL.trim() !== "";
}

/**
 * Bounded reachability probe against the internal document-server URL. Returns
 * `false` (never throws) on any failure so `/files/docs/status` can render a
 * calm "unavailable" state instead of 500-ing. The Document Server exposes a
 * `/healthcheck` endpoint that returns `true` when ready.
 */
export async function docServerHealthy(): Promise<boolean> {
  if (!docsConfigured()) return false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const url = `${config.DOCS_INTERNAL_URL.replace(/\/$/, "")}/healthcheck`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return false;
    const body = (await res.text()).trim().toLowerCase();
    // Document Server returns the literal `true`; tolerate a JSON-wrapped value.
    return body === "true" || body.includes("true");
  } catch {
    return false;
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

  // Short-lived token the editor presents back. Bound to the fileId + user +
  // mode so a leaked token can't be replayed against another file or to escalate
  // a view session to edit. `documentKey` namespaces the co-authoring session.
  const documentKey = createHash("sha256")
    .update(`${ncFileId}:${ncUser}:${filePath}`)
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
