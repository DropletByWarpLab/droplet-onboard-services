/** HA-3: current-user grants, durable one-use exchange and isolated app JWTs. */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { resolveTrustedOriginUrl } from "../lib/trusted-origin.js";
import { resolveAssertedUser } from "./asserted-user.service.js";
import { parseExtensionManifest, EXTENSION_SLUG_PATTERN } from "./extension-manifest.js";
import { deriveHostedAppRelayKey, decryptColumn } from "./column-crypto.service.js";
import { createExtensionSandboxClient, isInternalSandboxUrl, type ExtensionSandboxClient } from "./extension-sandbox.client.js";
import { recordActivity } from "./activity.singleton.js";
import type { RecordParams } from "./activity.service.js";
import { WORKSPACE_ID } from "./workspace.service.js";

export const HOSTED_BODY_CAP = 32 * 1024 * 1024;
export const HOSTED_TIMEOUT_MS = 60_000;
export const HOSTED_SESSION_SECONDS = 12 * 60 * 60;
export const HOSTED_CODE_SECONDS = 60;
export const HOSTED_GRANT_ROLES = ["family"] as const;
export class HostedError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export interface HostedPerson { id: string; username: string; displayName: string; role: string }
export interface HostedDeps {
  sandbox?: ExtensionSandboxClient;
  audit?: (params: RecordParams) => Promise<unknown>;
  fetchImpl?: typeof fetch;
  gatewayPeer?: (req: Request) => Promise<boolean>;
  enabled?: () => boolean;
  now?: () => Date;
  /** Internal test seam may shorten the fixed public 60-second budget. */
  requestTimeoutMs?: number;
}

/** Separate signing key: an app token can never authenticate to dashboard auth. */
export function hostedJwtKey(): Buffer {
  return createHmac("sha256", config.JWT_SECRET).update("droplet-hosted-app-jwt-v1").digest();
}
export function hostedCookieName(slug: string): string { return `droplet_app_${slug}`; }
export function appCookie(req: Request, slug: string): string | null {
  const name = hostedCookieName(slug);
  const matches = (req.headers.cookie ?? "").split(";").map((v) => v.trim()).filter((v) => v.startsWith(`${name}=`));
  // Duplicate cookie names are ambiguous; never choose a less-confined path.
  if (matches.length !== 1) return null;
  return matches[0].slice(name.length + 1);
}
export function verifyHostedToken(token: string | null, slug: string): string {
  if (!token || token.length > 4096) throw new HostedError(401, "app_session_required");
  try {
    const value = jwt.verify(token, hostedJwtKey(), { algorithms: ["HS256"], audience: `app:${slug}`, issuer: "droplet-hosted" });
    if (typeof value === "string" || typeof value.sub !== "string") throw new Error("missing subject");
    return value.sub;
  } catch { throw new HostedError(401, "app_session_required"); }
}

let gatewayAddresses: { expires: number; values: string[] } | null = null;
const address = (value: string) => value.replace(/^::ffff:/, "");
export async function isHostedGatewayRequest(req: Request): Promise<boolean> {
  if (req.header("x-forwarded-port") !== "8443" || req.header("x-forwarded-proto") !== "https"
      || req.header("x-droplet-hosted-ingress") !== "8443") return false;
  if (!gatewayAddresses || gatewayAddresses.expires <= Date.now()) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const values = await Promise.race([
        lookup("gateway", { all: true }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("gateway lookup timed out")), 2000); }),
      ]);
      gatewayAddresses = { expires: Date.now() + 10_000, values: values.map((v) => address(v.address)) };
    } catch { return false; }
    finally { clearTimeout(timer); }
  }
  return gatewayAddresses.values.includes(address(req.socket.remoteAddress ?? ""));
}

