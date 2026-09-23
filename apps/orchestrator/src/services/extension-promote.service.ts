/**
 * WARP-2900 (ADR-056 slice H2): the owner's two-phase promote of a workshop
 * proposal into a signed, installed extension.
 *
 *   PHASE 1 — POST /api/extensions/:workspaceId/promote {}
 *     Reads the proposal the workspace last tagged (proposal/<version>)
 *     FROM THE BARE REPOSITORY via the sandbox: commit, tree, and the
 *     manifest bytes exactly as committed. Parses them under the strict
 *     schema, runs preflight, and answers 202 with a single-use confirmation
 *     token (5 minutes) bound to (owner, workspace, tag, commit,
 *     manifestSha256), the readback and the preflight. Nothing is signed.
 *
 *   PHASE 2 — POST … { confirmationToken, manifestSha256, operatorDomain? }
 *     The echoed digest must be the one the token was issued for
 *     (TOKEN_OPERATION_MISMATCH, 409), and the proposal is read AGAIN: if the
 *     bytes or the commit moved since phase 1, 409 `manifest_changed` and the
 *     owner starts over. Preflight runs AGAIN against the box as it is now:
 *     another proposal confirmed in between may have taken a tool name or
 *     the memory (409 `preflight_changed`). Then: sign (extension-promotion.service.ts, the one
 *     signer caller; an unprovisioned or unreachable sidecar is 503
 *     device_identity_svc_unreachable and NOTHING is stored) → persist the
 *     statement exactly as signed → install (which re-verifies the stored
 *     bytes first).
 *
 * The readback the owner confirms is derived from provides / resources /
 * egress only (deriveReadback). The manifest's `summary` and every
 * `description` are the author's words and never feed it.
 *
 * The confirmation store is in memory, per router: a restart drops pending
 * confirmations, which only costs the owner a repeat of phase 1.
 */
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { TOOL_DOMAINS } from "@droplet/tools-core";
import type { ActivityActor } from "./activity.service.js";
import {
  deriveExtensionSlug,
  deriveReadback,
  EXTENSION_VERSION_PATTERN,
  manifestSha256,
  parseExtensionManifest,
  type ExtensionManifest,
  type ExtensionReadback,
} from "./extension-manifest.js";
import {
  ExtensionPromotionRefusedError,
  ExtensionSigningUnavailableError,
  signPromotedExtension,
  type ExtensionSigningIdentity,
} from "./extension-promotion.service.js";
import {
  ExtensionSandboxError,
  type ExtensionSandboxClient,
  type ProposalManifest,
} from "./extension-sandbox.client.js";
import {
  EXTENSION_TICKET,
  ExtensionLifecycleError,
  preflightAgainstBox,
  type ExtensionLifecycle,
  type PreflightResult,
} from "./extension-lifecycle.service.js";
import type { RecordParams } from "./activity.service.js";
import { recordActivity } from "./activity.singleton.js";

export const PROMOTE_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const PROPOSAL_TAG_PREFIX = "proposal/";
/**
 * Slugs a route already owns: H3's self-routes and the proposals list here,
 * and the sandbox's GET /extensions/budget, which is declared before
 * GET /extensions/{slug} — an extension called `budget` would read the
 * budget as its status (never `running`) and be reinstalled every tick.
 */
export const RESERVED_EXTENSION_SLUGS: ReadonlySet<string> = new Set(["self", "proposals", "budget"]);

/** A failure a route turns into `status` + `{ error: code, ... }`. */
export class PromoteError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PromoteError";
  }
}

// ─── the confirmation store ──────────────────────────────────────────────

export interface PendingPromotion {
  token: string;
  userId: string;
  workspaceId: string;
  tag: string;
  version: string;
  commit: string;
  manifestSha256: string;
  expiresAt: number;
}

export type ConfirmationRefusal =
  | "TOKEN_MISSING"
  | "TOKEN_EXPIRED"
  | "TOKEN_USER_MISMATCH"
  | "TOKEN_OPERATION_MISMATCH";

const REFUSAL_STATUS: Record<ConfirmationRefusal, number> = {
  TOKEN_MISSING: 410,
  TOKEN_EXPIRED: 410,
  TOKEN_USER_MISMATCH: 403,
  TOKEN_OPERATION_MISMATCH: 409,
};

