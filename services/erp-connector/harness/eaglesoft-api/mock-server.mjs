/**
 * Dummy Eaglesoft REST API server (Patterson "Innovation Connection" shape).
 *
 * A synthetic stand-in for the ASP.NET Web-API-2 service a real Eaglesoft box
 * serves on HTTPS :9888, so `EaglesoftApiConnector` can be driven end-to-end
 * over a real TLS socket — real handshake, real headers, real status codes,
 * real timeouts — without a dental office, a live box, a Patterson vendor
 * enrollment, or one byte of PHI.
 *
 * WHAT IT IS FAITHFUL TO (deliberately, and only this):
 *   • the Authenticate -> session-token -> `Authorization` header handshake
 *   • Web-API-2 response conventions (PascalCase fields, envelope objects)
 *   • a `/help` discovery page, the same place an installer reads the real
 *     route contract from
 *   • HTTP semantics the connector must survive: 401, 404, 5xx, slow
 *     responses, dropped connections, non-JSON bodies
 *   • the optimistic-concurrency guard on the one v1 write
 *
 * WHAT IT IS NOT: Patterson's actual route templates or field names. Those are
 * compiled into `Patterson.Eaglesoft.Api.Server.dll` and must be discovered per
 * box; see `fixture.mjs` and `src/api-route-map.ts`. This server publishes the
 * synthetic contract in `ROUTE_MAP` and serves exactly that, so swapping in a
 * real discovered map is a fixture edit, not a code change.
 *
 * ⚠ TEST HARNESS ONLY. This is never part of the shipped stack — it is not in
 * `docker/docker-compose.yml` and must not be. It accepts dev credentials, and
 * its `/__control/*` plane can make it misbehave on demand.
 *
 * Dependency-free (node: builtins only), matching this package's convention.
 */
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { randomBytes } from "node:crypto";
import {
  ACCOUNTS,
  DEV_CREDENTIALS,
  PATIENTS,
  PROVIDERS,
  RECALL_DUE_PATIENT_IDS,
  ROUTE_MAP,
  anchorDateUtc,
  materializeAppointments,
} from "./fixture.mjs";
import { ensureCerts } from "./certs.mjs";

/** Default HTTPS port a real Eaglesoft API box listens on. */
export const DEFAULT_PORT = 9888;

/** Cap on a request body, so a malformed client can't balloon the harness. */
const MAX_BODY_BYTES = 64 * 1024;

/** Columns the write endpoint will accept — mirrors `reschedule_appointment`'s
 *  `allowedColumns`. The PK and the patient link are read-only, exactly as the
 *  registry declares, so the mock can't be used to prove a write the real
 *  safety model would refuse. */
const WRITABLE_APPOINTMENT_FIELDS = ["StartTime", "ProviderId", "OperatoryId", "Status"];

/**
 * Start the dummy Eaglesoft API box.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.port]        Listen port; 0 picks a free one (tests).
 * @param {string}  [opts.hostname]    Bind address. Defaults to loopback.
 * @param {boolean} [opts.tls]         Serve HTTPS (default). `false` = plain
 *                                     HTTP, for debugging the wire by hand.
 * @param {object}  [opts.certs]       `{ key, cert, ca }`; generated if absent.
 * @param {object}  [opts.credentials] Accepted credentials.
 * @param {number}  [opts.tokenTtlMs]  Session-token lifetime.
 * @param {boolean} [opts.quiet]       Suppress the request log line.
 * @returns {Promise<MockBox>}
 */
