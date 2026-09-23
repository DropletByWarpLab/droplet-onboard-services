/**
 * WARP-2900 (ADR-056 slice H3) — a promoted, running extension becomes an
 * MCP server the agent can see: attached to the multiplexer as
 * `ext-<slug>`, its tools published to the RUNTIME layer, each one recorded
 * in the classification table as a confirming write.
 *
 * THE ORDER, and every step refuses before the next one dials:
 *
 *   0. whatever this process had attached for the slug is dropped FIRST,
 *      and anything a failed attach half-did is dropped again on the way
 *      out. An attach that fails therefore leaves NOTHING attached: never
 *      the previous version's tools under its provenance while the new
 *      version runs, and `isAttached` is false, so the reconciler retries;
 *   1. the sandbox URL must name the compose-internal `sandbox` host. The
 *      relay is the only road to an extension; a SANDBOX_URL pointed
 *      anywhere else is refused before a byte is sent;
 *   2. the SESSION PROFILE is built from the manifest the lifecycle just
 *      re-verified (install re-verifies on every start). It names the
 *      server, version, runtime and a hash of the tools — and, by type, no
 *      host or URL: where the process runs is the sandbox's business;
 *   3. the extension's live `tools/list` must be exactly what the signed
 *      manifest provides — the same names, descriptions and input schemas.
 *      The shim serves the manifest, but the extension's own code runs in
 *      the shim's process, so the listing is checked, not trusted. The same
 *      check runs on every later listing (the port is pinned to the
 *      manifest), so a listing that drifts at runtime stops being
 *      advertised instead of being absorbed;
 *   4. `recordDiscoveredRemoteTools` with each tool's input-schema hash:
 *      every tool is a confirming write until a person says otherwise, and
 *      a tool whose schema changed since that person said so is again;
 *   5. the classification cache refresh, so step 4 is what dispatch reads.
 *      Steps 4 and 5 run BEFORE anything is attached or advertised, and a
 *      failure of either is a transient attach failure (retried), never a
 *      logged warning: otherwise a tool whose arguments changed would be
 *      dispatched under the review a person gave the old ones;
 *   6. `attachRemote('ext-<slug>')` — refused unless the lifecycle put the
 *      id in `installedExtensionIds` (mcp-client.singleton);
 *   7. `syncRemoteCatalog` with the operator's domain (chosen at promote)
 *      and the provenance `extension:<slug>@<version>`.
 *
 * TOOL_CATALOG is never touched (remote-mcp-servers.ts says why).
 *
 * AUDIT. `extensionAuditRefs` (extension-token.ts) is the ONE place that decides a
 * `tool_call` row's `refs.extensionId`: for a model's call to an
 * `ext-<slug>__*` tool (the audited port below) and for a static tool an
 * extension called back into as its owner (mcp-client.service.ts's
 * dispatch row, via `McpCallContext.extensionId`). The audited port's row
 * also carries who the call ran for and its durable run, read from the
 * multiplexer's in-process attribution scope (remote-call-attribution.ts):
 * the port itself is never handed the call context.
 */
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { TOOL_DOMAINS, type ToolDomain } from "@droplet/tools-core";
import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";
import type { RecordParams } from "./activity.service.js";
import { recordActivity } from "./activity.singleton.js";
import type { McpClientPort, McpToolCallOutcome } from "./mcp-client.port.js";
import { namespacedToolName, type McpToolMultiplexer } from "./mcp-multiplexer.service.js";
import {
  canonicalJson,
  parseExtensionManifest,
  type ExtensionManifest,
} from "./extension-manifest.js";
import {
  ExtensionAttachError,
  extensionServerId,
  type ExtensionAttachPort,
} from "./extension-lifecycle.service.js";
import { extensionAuditRefs } from "./extension-token.js";
import { remoteCallAttribution } from "./remote-call-attribution.js";
import {
  ExtensionListingMismatchError,
  ExtensionMcpPort,
  extensionInputSchemaHash,
} from "./extension-mcp.port.js";
import {
  EXTENSION_SANDBOX_HOST,
  isInternalSandboxUrl,
  type ExtensionSandboxClient,
} from "./extension-sandbox.client.js";
import { syncRemoteCatalog } from "./remote-mcp-servers.js";
import {
  recordDiscoveredRemoteTools,
  remoteToolClassificationCache,
  type ClassificationPrisma,
  type RemoteToolClassificationCache,
} from "./remote-tool-classification.service.js";
import { runtimeToolRegistry, type RuntimeToolRegistry } from "./runtime-tool-registry.service.js";