export function createPromoteConfirmationStore(
  opts: { ttlMs?: number; now?: () => number } = {},
) {
  const ttlMs = opts.ttlMs ?? PROMOTE_CONFIRMATION_TTL_MS;
  const now = opts.now ?? Date.now;
  const pending = new Map<string, PendingPromotion>();

  function sweep(): void {
    const t = now();
    for (const [k, v] of pending) if (v.expiresAt <= t) pending.delete(k);
  }

  return {
    issue(p: Omit<PendingPromotion, "token" | "expiresAt">): PendingPromotion {
      sweep();
      const entry: PendingPromotion = {
        ...p,
        token: randomBytes(24).toString("base64url"),
        expiresAt: now() + ttlMs,
      };
      pending.set(entry.token, entry);
      return entry;
    },
    /**
     * Check a phase-2 echo and, when it matches, TAKE the token in the same
     * tick (no await between the lookup and the delete): a double-click or a
     * retried POST finds it gone (410) and never reaches the signer. A
     * mismatch leaves the token for its rightful confirmer.
     */
    take(
      token: string,
      echo: { userId: string; workspaceId: string; manifestSha256: string },
    ): { ok: true; pending: PendingPromotion } | { ok: false; code: ConfirmationRefusal } {
      const p = pending.get(token);
      if (!p) return { ok: false, code: "TOKEN_MISSING" };
      if (p.expiresAt <= now()) {
        pending.delete(token);
        return { ok: false, code: "TOKEN_EXPIRED" };
      }
      if (p.userId !== echo.userId) return { ok: false, code: "TOKEN_USER_MISMATCH" };
      if (p.workspaceId !== echo.workspaceId || p.manifestSha256 !== echo.manifestSha256) {
        return { ok: false, code: "TOKEN_OPERATION_MISMATCH" };
      }
      pending.delete(token);
      return { ok: true, pending: p };
    },
    size(): number {
      return pending.size;
    },
  };
}

export type PromoteConfirmationStore = ReturnType<typeof createPromoteConfirmationStore>;

// ─── the two phases ──────────────────────────────────────────────────────

export interface PromoteDeps {
  prisma: PrismaClient;
  sandbox: ExtensionSandboxClient;
  identity: ExtensionSigningIdentity;
  lifecycle: ExtensionLifecycle;
  confirmations: PromoteConfirmationStore;
  audit?: (params: RecordParams) => Promise<unknown>;
}

export interface PromoteOwner {
  id: string;
  actor: ActivityActor;
}

export interface PromotePhase1 {
  confirmationToken: string;
  expiresAt: string;
  workspaceId: string;
  slug: string;
  tag: string;
  version: string;
  commit: string;
  manifestSha256: string;
  readback: ExtensionReadback;
  preflight: PreflightResult;
}

function sandboxFailure(err: unknown): never {
  if (err instanceof ExtensionSandboxError) {
    const code = err.code === "SUPERVISION_OFF" ? "extensions_disabled" : "sandbox_error";
    throw new PromoteError(err.code === "SANDBOX_ERROR" && err.status < 500 ? err.status : 503, code, err.message);
  }
  throw err;
}

async function readProposal(deps: PromoteDeps, workspaceId: string) {
  const ws = await deps.prisma.workshopWorkspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, proposedTag: true },
  });
  if (!ws) throw new PromoteError(404, "not_found", `no workspace ${workspaceId}`);
  const tag = ws.proposedTag;
  if (!tag || !tag.startsWith(PROPOSAL_TAG_PREFIX)) {
    throw new PromoteError(409, "not_proposed", "this workspace has no proposal to promote");
  }
  const version = tag.slice(PROPOSAL_TAG_PREFIX.length);
  if (!EXTENSION_VERSION_PATTERN.test(version)) {
    throw new PromoteError(409, "not_proposed", `the proposal tag ${tag} is not proposal/<semver>`);
  }
  let proposal: ProposalManifest;
  try {
    proposal = await deps.sandbox.proposalManifest(workspaceId, version);
  } catch (err) {
    sandboxFailure(err);
  }
  if (proposal.manifest === null) {
    // A connector draft (WARP-2899) or a tag with no manifest: not an
    // extension, so there is nothing to sign.
    throw new PromoteError(409, "not_promotable", `${tag} carries no extension-manifest.json`);
  }
  return { tag, version, proposal, manifestBytes: proposal.manifest };
}

/**
 * Phase 2's preflight → sign → store section runs one at a time in this
 * process (the orchestrator is one process per box). Promotions are rare and
 * owner-driven, so a queue costs nothing a person would notice.
 */
let promoteQueue: Promise<unknown> = Promise.resolve();