export async function startMockEaglesoftApi(opts = {}) {
  const {
    port = 0,
    hostname = "127.0.0.1",
    tls = true,
    credentials = DEV_CREDENTIALS,
    tokenTtlMs = 60 * 60 * 1000,
    quiet = true,
  } = opts;

  const certs = tls ? (opts.certs ?? ensureCerts()) : null;

  /** Anchored ONCE, so a UTC midnight rollover can't move the fixture under a
   *  caller that already read `anchorDate`. */
  const anchorDate = anchorDateUtc();
  const state = {
    appointments: materializeAppointments(anchorDate),
    tokens: new Map(),
    /** Every request seen, for hygiene assertions (e.g. "no credential ever
     *  appeared in a URL"). Bounded so a long run can't grow without limit. */
    requests: [],
    faults: null,
  };

  const handler = makeHandler({ state, credentials, tokenTtlMs, quiet });
  const server = tls
    ? createServer({ key: certs.key, cert: certs.cert }, handler)
    : createHttpServer(handler);

  // Keep sockets short-lived so `close()` is prompt and a hung client can't
  // wedge a test run.
  server.keepAliveTimeout = 1000;
  server.headersTimeout = 5000;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const actualPort = server.address().port;
  const scheme = tls ? "https" : "http";
  const authority = hostname.includes(":") ? `[${hostname}]` : hostname;

  return {
    server,
    port: actualPort,
    host: hostname,
    url: `${scheme}://${authority}:${actualPort}`,
    anchorDate,
    routeMap: ROUTE_MAP,
    credentials,
    ca: certs?.ca ?? null,
    caCertPath: certs?.caCertPath ?? null,

    /** Requests seen so far (newest last). */
    requests: () => state.requests.slice(),
    /** Current appointment rows (post-write state). */
    appointments: () => state.appointments.map((a) => ({ ...a })),
    /** Make the box misbehave. See {@link applyFaults}. `null` clears. */
    setFaults: (f) => { state.faults = f ? { count: Infinity, ...f } : null; },
    /** Drop every issued session token (simulates a box restart / expiry). */
    expireTokens: () => state.tokens.clear(),
    /** Restore seed data, clear faults, tokens, and the request log. */
    reset: () => {
      state.appointments = materializeAppointments(anchorDate);
      state.tokens.clear();
      state.requests.length = 0;
      state.faults = null;
    },

    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function makeHandler({ state, credentials, tokenTtlMs, quiet }) {
  return async (req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://placeholder");
    } catch {
      return json(res, 400, { Message: "Malformed request URI" });
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";

    state.requests.push({
      method: req.method,
      path,
      // The full request target as received, so a test can assert no secret
      // ever travelled in a query string.
      rawUrl: req.url,
      authorization: req.headers.authorization ?? null,
      at: new Date().toISOString(),
    });
    if (state.requests.length > 1000) state.requests.shift();
    if (!quiet) console.log(`[mock-eaglesoft] ${req.method} ${req.url}`);

    try {
      // The control plane and the discovery page stay reachable while faults
      // are armed — otherwise an armed fault could not be cleared.
      if (path.startsWith("/__control")) return await handleControl(req, res, path, state);
      if (path === "/help" || path === "/") return handleHelp(req, res);

      if (await applyFaults(state, res)) return;

      return await handleApi(req, res, { path, url, state, credentials, tokenTtlMs });
    } catch (err) {
      // A crash in the mock must look like a server fault, not a hang — a hung
      // harness is far harder to debug than a 500.
      return json(res, 500, { Message: `mock server error: ${err?.message ?? err}` });
    }
  };
}

/**
 * Apply any armed fault. Returns true when the request was already answered
 * (or the socket destroyed) and the caller must stop.
 *
 * Faults: `{ status, delayMs, malformedJson, closeConnection, count }`.
 * `count` makes a fault transient (default: until cleared), so retry and
 * recovery behaviour can be exercised, not just steady-state failure.
 */
async function applyFaults(state, res) {
  const f = state.faults;
  if (!f) return false;
  if (f.count !== Infinity) {
    if (f.count <= 0) return false;
    f.count -= 1;
  }

  if (f.delayMs) await sleep(f.delayMs);

  if (f.closeConnection) {
    res.socket?.destroy();
    return true;
  }
  if (f.malformedJson) {
    res.writeHead(f.status ?? 200, { "content-type": "application/json" });
    res.end("<html>500 - Internal Server Error</html>"); // IIS-style HTML where JSON was promised
    return true;
  }
  if (f.status) {
    json(res, f.status, { Message: `injected fault: HTTP ${f.status}` });
    return true;
  }
  return false;
}

async function handleControl(req, res, path, state) {
  if (path === "/__control/faults" && (req.method === "PUT" || req.method === "POST")) {
    const body = await readJson(req);
    state.faults = body && Object.keys(body).length ? { count: Infinity, ...body } : null;
    return json(res, 200, { Faults: state.faults });
  }
  if (path === "/__control/faults" && req.method === "DELETE") {
    state.faults = null;
    return json(res, 200, { Faults: null });
  }
  if (path === "/__control/requests" && req.method === "GET") {
    return json(res, 200, { Requests: state.requests });
  }
  if (path === "/__control/reset" && req.method === "POST") {
    state.tokens.clear();
    state.requests.length = 0;
    state.faults = null;
    return json(res, 200, { Reset: true });
  }
  return json(res, 404, { Message: `no control endpoint ${req.method} ${path}` });
}

/**
 * The discovery page. A real box serves an HTML Web-API-2 help page; an
 * installer reads it to learn the verbs, templates, and field names. Serving
 * the SAME `ROUTE_MAP` the router uses means what is advertised is exactly what
 * is served — the property that makes a discovery rehearsal meaningful.
 */
function handleHelp(req, res) {
  const wantsHtml = (req.headers.accept ?? "").includes("text/html");
  if (!wantsHtml) return json(res, 200, { ApiName: "Eaglesoft API (MOCK)", Routes: ROUTE_MAP });

  const rows = [
    renderHelpRow("authenticate", ROUTE_MAP.authenticate),
    ...Object.entries(ROUTE_MAP.reads).map(([op, r]) => renderHelpRow(`read:${op}`, r)),
    ...Object.entries(ROUTE_MAP.writes).map(([op, r]) => renderHelpRow(`write:${op}`, r)),
  ].join("\n");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>Eaglesoft API (MOCK) — Help</title>` +
      `<h1>Eaglesoft API (MOCK)</h1>` +
      `<p><strong>Synthetic harness.</strong> These routes are stand-ins, not Patterson's real contract.</p>` +
      `<table border="1" cellpadding="6"><tr><th>Operation</th><th>Verb</th><th>Template</th><th>Controller.Method</th></tr>` +
      rows +
      `</table>`,
  );
}

function renderHelpRow(op, r) {
  return `<tr><td>${esc(op)}</td><td>${esc(r.verb)}</td><td><code>${esc(r.template)}</code></td><td>${esc(`${r.controller}.${r.method}`)}</td></tr>`;
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function handleApi(req, res, ctx) {
  const { path, url, state, credentials, tokenTtlMs } = ctx;
  const auth = ROUTE_MAP.authenticate;

  if (path === auth.template) {
    if (req.method !== auth.verb) return methodNotAllowed(res, auth.verb);
    return handleAuthenticate(req, res, { state, credentials, tokenTtlMs });
  }

  const match = findRoute(path, req.method);
  if (!match) {
    // A real Web-API-2 box distinguishes "no such route" from "wrong verb".
    const anyVerb = findRoute(path, null);
    if (anyVerb) return methodNotAllowed(res, anyVerb.route.verb);
    return json(res, 404, { Message: `No HTTP resource was found that matches the request URI '${path}'.` });
  }

  // Every non-auth route is session-gated, as on a real box.
  if (!validToken(state, req.headers.authorization)) {
    return json(res, 401, { Message: "Authorization has been denied for this request." });
  }

  if (match.kind === "read") return handleRead(res, match.op, url, state);
  return handleWrite(req, res, match.op, state);
}

/** Look up a route by path (and optionally verb) across the published map. */
function findRoute(path, method) {
  for (const [op, route] of Object.entries(ROUTE_MAP.reads)) {
    if (route.template === path && (method === null || route.verb === method)) {
      return { kind: "read", op, route };
    }
  }
  for (const [op, route] of Object.entries(ROUTE_MAP.writes)) {
    if (route.template === path && (method === null || route.verb === method)) {
      return { kind: "write", op, route };
    }
  }
  return null;
}

async function handleAuthenticate(req, res, { state, credentials, tokenTtlMs }) {
  const body = await readJson(req);
  if (body === null) return json(res, 400, { Message: "Request body must be JSON." });

  const { integrationKey, userId, password } = body;
  if (!integrationKey || !userId || !password) {
    return json(res, 400, { Message: "integrationKey, userId and password are required." });
  }
  const ok =
    integrationKey === credentials.integrationKey &&
    userId === credentials.userId &&
    password === credentials.password;
  if (!ok) {
    // Deliberately not saying WHICH of the three was wrong — same as a box that
    // isn't helping an attacker enumerate providers.
    return json(res, 401, { Message: "Authentication failed." });
  }

  const token = randomBytes(24).toString("hex");
  state.tokens.set(token, Date.now() + tokenTtlMs);
  return json(res, 200, { SessionToken: token, ExpiresInSeconds: Math.floor(tokenTtlMs / 1000) });
}

function validToken(state, header) {
  if (!header) return false;
  // A real box takes the raw token; tolerate a "Bearer " prefix so a
  // hand-driven curl works either way.
  const token = header.replace(/^Bearer\s+/i, "").trim();
  const expiry = state.tokens.get(token);
  if (expiry === undefined) return false;
  if (expiry < Date.now()) {
    state.tokens.delete(token);
    return false;
  }
  return true;
}

function handleRead(res, op, url, state) {
  const q = url.searchParams;

  switch (op) {
    case "get_schedule_today": {
      const from = q.get("startDate");
      const to = q.get("endDate");
      if (!from || !to) return json(res, 400, { Message: "startDate and endDate are required." });
      const fromMs = Date.parse(from);
      const toMs = Date.parse(to);
      if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
        return json(res, 400, { Message: "startDate and endDate must be parseable dates." });
      }
      const rows = state.appointments.filter((a) => {
        const t = Date.parse(a.StartTime);
        return t >= fromMs && t < toMs; // half-open [from, to), matching the SQL track
      });
      // Returned NEWEST-FIRST on purpose: the connector is responsible for
      // reproducing the SQL `ORDER BY appt_time`, and a pre-sorted mock would
      // hide a regression there.
      const payload = [...rows].sort((a, b) => (a.StartTime < b.StartTime ? 1 : -1));
      return json(res, 200, { Appointments: payload.map(publicAppointment) });
    }

    case "find_patient": {
      const term = q.get("lastName") ?? "";
      // LITERAL prefix match, case-insensitive. Literal is the important half:
      // the SQL track escapes LIKE metacharacters so a "%" search cannot turn a
      // name lookup into a full-table PHI dump, and the mock must not be more
      // permissive than the system it stands in for.
      const needle = term.toLowerCase();
      const rows = needle
        ? PATIENTS.filter((p) => p.LastName.toLowerCase().startsWith(needle))
        : [];
      return json(res, 200, { Patients: rows.map(publicPatient) });
    }

    case "get_patient": {
      const id = Number(q.get("patientId"));
      const found = PATIENTS.find((p) => p.PatientId === id);
      // `Patient: null` (not a 404) is the Web-API-2 idiom for "queried, no
      // match"; the connector maps the null envelope to zero rows.
      return json(res, 200, { Patient: found ? publicPatient(found) : null });
    }

    case "get_ar_summary":
      return json(res, 200, { Accounts: ACCOUNTS.map((a) => ({ AccountId: a.AccountId, AgedBalance: a.AgedBalance })) });

    case "get_recall_due": {
      const rows = PATIENTS.filter((p) => RECALL_DUE_PATIENT_IDS.includes(p.PatientId));
      return json(res, 200, { Patients: rows.map(publicPatient) });
    }

    default:
      return json(res, 501, { Message: `read op "${op}" is published but not implemented by the mock` });
  }
}

/**
 * The one v1 write: reschedule an appointment, optimistic-guarded on
 * `LastModified`. A guard miss is a 409 — the connector's write pipeline must
 * treat that as DISCREPANCY, never retry blindly over a front-desk edit.
 */
async function handleWrite(req, res, op, state) {
  if (op !== "reschedule_appointment") {
    return json(res, 501, { Message: `write op "${op}" is published but not implemented by the mock` });
  }
  const body = await readJson(req);
  if (body === null) return json(res, 400, { Message: "Request body must be JSON." });

  const { AppointmentId, LastModified } = body;
  if (AppointmentId === undefined || !LastModified) {
    return json(res, 400, { Message: "AppointmentId and LastModified are required." });
  }

  const rejected = Object.keys(body).filter(
    (k) => !["AppointmentId", "LastModified", ...WRITABLE_APPOINTMENT_FIELDS].includes(k),
  );
  if (rejected.length) {
    return json(res, 400, { Message: `field(s) not writable: ${rejected.join(", ")}` });
  }

  const appt = state.appointments.find((a) => a.AppointmentId === Number(AppointmentId));
  if (!appt) return json(res, 404, { Message: `Appointment ${AppointmentId} not found.` });

  if (appt.LastModified !== LastModified) {
    return json(res, 409, {
      Message: "The appointment was modified by another user.",
      CurrentLastModified: appt.LastModified,
    });
  }

  for (const f of WRITABLE_APPOINTMENT_FIELDS) {
    if (body[f] !== undefined) appt[f] = body[f];
  }
  // The watermark advances on every write — the DEFAULT TIMESTAMP behaviour the
  // guard depends on. Nudged forward rather than set to `now` so two writes in
  // the same millisecond still produce distinct watermarks.
  appt.LastModified = nextWatermark(appt.LastModified);

  return json(res, 200, { Appointment: publicAppointment(appt) });
}

function nextWatermark(previous) {
  const candidate = Date.now();
  const prev = Date.parse(previous);
  return new Date(Number.isNaN(prev) ? candidate : Math.max(candidate, prev + 1)).toISOString();
}

/** Appointment fields the API exposes. `Reason` is deliberately included: the
 *  box returns more than the connector maps, proving the DTO layer projects to
 *  the canonical keys instead of passing through whatever arrived. */
const publicAppointment = (a) => ({
  AppointmentId: a.AppointmentId,
  PatientId: a.PatientId,
  ProviderId: a.ProviderId,
  OperatoryId: a.OperatoryId,
  StartTime: a.StartTime,
  Status: a.Status,
  Reason: a.Reason,
  LastModified: a.LastModified,
});

/** Patient fields the API exposes — including demographics the connector must
 *  NOT surface, so a minimum-necessary regression would be visible. */
const publicPatient = (p) => ({
  PatientId: p.PatientId,
  FirstName: p.FirstName,
  LastName: p.LastName,
  DateOfBirth: p.DateOfBirth,
  Phone: p.Phone,
  Status: p.Status,
});

function methodNotAllowed(res, expected) {
  res.setHeader("allow", expected);
  return json(res, 405, { Message: `The requested resource does not support http method. Expected ${expected}.` });
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Read and parse a JSON body. Returns `null` on absent/invalid JSON so the
 *  caller can answer 400 rather than throw. */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export { ROUTE_MAP, PROVIDERS };