export { extensionInputSchemaHash };

const logger = createLogger("extension-attach");

export { EXTENSION_SANDBOX_HOST };

// ─── the session profile ─────────────────────────────────────────────────

/**
 * What the orchestrator knows about one attached extension session. Built
 * from the verified manifest. It has NO host, URL or port: the orchestrator
 * never dials an extension, the sandbox relay does.
 */
export interface ExtensionSessionProfile {
  serverId: string;
  slug: string;
  version: string;
  runtime: ExtensionManifest["runtime"];
  /** sha256 over the canonical {name, description, inputSchema} list. */
  toolsHash: string;
}

/** Pinned by the attach test: a new key here is a reviewed change. */
export const EXTENSION_SESSION_PROFILE_KEYS = ["serverId", "slug", "version", "runtime", "toolsHash"] as const;

export function buildExtensionSessionProfile(slug: string, manifest: ExtensionManifest): ExtensionSessionProfile {
  const tools = manifest.provides.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  return {
    serverId: extensionServerId(slug),
    slug,
    version: manifest.version,
    runtime: manifest.runtime,
    toolsHash: createHash("sha256").update(canonicalJson(tools), "utf8").digest("hex"),
  };
}

export function extensionProvenance(slug: string, version: string): string {
  return `extension:${slug}@${version}`;
}

/**
 * Refuse a relay that is not the compose-internal sandbox, as a PERMANENT
 * attach refusal. The orchestrator reaches an extension only through
 * `sandbox` on `droplet-internal`. The sandbox client applies the same
 * predicate to every call it makes (install included, so the `dxt_` bearer
 * never leaves either); this is the attach's own, earlier, typed refusal.
 */
export function assertInternalSandboxUrl(url: string): void {
  if (!isInternalSandboxUrl(url)) {
    throw new ExtensionAttachError(
      "sandbox_url_refused",
      true,
      `extensions attach only through the compose-internal '${EXTENSION_SANDBOX_HOST}' host; SANDBOX_URL names another`,
    );
  }
}

// ─── audit ───────────────────────────────────────────────────────────────

// extensionAuditRefs lives in extension-token.ts (dependency-light, so the
// stdio dispatch's audit site can call it) and is exported from here too.
export { extensionAuditRefs };

/** The extension port, with a `tool_call` row per dispatch that reached it. */
function auditedPort(
  port: McpClientPort,
  serverId: string,
  audit: (p: RecordParams) => Promise<unknown>,
): McpClientPort {
  return {
    get isStarted() {
      return port.isStarted;
    },
    listTools: () => port.listTools(),
    async callTool(wireName, args): Promise<McpToolCallOutcome> {
      const name = namespacedToolName(serverId, wireName);
      let out: McpToolCallOutcome | null = null;
      try {
        out = await port.callTool(wireName, args);
        return out;
      } finally {
        const ok = out !== null && !out.isError;
        // Who the call ran for, the stdio row's shape (mcp-client.service).
        const who = remoteCallAttribution();
        // Never the arguments: they may carry anything.
        void audit({
          kind: "tool_call",
          severity: ok ? "ok" : "err",
          sourceIcon: "puzzle",
          what: ok ? `Tool ${name}` : `Tool ${name} failed`,
          sub: who?.userId ? `for ${who.userId}` : null,
          actor: { type: "ai", id: null },
          refs: {
            name,
            ...(who?.userId ? { userId: who.userId } : {}),
            ok,
            ...(who?.agentRunId ? { agentRunId: who.agentRunId } : {}),
            ...extensionAuditRefs(name),
          },
        }).catch(() => undefined);
      }
    },
  };
}