function promoteExclusively<T>(fn: () => Promise<T>): Promise<T> {
  const run = promoteQueue.then(fn);
  // A refused or failed promotion must not wedge the ones behind it.
  promoteQueue = run.catch(() => undefined);
  return run;
}

/** Memory this slug's running version holds (a reinstall frees it). */
async function runningMemoryMb(deps: PromoteDeps, slug: string): Promise<number> {
  const existing = await deps.prisma.extension.findUnique({
    where: { id: slug },
    select: { status: true, currentVersion: { select: { manifestBytes: true } } },
  });
  if (!existing?.currentVersion || (existing.status !== "installed" && existing.status !== "live")) return 0;
  const cur = parseExtensionManifest(existing.currentVersion.manifestBytes);
  return cur.ok ? cur.manifest.resources.memoryMb : 0;
}

async function preflightNow(deps: PromoteDeps, slug: string, manifest: ExtensionManifest): Promise<PreflightResult> {
  try {
    return await preflightAgainstBox(deps.prisma, deps.sandbox, slug, manifest, await runningMemoryMb(deps, slug));
  } catch (err) {
    sandboxFailure(err);
  }
}

export async function preparePromotion(
  deps: PromoteDeps,
  owner: PromoteOwner,
  workspaceId: string,
): Promise<PromotePhase1> {
  const { tag, version, proposal, manifestBytes } = await readProposal(deps, workspaceId);
  const slug = deriveExtensionSlug(workspaceId);
  if (RESERVED_EXTENSION_SLUGS.has(slug)) {
    throw new PromoteError(409, "slug_reserved", `"${slug}" cannot be an extension id; rename the workspace`);
  }
  const existing = await deps.prisma.extension.findUnique({
    where: { id: slug },
    select: { workspaceId: true },
  });
  if (existing && existing.workspaceId !== workspaceId) {
    throw new PromoteError(409, "slug_taken", `extension id ${slug} already belongs to another workspace`);
  }
  const already = await deps.prisma.extensionVersion.findUnique({
    where: { extensionId_version: { extensionId: slug, version } },
    select: { id: true },
  });
  if (already) {
    throw new PromoteError(409, "already_promoted", `${slug}@${version} is already promoted; propose a new version`);
  }

  const parsed = parseExtensionManifest(manifestBytes);
  if (!parsed.ok) {
    throw new PromoteError(422, "manifest_invalid", parsed.detail);
  }
  if (parsed.manifest.id !== workspaceId || parsed.manifest.version !== version) {
    throw new PromoteError(
      422,
      "manifest_invalid",
      `the manifest is ${parsed.manifest.id}@${parsed.manifest.version}, the proposal is ${workspaceId}@${version}`,
    );
  }
  const readback = deriveReadback(parsed.manifest);

  const preflight = await preflightNow(deps, slug, parsed.manifest);
  if (!preflight.ok) {
    throw new PromoteError(422, "preflight_blocked", preflight.blocking.map((b) => b.detail).join("; "), {
      preflight,
      readback,
    });
  }

  const digest = manifestSha256(manifestBytes);
  const pending = deps.confirmations.issue({
    userId: owner.id,
    workspaceId,
    tag,
    version,
    commit: proposal.commit,
    manifestSha256: digest,
  });
  return {
    confirmationToken: pending.token,
    expiresAt: new Date(pending.expiresAt).toISOString(),
    workspaceId,
    slug,
    tag,
    version,
    commit: proposal.commit,
    manifestSha256: digest,
    readback,
    preflight,
  };
}

export interface PromotePhase2Input {
  confirmationToken: string;
  manifestSha256: string;
  operatorDomain?: string | null;
}

