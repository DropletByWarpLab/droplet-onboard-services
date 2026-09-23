/**
 * WARP-2900 (ADR-056 slice H2): what happens to a promoted extension after
 * it is signed — preflight, install, disable, enable, uninstall, and the
 * reconciler that reinstalls one the sandbox lost.
 *
 * EVERY START RE-VERIFIES. Before the sandbox is asked to run anything, the
 * stored statement bytes, signature and manifest bytes are verified again
 * (update-agent/extension-verify.ts) with the signer and key fingerprint
 * recorded at promote as the expectation. A statement that no longer
 * verifies — a rebuilt boot disk means a new box extension key
 * (extension_key_changed) — marks the extension `failed` with the reason and
 * starts nothing; the owner re-promotes.
 *
 * EVERY START ROTATES THE BEARER. The extension's call-back bearer (`dxt_`
 * + 32 random bytes) is minted here, its sha256 stored on the row, and the
 * plaintext handed to the sandbox ONLY in the install request, which puts it
 * in the child's environment and nowhere else. A stop clears the hash. The
 * orchestrator side of the call-back (resolving `dxt_` to the
 * `_service:ext:<slug>` principal) is WARP-2900 H3.
 *
 * `installedExtensionIds` is the set of multiplexer server ids
 * (`ext-<slug>`) this process considers installed. H3's
 * mcp-client.singleton reads it to decide which extension servers may
 * attach; it is maintained here, from the database, never from env.
 *
 * AUDIT: every transition writes a `tool_run` activity row with
 * `refs.extensionId` and `refs.op` — no new activity kind.
 */
import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { TOOL_CATALOG } from "@droplet/tools-core";
import { createLogger } from "../lib/logger.js";
import type { ActivityActor, RecordParams } from "./activity.service.js";
import { recordActivity } from "./activity.singleton.js";
import {
  parseExtensionManifest,
  type ExtensionManifest,
} from "./extension-manifest.js";
import {
  ExtensionSandboxError,
  type ExtensionSandboxClient,
  type SandboxBudget,
} from "./extension-sandbox.client.js";
import { runtimeToolRegistry } from "./runtime-tool-registry.service.js";
import { verifyExtensionStatement } from "./update-agent/extension-verify.js";

const logger = createLogger("extension-lifecycle");

export const EXTENSION_TOKEN_PREFIX = "dxt_";
export const EXTENSION_SERVER_PREFIX = "ext-";
export const EXTENSION_RECONCILE_LOCK_KEY = "droplet:extension-reconciler";
export const EXTENSION_TICKET = "WARP-2900";

/** Statuses whose process should be running. */
export const RUNNING_EXTENSION_STATUSES = ["installed", "live"] as const;

/** Server ids (`ext-<slug>`) this process treats as installed. */
export const installedExtensionIds = new Set<string>();

export function extensionServerId(slug: string): string {
  return `${EXTENSION_SERVER_PREFIX}${slug}`;
}