// ─── the attacher ────────────────────────────────────────────────────────

export interface ExtensionAttacherDeps {
  prisma: PrismaClient;
  mux: McpToolMultiplexer;
  sandbox: Pick<ExtensionSandboxClient, "rpc">;
  registry?: RuntimeToolRegistry;
  cache?: RemoteToolClassificationCache;
  /** Read per attach, so a test can point it elsewhere. Defaults to config.SANDBOX_URL. */
  sandboxUrl?: () => string;
  audit?: (p: RecordParams) => Promise<unknown>;
}

export interface ExtensionAttacher extends ExtensionAttachPort {
  attach(slug: string): Promise<ExtensionSessionProfile>;
  detach(slug: string): Promise<void>;
  isAttached(slug: string): boolean;
}

/**
 * Attaches of one slug run one at a time, across every attacher in the
 * process (the promote route's and the reconciler's): the second finds the
 * first's attachment and replaces it, never races it into SERVER_ID_IN_USE.
 */
const inFlight = new Map<string, Promise<unknown>>();

function serialised<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const prev = inFlight.get(slug) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  inFlight.set(slug, next);
  void next
    .catch(() => undefined)
    .finally(() => {
      if (inFlight.get(slug) === next) inFlight.delete(slug);
    });
  return next;
}

/**
 * An attach port that builds its attacher on first use. The app is built in
 * a dozen route suites with a `vi.mock` of the MCP singleton that has no
 * attach surface; nothing here is read until an extension actually starts
 * (the app.ts `detachRemoteMcp` precedent).
 */
export function lazyExtensionAttachPort(make: () => ExtensionAttacher): ExtensionAttacher {
  let attacher: ExtensionAttacher | null = null;
  const get = (): ExtensionAttacher => (attacher ??= make());
  return {
    attach: (slug) => get().attach(slug),
    detach: (slug) => get().detach(slug),
    isAttached: (slug) => get().isAttached(slug),
  };
}