export async function confirmPromotion(
  deps: PromoteDeps,
  owner: PromoteOwner,
  workspaceId: string,
  input: PromotePhase2Input,
) {
  const audit = deps.audit ?? recordActivity;
  const checked = deps.confirmations.take(input.confirmationToken, {
    userId: owner.id,
    workspaceId,
    manifestSha256: input.manifestSha256,
  });
  if (!checked.ok) {
    throw new PromoteError(REFUSAL_STATUS[checked.code], checked.code, "the confirmation does not match a pending promotion");
  }
  const pending = checked.pending;
  if (input.operatorDomain != null && !(TOOL_DOMAINS as readonly string[]).includes(input.operatorDomain)) {
    throw new PromoteError(400, "invalid_domain", `operatorDomain must be one of ${TOOL_DOMAINS.join(", ")}`);
  }

  // The bytes the owner saw must be the bytes that get signed.
  const { tag, version, proposal, manifestBytes } = await readProposal(deps, workspaceId);
  if (
    tag !== pending.tag ||
    proposal.commit !== pending.commit ||
    manifestSha256(manifestBytes) !== pending.manifestSha256
  ) {
    throw new PromoteError(409, "manifest_changed", "the proposal changed since you reviewed it; review it again");
  }
  // Preflight, sign and store run one promotion at a time: two confirms
  // of different proposals that provide one tool name cannot both pass
  // preflight before either is stored.
  const { signed, slug } = await promoteExclusively(async () => {
    // What phase 1 checked may no longer hold: another proposal confirmed in
    // between can have taken a tool name or the memory.
    const reparsed = parseExtensionManifest(manifestBytes);
    if (!reparsed.ok) throw new PromoteError(422, "manifest_invalid", reparsed.detail);
    const preflight = await preflightNow(deps, deriveExtensionSlug(workspaceId), reparsed.manifest);
    if (!preflight.ok) {
      throw new PromoteError(
        409,
        "preflight_changed",
        `the box changed since you reviewed it: ${preflight.blocking.map((b) => b.detail).join("; ")}`,
        { preflight },
      );
    }

    let signed;
    try {
      signed = await signPromotedExtension(deps.identity, {
        workspaceId,
        version,
        commit: proposal.commit,
        tree: proposal.tree,
        manifestBytes,
      });
    } catch (err) {
      if (err instanceof ExtensionSigningUnavailableError) {
        throw new PromoteError(503, err.code, err.message);
      }
      if (err instanceof ExtensionPromotionRefusedError) {
        throw new PromoteError(422, err.code, err.message);
      }
      throw err;
    }

    const slug = signed.statement.extensionId;
    try {
      await deps.prisma.$transaction(async (tx) => {
        const ext = await tx.extension.upsert({
          where: { id: slug },
          create: {
            id: slug,
            workspaceId,
            name: signed.manifest.name,
            installedByUserId: owner.id,
            status: "signed",
            operatorDomain: input.operatorDomain ?? null,
          },
          update: {
            name: signed.manifest.name,
            installedByUserId: owner.id,
            status: "signed",
            failureReason: null,
            ...(input.operatorDomain != null ? { operatorDomain: input.operatorDomain } : {}),
          },
        });
        // Phase 1 checked the slug; re-check inside the write, so two
        // workspaces whose ids hash to one slug cannot both sign under it
        // (the upsert's update would otherwise adopt the other's row).
        if (ext.workspaceId !== workspaceId) {
          throw new PromoteError(409, "slug_taken", `extension id ${slug} already belongs to another workspace`);
        }
        const row = await tx.extensionVersion.create({
          data: {
            extensionId: slug,
            version,
            tag,
            commit: signed.statement.commit,
            tree: signed.statement.tree,
            manifestBytes: Buffer.from(manifestBytes),
            manifestSha256: signed.statement.manifestSha256,
            statementBytes: signed.statementBytes,
            signature: signed.signature,
            signer: signed.signer,
            keyFingerprint: signed.keyFingerprint,
            promotedByUserId: owner.id,
          },
          select: { id: true },
        });
        await tx.extension.update({ where: { id: slug }, data: { currentVersionId: row.id } });
      });
    } catch (err) {
      // Prisma's unique violation (the (extensionId, version) pair, or a slug
      // another workspace won in a race): never a second signed row.
      if ((err as { code?: unknown } | null)?.code === "P2002") {
        throw new PromoteError(409, "already_promoted", `${slug}@${version} is already promoted`);
      }
      throw err;
    }
    return { signed, slug };
  });

  await audit({
    kind: "tool_run",
    severity: "warn",
    sourceIcon: "puzzle",
    what: "Extension promoted and signed",
    sub: `${signed.manifest.name} ${version}`,
    actor: owner.actor,
    refs: {
      extensionId: slug,
      op: "promote",
      ticket: EXTENSION_TICKET,
      workspaceId,
      version,
      commit: signed.statement.commit,
      signer: signed.signer,
      keyFingerprint: signed.keyFingerprint,
    },
  });

  let installError: { code: string; message: string } | null = null;
  try {
    await deps.lifecycle.install(slug, owner.actor);
  } catch (err) {
    if (!(err instanceof ExtensionLifecycleError)) throw err;
    installError = { code: err.code, message: err.message };
  }
  const extension = await deps.prisma.extension.findUnique({ where: { id: slug } });
  return {
    extension,
    version,
    readback: signed.readback,
    installed: installError === null,
    installError,
  };
}