export function hashExtensionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function mintExtensionToken(): { token: string; hash: string } {
  const token = `${EXTENSION_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashExtensionToken(token) };
}

// ─── preflight ───────────────────────────────────────────────────────────

export type PreflightCode =
  | "memory_over_budget"
  | "tool_name_duplicated"
  | "tool_name_collides_with_catalog"
  | "tool_name_collides_with_extension"
  | "resembles_catalog_tool";

export interface PreflightFinding {
  code: PreflightCode;
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  blocking: PreflightFinding[];
  advisory: PreflightFinding[];
  budget: { availableMb: number; requestedMb: number; ceilingMb: number };
}

/** Name words, singularised crudely ("words" ~ "word") for the overlap test. */
const words = (name: string): Set<string> =>
  new Set(
    name
      .split(/[_\-\s]+/)
      .filter((w) => w.length > 1)
      .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)),
  );

function resembles(a: string, b: string): boolean {
  if (a === b) return false; // an exact match is a blocking collision, not advice
  if (a.includes(b) || b.includes(a)) return true;
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / new Set([...wa, ...wb]).size >= 0.5;
}

export interface PreflightInput {
  slug: string;
  manifest: ExtensionManifest;
  budget: SandboxBudget;
  /** Memory this slug's running version already holds (freed by a reinstall). */
  currentMemoryMb: number;
  /** Tool names other extensions provide (bare names from their manifests). */
  otherExtensionTools: ReadonlyMap<string, string>;
  catalogToolNames?: readonly string[];
  runtimeToolNames?: ReadonlyArray<{ serverId: string; name: string }>;
}

/**
 * BLOCKS on: memory over what the sandbox has left, a duplicate tool name
 * inside the manifest, a name the static catalog already has, or a name
 * another extension or attached server already provides. ADVISES (never
 * blocks) on a name that resembles a catalog tool — possible duplicated
 * functionality the owner should know about.
 */
export function preflightExtension(input: PreflightInput): PreflightResult {
  const blocking: PreflightFinding[] = [];
  const advisory: PreflightFinding[] = [];
  const requestedMb = input.manifest.resources.memoryMb;
  const availableMb = input.budget.availableMb + input.currentMemoryMb;
  if (requestedMb > availableMb) {
    blocking.push({
      code: "memory_over_budget",
      detail: `asks for ${requestedMb} MB; ${availableMb} MB is left of the sandbox's ${input.budget.ceilingMb} MB (${input.budget.transformHeadroomMb} MB is kept for transforms)`,
    });
  }
  const catalog = input.catalogToolNames ?? TOOL_CATALOG.map((t) => t.name);
  const catalogSet = new Set(catalog);
  const serverId = extensionServerId(input.slug);
  const runtimeBare = new Map<string, string>();
  for (const t of input.runtimeToolNames ?? runtimeToolRegistry.list()) {
    if (t.serverId === serverId) continue;
    const bare = t.name.includes("__") ? t.name.slice(t.name.lastIndexOf("__") + 2) : t.name;
    runtimeBare.set(bare, t.serverId);
  }
  const seen = new Set<string>();
  for (const tool of input.manifest.provides.tools) {
    if (seen.has(tool.name)) {
      blocking.push({ code: "tool_name_duplicated", detail: `${tool.name} is declared twice` });
      continue;
    }
    seen.add(tool.name);
    if (catalogSet.has(tool.name)) {
      blocking.push({
        code: "tool_name_collides_with_catalog",
        detail: `${tool.name} is already a built-in tool`,
      });
    }
    const owner = input.otherExtensionTools.get(tool.name) ?? runtimeBare.get(tool.name);
    if (owner) {
      blocking.push({
        code: "tool_name_collides_with_extension",
        detail: `${tool.name} is already provided by ${owner}`,
      });
    }
    const alike = catalog.filter((c) => resembles(tool.name, c));
    if (alike.length > 0) {
      advisory.push({
        code: "resembles_catalog_tool",
        detail: `${tool.name} resembles built-in ${alike.slice(0, 3).join(", ")}; it may duplicate what the box already does`,
      });
    }
  }
  return {
    ok: blocking.length === 0,
    blocking,
    advisory,
    budget: { availableMb, requestedMb, ceilingMb: input.budget.ceilingMb },
  };
}

// ─── lifecycle ───────────────────────────────────────────────────────────

export type ExtensionLifecycleErrorCode =
  | "not_found"
  | "not_promoted"
  | "wrong_state"
  | "verify_failed"
  | "install_failed"
  | "supervision_off";

export class ExtensionLifecycleError extends Error {
  constructor(
    readonly code: ExtensionLifecycleErrorCode,
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "ExtensionLifecycleError";
  }
}

/** H3 plugs the multiplexer attach/detach in here; H2 has nothing to attach. */
export interface ExtensionAttachPort {
  attach(slug: string): Promise<void>;
  detach(slug: string): Promise<void>;
}

export interface ExtensionKeySource {
  getExtensionPublicKey(): Promise<{ spkiDer: Uint8Array; fingerprint: string } | null>;
}

export interface ExtensionLifecycleDeps {
  prisma: PrismaClient;
  sandbox: ExtensionSandboxClient;
  identity: ExtensionKeySource;
  attach?: ExtensionAttachPort;
  audit?: (params: RecordParams) => Promise<unknown>;
  /** Handed to the child as DROPLET_ORCHESTRATOR_URL (the H3 call-back). */
  orchestratorUrl?: string;
}

export type LifecycleOp = "promote" | "install" | "disable" | "enable" | "uninstall" | "reconcile";

type ExtensionStatusName = "signed" | "installed" | "live" | "disabled" | "failed" | "uninstalled";

const SYSTEM_ACTOR: ActivityActor = { type: "system", id: null };

export interface ReconcileReport {
  checked: number;
  restarted: string[];
  failed: string[];
  skipped?: "supervision_off";
}