export function createHostedService(prisma: PrismaClient, deps: HostedDeps = {}) {
  const sandbox = deps.sandbox ?? createExtensionSandboxClient();
  const audit = deps.audit ?? recordActivity;
  const now = deps.now ?? (() => new Date());
  const enabled = deps.enabled ?? (() => config.SANDBOX_PROCESS_SUPERVISION);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const gatewayPeer = deps.gatewayPeer ?? isHostedGatewayRequest;
  const requestTimeoutMs = deps.requestTimeoutMs ?? HOSTED_TIMEOUT_MS;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > HOSTED_TIMEOUT_MS) throw new Error("invalid hosted request timeout");
  function gate() { if (!enabled()) throw new HostedError(503, "hosted_apps_disabled"); }
  async function person(id: string): Promise<HostedPerson> {
    const row = await prisma.user.findUnique({ where: { id }, select: { id: true, username: true, displayName: true, role: true, directoryStatus: true } });
    if (!row || row.directoryStatus !== "ACTIVE" || !["owner", "admin", "family"].includes(row.role)) {
      throw new HostedError(403, "hosted_person_refused");
    }
    return row;
  }
  async function actor(req: Request, allowMcp = false): Promise<HostedPerson> {
    if (allowMcp && req.user?.id === "_service:mcp" && req.user.role === "service") {
      const asserted = req.header("x-nextcloud-user")?.trim()
        || (typeof req.query.onBehalfOf === "string" && req.query.onBehalfOf.length <= 200 ? req.query.onBehalfOf.trim() : undefined);
      if (!asserted) throw new HostedError(403, "acting_person_required");
      const resolved = await resolveAssertedUser(prisma, asserted);
      if (!resolved.ok) throw new HostedError(403, "acting_person_required");
      return person(resolved.user.id);
    }
    if (!req.user || req.user.role === "service") throw new HostedError(403, "human_required");
    return person(req.user.id);
  }
  async function app(slug: string, live = true) {
    if (!EXTENSION_SLUG_PATTERN.test(slug)) throw new HostedError(404, "app_not_found");
    const row = await prisma.extension.findUnique({ where: { id: slug }, include: { currentVersion: true, hostedAppGrants: true } });
    if (!row || row.kind !== "app" || !row.currentVersion) throw new HostedError(404, "app_not_found");
    const parsed = parseExtensionManifest(row.currentVersion.manifestBytes);
    if (!parsed.ok || parsed.manifest.kind !== "app") throw new HostedError(503, "app_manifest_invalid");
    if (live && row.status !== "live") throw new HostedError(503, "app_not_live");
    return { row, manifest: parsed.manifest };
  }
  function granted(user: HostedPerson, roles: ReadonlyArray<{ role: string }>) {
    if (["owner", "admin"].includes(user.role)) return;
    if (user.role !== "family" || !roles.some((g) => g.role === "family")) throw new HostedError(403, "app_not_granted");
  }
  async function record(op: string, slug: string, user: HostedPerson, severity: "info" | "warn" = "info") {
    await audit({ kind: "tool_run", severity, sourceIcon: "app-window", what: `Hosted app ${op}`,
      actor: { type: "user", id: user.id }, refs: { extensionId: slug, op, ticket: "WARP-3907" } });
  }
  async function authorized(slug: string, userId: string) {
    gate();
    const user = await person(userId);
    const result = await app(slug);
    granted(user, result.row.hostedAppGrants);
    return { ...result, user };
  }
  return {
    gate, actor, person, app, record, gatewayPeer,
    async checkAppOrigin(req: Request) {
      if (["GET", "HEAD", "OPTIONS"].includes(req.method) || !req.header("origin")) return;
      const expected = new URL(await resolveTrustedOriginUrl(req)); expected.protocol = "https:"; expected.port = "8443";
      if (req.header("origin") !== expected.origin) throw new HostedError(403, "foreign_app_origin_refused");
    },
    async list(req: Request) {
      const user = await actor(req, true);
      const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
      const cursor = req.query.cursor;
      const workspaceId = req.query.workspaceId;
      if ((req.query.limit !== undefined && typeof req.query.limit !== "string")
          || !Number.isInteger(limit) || limit < 1 || limit > 50
          || (cursor !== undefined && (typeof cursor !== "string" || !EXTENSION_SLUG_PATTERN.test(cursor)))
          || (workspaceId !== undefined && (typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)))) {
        throw new HostedError(400, "invalid_app_cursor");
      }
      // Apply visibility before pagination: inaccessible slugs must not leak
      // through a cursor, and an empty first page must not hide granted apps.
      const found = enabled() || ["owner", "admin"].includes(user.role) ? await prisma.extension.findMany({
        where: { kind: "app", ...(typeof cursor === "string" ? { id: { gt: cursor } } : {}),
          ...(typeof workspaceId === "string" ? { workspaceId } : {}),
          ...(user.role === "family" ? { status: "live", hostedAppGrants: { some: { role: "family" as const } } } : {}) },
        include: { currentVersion: true, hostedAppGrants: true }, orderBy: { id: "asc" }, take: limit + 1,
      }) : [];
      const rows = found.slice(0, limit);
      const origin = new URL(await resolveTrustedOriginUrl(req)); origin.port = "8443"; origin.protocol = "https:";
      const apps = rows.filter((row) => ["owner", "admin"].includes(user.role)
        || (enabled() && row.status === "live" && row.hostedAppGrants.some((g) => g.role === user.role))).map((row) => {
        const parsed = row.currentVersion ? parseExtensionManifest(row.currentVersion.manifestBytes) : null;
        return { id: row.id, slug: row.id, workspaceId: row.workspaceId, name: row.name, status: row.status,
          version: row.currentVersion?.version ?? null, url: `${origin.origin}/${row.id}/`,
          memoryMb: parsed?.ok && parsed.manifest.runtime !== "static" ? parsed.manifest.resources.memoryMb : 0,
          lastHealthAt: row.lastHealthAt?.toISOString() ?? null, grants: row.hostedAppGrants.map((g) => g.role) };
      });
      return { apps, supervisionEnabled: enabled(), nextCursor: found.length > limit ? rows[rows.length - 1].id : null };
    },
    async mint(req: Request, slug: string) {
      gate();
      const user = await actor(req);
      try { await authorized(slug, user.id); }
      catch (error) { await record("open denied", slug, user, "warn"); throw error; }
      const code = randomBytes(32).toString("base64url");
      await prisma.hostedAppSessionCode.deleteMany({ where: { expiresAt: { lte: now() } } });
      await prisma.hostedAppSessionCode.create({ data: { codeHash: createHash("sha256").update(code).digest("hex"),
        extensionId: slug, userId: user.id, expiresAt: new Date(now().getTime() + HOSTED_CODE_SECONDS * 1000) } });
      await record("session minted", slug, user);
      const origin = new URL(await resolveTrustedOriginUrl(req)); origin.protocol = "https:"; origin.port = "8443";
      return { url: `${origin.origin}/${slug}/_droplet/session?code=${code}` };
    },
    async redeem(slug: string, code: unknown) {
      gate();
      if (typeof code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw new HostedError(401, "exchange_code_invalid");
      const codeHash = createHash("sha256").update(code).digest("hex");
      const found = await prisma.hostedAppSessionCode.findUnique({ where: { codeHash } });
      if (!found || found.extensionId !== slug || found.expiresAt <= now()) throw new HostedError(401, "exchange_code_invalid");
      const used = await prisma.hostedAppSessionCode.deleteMany({ where: { codeHash, extensionId: slug, expiresAt: { gt: now() } } });
      if (used.count !== 1) throw new HostedError(401, "exchange_code_invalid");
      const { user } = await authorized(slug, found.userId);
      const token = jwt.sign({ role: user.role }, hostedJwtKey(), { algorithm: "HS256", subject: user.id,
        audience: `app:${slug}`, issuer: "droplet-hosted", expiresIn: HOSTED_SESSION_SECONDS });
      await record("session exchanged", slug, user);
      return token;
    },
    async session(req: Request, slug: string) { return authorized(slug, verifyHostedToken(appCookie(req, slug), slug)); },
    async logs(req: Request, slug: string, limit: number, since?: number) {
      gate();
      const user = await actor(req, true);
      if (!["owner", "admin"].includes(user.role)) throw new HostedError(403, "app_logs_refused");
      await app(slug, false);
      if (!sandbox.logs) throw new HostedError(503, "app_logs_unavailable");
      return sandbox.logs(slug, limit, since);
    },
    async grants(slug: string, roles?: string[], user?: HostedPerson) {
      await app(slug, false);
      if (roles) {
        if (!user || user.role !== "owner" || roles.some((r) => r !== "family") || new Set(roles).size !== roles.length) {
          throw new HostedError(403, "app_grants_refused");
        }
        await prisma.$transaction(async (tx) => {
          await tx.hostedAppGrant.deleteMany({ where: { extensionId: slug } });
          if (roles.length) await tx.hostedAppGrant.createMany({ data: roles.map(() => ({ extensionId: slug, role: "family" as const })) });
        });
        await record("grants changed", slug, user, "warn");
      }
      return { roles: (await prisma.hostedAppGrant.findMany({ where: { extensionId: slug } })).map((g) => g.role) };
    },
    async relay(req: Request, res: Response, slug: string) {
      const { row, user } = await authorized(slug, verifyHostedToken(appCookie(req, slug), slug));
      if (!row.appRelayKeyEnc) throw new HostedError(503, "app_relay_unavailable");
      let key: string;
      try { key = decryptColumn(deriveHostedAppRelayKey(), row.appRelayKeyEnc, `hosted-app:${slug}`); }
      catch { throw new HostedError(503, "app_relay_unavailable"); }
      const base = config.SANDBOX_URL.replace(/\/+$/, "");
      if (!isInternalSandboxUrl(base) || !config.SANDBOX_SERVICE_TOKEN) throw new HostedError(503, "sandbox_unavailable");
      const rawPath = req.url.split("?", 1)[0];
      let decodedPath: string;
      try { decodedPath = decodeURIComponent(rawPath); } catch { throw new HostedError(400, "app_path_invalid"); }
      if (req.url.includes("#") || decodedPath.includes("\\") || decodedPath.split("/").some((part) => part === "." || part === "..")) {
        throw new HostedError(400, "app_path_invalid");
      }
      const relayPrefix = `${new URL(base).pathname.replace(/\/+$/, "")}/extensions/${encodeURIComponent(slug)}/http`;
      const destination = new URL(`${base}/extensions/${encodeURIComponent(slug)}/http${req.url.startsWith("/") ? req.url : `/${req.url}`}`);
      // WHATWG URL parsing normalizes encoded dot segments and backslashes.
      // A client path must never turn the internal bearer into a call to a
      // different sandbox route, even if it bypassed gateway normalization.
      if (destination.origin !== new URL(base).origin || !destination.pathname.startsWith(`${relayPrefix}/`)) {
        throw new HostedError(400, "app_path_invalid");
      }
      const length = req.header("content-length");
      if (length && (!/^\d{1,10}$/.test(length) || Number(length) > HOSTED_BODY_CAP)) throw new HostedError(413, "app_body_too_large");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      const abort = () => controller.abort();
      const disconnected = () => { if (!res.writableFinished) abort(); };
      req.once("aborted", abort); res.once("close", disconnected);
      let size = 0;
      const capped = new Transform({ transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size > HOSTED_BODY_CAP) done(new HostedError(413, "app_body_too_large")); else done(null, chunk);
      } });
      const headers: Record<string, string> = { Authorization: `Bearer ${config.SANDBOX_SERVICE_TOKEN}`,
        "X-Droplet-Relay-Key": key, "X-Droplet-User-Id": user.id,
        "X-Droplet-User-Name": encodeURIComponent(user.username), "X-Droplet-Role": user.role, "X-Droplet-App": slug };
      for (const name of ["accept", "accept-language", "content-type", "if-none-match", "last-event-id"]) {
        const value = req.header(name); if (value) headers[name] = value;
      }
      const canHaveBody = !["GET", "HEAD"].includes(req.method);
      if (canHaveBody) req.pipe(capped);
      try {
        const upstream = await fetchImpl(destination.href, {
          method: req.method, headers, redirect: "manual", signal: controller.signal,
          ...(canHaveBody ? { body: capped, duplex: "half" } : {}),
        } as RequestInit & { duplex?: "half" });
        res.status(upstream.status);
        // Hosted HTML can contain the user's scripts; dashboard Helmet CSP
        // does not describe this separate origin. App-controlled auth/CORS
        // and cookies are still refused at BOTH relays.
        res.removeHeader("Content-Security-Policy"); res.removeHeader("Cross-Origin-Opener-Policy");
        const encoded = upstream.headers.has("content-encoding");
        for (const name of ["content-type", "cache-control", "etag", "last-modified", "location", "retry-after", "vary", "content-disposition"]) {
          const value = upstream.headers.get(name); if (value) res.setHeader(name, value);
        }
        // fetch decodes gzip/br automatically, so do not relay its compressed length/encoding.
        if (!encoded && upstream.headers.has("content-length")) res.setHeader("content-length", upstream.headers.get("content-length")!);
        res.setHeader("X-Droplet-Relay", "app"); res.setHeader("X-Content-Type-Options", "nosniff");
        if (!upstream.body || req.method === "HEAD") { await upstream.body?.cancel(); res.end(); }
        else await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), res, { signal: controller.signal });
      } catch (error) {
        if (size > HOSTED_BODY_CAP) throw new HostedError(413, "app_body_too_large");
        if (controller.signal.aborted && !res.destroyed) throw new HostedError(504, "app_request_timed_out");
        throw error;
      } finally {
        clearTimeout(timer); req.off("aborted", abort); res.off("close", disconnected);
        req.unpipe(capped); capped.destroy(); controller.abort();
      }
    },
  };
}
export type HostedService = ReturnType<typeof createHostedService>;