export function createExtensionAttacher(deps: ExtensionAttacherDeps): ExtensionAttacher {
  const { prisma, mux, sandbox } = deps;
  const registry = deps.registry ?? runtimeToolRegistry;
  const cache = deps.cache ?? remoteToolClassificationCache;
  const sandboxUrl = deps.sandboxUrl ?? (() => config.SANDBOX_URL ?? "http://sandbox:8030");
  const audit = deps.audit ?? recordActivity;

  function drop(serverId: string): void {
    mux.detachRemote(serverId);
    registry.unregisterServer(serverId);
  }

  async function attachNow(slug: string): Promise<ExtensionSessionProfile> {
    const serverId = extensionServerId(slug);
    // 0. Nothing of the previous attachment survives an attach, failed or
    // not; and every refusal below is undone here, in one place.
    drop(serverId);
    try {
      return await attachSteps(slug, serverId);
    } catch (err) {
      drop(serverId);
      throw err;
    }
  }

  async function attachSteps(slug: string, serverId: string): Promise<ExtensionSessionProfile> {
    assertInternalSandboxUrl(sandboxUrl());

    const ext = await prisma.extension.findUnique({ where: { id: slug }, include: { currentVersion: true } });
    if (!ext?.currentVersion) {
      throw new ExtensionAttachError("not_promoted", true, `extension ${slug} has no signed version`);
    }
    const parsed = parseExtensionManifest(ext.currentVersion.manifestBytes);
    if (!parsed.ok) {
      throw new ExtensionAttachError("manifest_invalid", true, `extension ${slug}'s manifest does not parse: ${parsed.detail}`);
    }
    const manifest = parsed.manifest;
    const profile = buildExtensionSessionProfile(slug, manifest);
    const expected = manifest.provides.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    const port = new ExtensionMcpPort({ slug, sandbox, pinned: expected });

    // 3. The live listing against the signed one, before anything attaches.
    try {
      await port.listTools();
    } catch (err) {
      if (err instanceof ExtensionListingMismatchError) {
        throw new ExtensionAttachError("listing_mismatch", true, err.message);
      }
      throw new ExtensionAttachError(
        "listing_unavailable",
        false,
        `extension ${slug} did not list its tools: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 4 + 5. Classification, BEFORE anything is attached or advertised. A
    // tool whose input schema changed is back to a confirming write in the
    // record AND in the cache dispatch reads, or the attach does not happen.
    try {
      const recorded = await recordDiscoveredRemoteTools(
        prisma as unknown as ClassificationPrisma,
        serverId,
        expected.map((t) => ({
          wireName: t.name,
          description: t.description,
          inputSchemaHash: extensionInputSchemaHash(t.inputSchema),
        })),
      );
      logger.info({ slug, created: recorded.created.length, reset: recorded.reset.length }, "extension_tools_recorded");
    } catch (err) {
      throw new ExtensionAttachError(
        "classification_unavailable",
        false,
        `the review of ${slug}'s tools could not be recorded: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      await cache.refresh(prisma as unknown as ClassificationPrisma);
    } catch (err) {
      throw new ExtensionAttachError(
        "classification_unavailable",
        false,
        `the classification cache could not be refreshed for ${slug}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 6. Attach (whatever was attached for the slug was dropped at step 0).
    const rejection = mux.attachRemote(serverId, auditedPort(port, serverId, audit));
    if (rejection) {
      throw new ExtensionAttachError("attach_rejected", true, `${rejection.code}: ${rejection.message}`);
    }
    try {
      await mux.listTools();
    } catch (err) {
      throw new ExtensionAttachError(
        "listing_unavailable",
        false,
        `the tool listing failed while attaching ${slug}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const vetted = new Set(mux.remoteCatalog(serverId).map((t) => t.name));
    const refused = expected.filter((t) => !vetted.has(namespacedToolName(serverId, t.name)));
    if (refused.length > 0) {
      const why = mux
        .rejections()
        .filter((r) => r.serverId === serverId)
        .slice(-refused.length)
        .map((r) => `${r.toolName ?? ""}: ${r.code}`)
        .join("; ");
      throw new ExtensionAttachError(
        "listing_mismatch",
        true,
        `the multiplexer refused ${refused.map((t) => t.name).join(", ")}${why ? ` (${why})` : ""}`,
      );
    }

    // 7. Publish to the runtime layer.
    const operatorDomain =
      ext.operatorDomain && (TOOL_DOMAINS as readonly string[]).includes(ext.operatorDomain)
        ? (ext.operatorDomain as ToolDomain)
        : undefined;
    if (ext.operatorDomain && !operatorDomain) {
      logger.warn({ slug, operatorDomain: ext.operatorDomain }, "extension_operator_domain_unknown");
    }
    const sync = syncRemoteCatalog(mux, serverId, {
      ...(operatorDomain ? { operatorDomain } : {}),
      provenance: extensionProvenance(slug, manifest.version),
      registry,
    });
    if (sync.registered.length !== expected.length) {
      throw new ExtensionAttachError(
        "listing_mismatch",
        true,
        `only ${sync.registered.length} of ${expected.length} tools could be registered for ${slug}`,
      );
    }

    logger.info({ slug, serverId, version: profile.version, tools: expected.length }, "extension_attached");
    return profile;
  }

  return {
    attach: (slug) => serialised(slug, () => attachNow(slug)),
    detach: (slug) =>
      serialised(slug, async () => {
        drop(extensionServerId(slug));
      }),
    isAttached: (slug) => mux.remoteServerIds().includes(extensionServerId(slug)),
  };
}