export function createExtensionLifecycle(deps: ExtensionLifecycleDeps) {
  const { prisma, sandbox, identity } = deps;
  const audit = deps.audit ?? recordActivity;
  const attach: ExtensionAttachPort = deps.attach ?? {
    attach: async () => {},
    detach: async () => {},
  };

  async function record(
    op: LifecycleOp,
    slug: string,
    actor: ActivityActor,
    extra: { severity?: "info" | "warn"; what: string; sub?: string; refs?: Record<string, unknown> },
  ): Promise<void> {
    await audit({
      kind: "tool_run",
      severity: extra.severity ?? "info",
      sourceIcon: "puzzle",
      what: extra.what,
      sub: extra.sub ?? slug,
      actor,
      refs: { extensionId: slug, op, ticket: EXTENSION_TICKET, ...(extra.refs ?? {}) },
    });
  }

  async function load(slug: string) {
    const ext = await prisma.extension.findUnique({
      where: { id: slug },
      include: { currentVersion: true },
    });
    if (!ext) throw new ExtensionLifecycleError("not_found", 404, `no extension ${slug}`);
    return ext;
  }

  async function markFailed(slug: string, reason: string): Promise<void> {
    installedExtensionIds.delete(extensionServerId(slug));
    await prisma.extension.update({
      where: { id: slug },
      data: { status: "failed", failureReason: reason.slice(0, 1000), serviceTokenHash: null },
    });
  }

  async function install(slug: string, actor: ActivityActor, op: LifecycleOp = "install") {
    const ext = await load(slug);
    const v = ext.currentVersion;
    if (!v) throw new ExtensionLifecycleError("not_promoted", 409, `extension ${slug} has no signed version`);

    // 1. Re-verify the stored bytes, the recorded signer and key.
    let boxKey: { spkiDer: Uint8Array } | null = null;
    if (v.signer === "box") {
      try {
        const k = await identity.getExtensionPublicKey();
        boxKey = k ? { spkiDer: k.spkiDer } : null;
      } catch (err) {
        logger.warn({ err, slug }, "extension_key_unavailable");
        boxKey = null;
      }
    }
    const check = await verifyExtensionStatement({
      statement: v.statementBytes,
      signature: v.signature,
      manifest: v.manifestBytes,
      boxKey,
      recorded: { signer: v.signer, keyFingerprint: v.keyFingerprint },
    });
    if (!check.ok) {
      const reason = `${check.failureReason}: ${check.detail}`;
      await markFailed(slug, reason);
      await record(op, slug, actor, {
        severity: "warn",
        what: "Extension refused: its signed statement no longer verifies",
        refs: { version: v.version, failureReason: check.failureReason },
      });
      throw new ExtensionLifecycleError("verify_failed", 409, reason);
    }
    const manifest = check.manifest;

    // 2. Rotate the bearer BEFORE the start: the child may call back at once.
    const { token, hash } = mintExtensionToken();
    await prisma.extension.update({ where: { id: slug }, data: { serviceTokenHash: hash } });

    // 3. Start it.
    try {
      await sandbox.install(slug, {
        workspaceId: ext.workspaceId,
        version: v.version,
        commit: v.commit,
        tree: v.tree,
        runtime: manifest.runtime,
        entrypoint: manifest.entrypoint,
        memoryMb: manifest.resources.memoryMb,
        token,
        ...(deps.orchestratorUrl ? { orchestratorUrl: deps.orchestratorUrl } : {}),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await markFailed(slug, `install_failed: ${reason}`);
      await record(op, slug, actor, {
        severity: "warn",
        what: "Extension install failed",
        refs: { version: v.version, error: reason.slice(0, 300) },
      });
      if (err instanceof ExtensionSandboxError && err.code === "SUPERVISION_OFF") {
        throw new ExtensionLifecycleError("supervision_off", 503, reason);
      }
      throw new ExtensionLifecycleError("install_failed", 502, reason);
    }

    const row = await prisma.extension.update({
      where: { id: slug },
      data: { status: "installed", failureReason: null },
    });
    installedExtensionIds.add(extensionServerId(slug));
    await attach.attach(slug);
    await record(op, slug, actor, {
      what: op === "enable" ? "Extension enabled" : op === "reconcile" ? "Extension restarted" : "Extension installed",
      refs: { version: v.version, runtime: manifest.runtime, memoryMb: manifest.resources.memoryMb },
    });
    return row;
  }

  /**
   * Move `slug` from one of `from` to `to` in ONE statement (updateMany with
   * the status in the WHERE), so two tabs — or an owner and the reconciler —
   * cannot both pass a read-then-check. count 0 → 404 or 409 with the state
   * that won.
   */
  async function claim(
    slug: string,
    from: readonly ExtensionStatusName[],
    to: ExtensionStatusName,
    extra: { serviceTokenHash?: null } = {},
  ): Promise<void> {
    const u = await prisma.extension.updateMany({
      where: { id: slug, status: { in: [...from] } },
      data: { status: to, ...extra },
    });
    if (u.count === 0) {
      const ext = await load(slug);
      throw new ExtensionLifecycleError("wrong_state", 409, `extension ${slug} is ${ext.status}`);
    }
  }

  async function stopAndDetach(slug: string): Promise<void> {
    installedExtensionIds.delete(extensionServerId(slug));
    await attach.detach(slug);
  }

  return {
    install: (slug: string, actor: ActivityActor) => install(slug, actor, "install"),

    async enable(slug: string, actor: ActivityActor) {
      // Claimed to `signed` (not running yet) first: a second enable racing
      // this one finds `signed` and gets the 409.
      await claim(slug, ["disabled", "failed", "uninstalled"], "signed");
      return install(slug, actor, "enable");
    },

    async disable(slug: string, actor: ActivityActor) {
      await claim(slug, ["signed", "installed", "live", "failed"], "disabled", { serviceTokenHash: null });
      await stopAndDetach(slug);
      await sandbox.stop(slug);
      await record("disable", slug, actor, { what: "Extension disabled" });
      return load(slug);
    },

    async uninstall(slug: string, actor: ActivityActor) {
      await claim(slug, ["signed", "installed", "live", "failed", "disabled"], "uninstalled", {
        serviceTokenHash: null,
      });
      await stopAndDetach(slug);
      await sandbox.uninstall(slug);
      await record("uninstall", slug, actor, { severity: "warn", what: "Extension uninstalled" });
      return load(slug);
    },

    /** installedExtensionIds := the rows that should be running. */
    async refreshInstalledIds(): Promise<void> {
      const rows = await prisma.extension.findMany({
        where: { status: { in: [...RUNNING_EXTENSION_STATUSES] } },
        select: { id: true },
      });
      installedExtensionIds.clear();
      for (const r of rows) installedExtensionIds.add(extensionServerId(r.id));
    },

    /**
     * Reinstall every extension that should be running and is not: after a
     * sandbox restart the sandbox forgets every process. Each restart goes
     * through install(): re-verify, rotate the bearer, start. No rows → no
     * sandbox call at all.
     */
    async reconcile(): Promise<ReconcileReport> {
      const rows = await prisma.extension.findMany({
        where: { status: { in: [...RUNNING_EXTENSION_STATUSES] } },
        select: { id: true },
      });
      const report: ReconcileReport = { checked: rows.length, restarted: [], failed: [] };
      for (const { id } of rows) {
        let running = false;
        try {
          running = (await sandbox.status(id))?.running === true;
        } catch (err) {
          if (err instanceof ExtensionSandboxError && err.code === "SUPERVISION_OFF") {
            return { ...report, skipped: "supervision_off" };
          }
          logger.warn({ err, slug: id }, "extension_reconcile_status_failed");
          continue;
        }
        if (running) {
          installedExtensionIds.add(extensionServerId(id));
          continue;
        }
        try {
          await install(id, SYSTEM_ACTOR, "reconcile");
          report.restarted.push(id);
        } catch (err) {
          logger.warn({ err, slug: id }, "extension_reconcile_restart_failed");
          report.failed.push(id);
        }
      }
      return report;
    },
  };
}

export type ExtensionLifecycle = ReturnType<typeof createExtensionLifecycle>;

/** Bare tool names every OTHER extension's current version provides. */
export async function otherExtensionTools(
  prisma: PrismaClient,
  slug: string,
): Promise<Map<string, string>> {
  const rows = await prisma.extension.findMany({
    where: { id: { not: slug }, status: { not: "uninstalled" } },
    select: { id: true, currentVersion: { select: { manifestBytes: true } } },
  });
  const out = new Map<string, string>();
  for (const r of rows) {
    if (!r.currentVersion) continue;
    const parsed = parseExtensionManifest(r.currentVersion.manifestBytes);
    if (!parsed.ok) continue;
    for (const t of parsed.manifest.provides.tools) out.set(t.name, extensionServerId(r.id));
  }
  return out;
}
