/** WARP-3535 development feed persistence and sync. */
import { createHash } from "node:crypto";
import type { PrismaClient, PmExternalProvider, PmExternalLinkKind, PmExternalLinkState } from "@prisma/client";
import {
  RestCredentialRejectedError,
  RestRateLimitedError,
  RestVendorError,
  type DevelopmentFeedName,
  type DevelopmentItem,
  type DevRepositoryItem,
} from "@droplet/erp-connector";
import { cloudMaterialFromRow, connectorForProvider, type CloudConnectionRow } from "../erp-provider.js";
import { createDevelopmentFetch, DevelopmentEgressBlockedError, DevelopmentConnectionChangedError } from "./pm-dev-egress.js";
import { matchedSequences } from "./pm-dev-match.js";
import { writeActivity } from "./pm.service.js";
import { POLLABLE_CONNECTION_STATUSES } from "../erp-sync/cursor.service.js";

type Provider = "github" | "gitlab";
type DevConnector = ReturnType<typeof connectorForProvider> & {
  readDevelopment(input: { feed: DevelopmentFeedName; repo?: string; repoWebUrl?: string; etag?: string | null; cutoff?: Date }): Promise<{
    status: "ok" | "not_modified"; items: DevelopmentItem[]; etag: string | null; truncated: boolean;
    skipped: number; rateLimit: { limit: number | null; remaining: number | null; resetAt: Date | null } | null;
  }>;
};

const PROVIDER: Record<Provider, PmExternalProvider> = { github: "GITHUB", gitlab: "GITLAB" };
const ERROR_COPY = {
  credential: "The integration needs to be reconnected.",
  inaccessible: "The credential cannot read this repository.",
  transient: "The code host could not be reached. Retrying automatically.",
  configuration: "The integration is not configured for development feeds.",
} as const;

function parseProvider(raw: string): Provider {
  if (raw === "github" || raw === "gitlab") return raw;
  throw new Error("provider_not_supported");
}

function safeUrl(raw: string, provider: Provider): string {
  const url = new URL(raw);
  const host = provider === "github" ? "github.com" : "gitlab.com";
  if (url.protocol !== "https:" || url.hostname !== host || url.username || url.password) throw new Error("unsafe_vendor_url");
  return url.toString();
}

function connectionSeal(enc: string): string {
  return createHash("sha256").update(enc).digest("hex").slice(0, 16);
}

async function connectionFor(prisma: PrismaClient, provider: Provider) {
  const row = await prisma.integrationConnection.findFirst({
    where: { provider, status: { in: [...POLLABLE_CONNECTION_STATUSES, "NEEDS_RECONNECT"] }, providerTokensEnc: { not: null } },
    orderBy: { updatedAt: "desc" },
    select: { id: true, provider: true, providerConfig: true, providerTokensEnc: true, status: true },
  });
  return row?.providerTokensEnc ? row : null;
}

async function connectorFor(prisma: PrismaClient, provider: Provider): Promise<{ connector: DevConnector; seal: string; egress: ReturnType<typeof createDevelopmentFetch> }> {
  const row = await connectionFor(prisma, provider);
  if (!row?.providerTokensEnc) throw new Error("integration_not_connected");
  const configuration = JSON.stringify(row.providerConfig);
  const guardedFetch = createDevelopmentFetch(prisma, {
    connectionCurrent: async () => {
      const current = await prisma.integrationConnection.findUnique({ where: { id: row.id }, select: { provider: true, providerTokensEnc: true, providerConfig: true, status: true } });
      return !!current && current.provider === provider && POLLABLE_CONNECTION_STATUSES.includes(current.status as typeof POLLABLE_CONNECTION_STATUSES[number])
        && current.providerTokensEnc === row.providerTokensEnc && JSON.stringify(current.providerConfig) === configuration;
    },
  });
  const selector = {
    provider,
    host: provider === "github" ? "api.github.com" : "gitlab.com",
    ...cloudMaterialFromRow(row as CloudConnectionRow),
    fetchImpl: guardedFetch.fetch,
  };
  return { connector: connectorForProvider(selector) as DevConnector, seal: connectionSeal(row.providerTokensEnc), egress: guardedFetch };
}

async function readDevelopment(
  connector: DevConnector,
  egress: ReturnType<typeof createDevelopmentFetch>,
  request: Parameters<DevConnector["readDevelopment"]>[0],
) {
  try { return await connector.readDevelopment(request); }
  catch (err) {
    if (egress.connectionChanged) throw new DevelopmentConnectionChangedError();
    if (egress.blocked) throw new DevelopmentEgressBlockedError(egress.blocked);
    throw err;
  }
}

function asPrismaProvider(provider: Provider): PmExternalProvider { return PROVIDER[provider]; }

export async function listDevelopmentRepositories(prisma: PrismaClient, rawProvider: string) {
  const provider = parseProvider(rawProvider);
  const { connector, egress } = await connectorFor(prisma, provider);
  return readDevelopment(connector, egress, { feed: "repositories" });
}

export async function connectDevelopmentRepository(
  prisma: PrismaClient,
  rawProvider: string,
  input: { externalId: string; apiRef: string; projectIds: string[] },
  actorId: string,
) {
  const provider = parseProvider(rawProvider);
  const { connector, egress } = await connectorFor(prisma, provider);
  const result = await readDevelopment(connector, egress, { feed: "repository", repo: input.apiRef });
  const repo = result.items[0];
  if (!repo || repo.type !== "repository" || repo.externalId !== input.externalId) throw new Error("repository_not_found");
  const checkedUrl = safeUrl(repo.webUrl, provider);
  const projects = await prisma.pmProject.findMany({ where: { id: { in: input.projectIds }, kind: "PROJECT" }, select: { id: true } });
  if (projects.length !== new Set(input.projectIds).size) throw new Error("project_not_found");
  const saved = await prisma.$transaction(async (tx) => {
    const row = await tx.pmDevRepository.upsert({
      where: { provider_externalId: { provider: asPrismaProvider(provider), externalId: repo.externalId } },
      create: {
        provider: asPrismaProvider(provider), externalId: repo.externalId, apiRef: repo.apiRef,
        fullName: repo.fullName, webUrl: checkedUrl, defaultBranch: repo.defaultBranch,
        status: "PENDING", nextSyncAt: new Date(), createdById: actorId,
      },
      update: { apiRef: repo.apiRef, fullName: repo.fullName, webUrl: checkedUrl, defaultBranch: repo.defaultBranch, status: "PENDING", nextSyncAt: new Date() },
    });
    // Adding a mapping must preserve any other project mappings and their
    // optional state rules. Removal has its own explicit DELETE route.
    if (input.projectIds.length) await tx.pmDevRepositoryProject.createMany({
      data: [...new Set(input.projectIds)].map((projectId) => ({ repositoryId: row.id, projectId })),
      skipDuplicates: true,
    });
    return row;
  });
  return saved;
}

export async function mapDevelopmentRepository(
  prisma: PrismaClient,
  repositoryId: string,
  projectId: string,
  rules: { onOpenedStateId?: string | null; onMergedStateId?: string | null },
) {
  const project = await prisma.pmProject.findFirst({ where: { id: projectId, kind: "PROJECT" }, select: { id: true } });
  if (!project) throw new Error("project_not_found");
  for (const stateId of [rules.onOpenedStateId, rules.onMergedStateId]) {
    if (stateId && !(await prisma.pmState.findFirst({ where: { id: stateId, projectId }, select: { id: true } }))) throw new Error("state_not_found");
  }
  return prisma.pmDevRepositoryProject.upsert({
    where: { repositoryId_projectId: { repositoryId, projectId } },
    create: { repositoryId, projectId, onOpenedStateId: rules.onOpenedStateId ?? null, onMergedStateId: rules.onMergedStateId ?? null },
    update: { onOpenedStateId: rules.onOpenedStateId ?? null, onMergedStateId: rules.onMergedStateId ?? null },
  });
}

export async function listConfiguredDevelopmentRepositories(prisma: PrismaClient) {
  return prisma.pmDevRepository.findMany({
    select: {
      id: true, provider: true, externalId: true, apiRef: true, fullName: true, webUrl: true, defaultBranch: true,
      status: true, lastSyncedAt: true, lastAttemptAt: true, nextSyncAt: true, lastError: true, consecutiveFailures: true,
      projects: { select: { projectId: true, onOpenedStateId: true, onMergedStateId: true, project: { select: { id: true, name: true, identifier: true } } } },
    },
    orderBy: [{ provider: "asc" }, { fullName: "asc" }],
  });
}

export async function removeDevelopmentRepository(prisma: PrismaClient, id: string) {
  await prisma.pmDevRepository.delete({ where: { id } });
}

function syncState(item: Extract<DevelopmentItem, { type: "pull_request" }>): PmExternalLinkState {
  return item.state;
}

async function upsertLink(
  prisma: PrismaClient,
  repositoryId: string,
  provider: PmExternalProvider,
  item: DevelopmentItem,
  repositoryExternalId: string,
  project: { id: string; identifier: string },
  mappings: Array<{ projectId: string; onOpenedStateId: string | null; onMergedStateId: string | null }>,
) {
  let kind: PmExternalLinkKind;
  let externalId: string;
  let url: string;
  let title: string;
  let state: PmExternalLinkState;
  let author: string | null = null;
  let ref: string | null = null;
  let number: number | null = null;
  let updatedAt: Date;
  const texts: string[] = [];
  if (item.type === "pull_request") {
    kind = "PULL_REQUEST"; externalId = item.externalId; url = item.url; title = item.title; state = syncState(item);
    author = item.author; ref = item.branch; number = item.number; updatedAt = item.updatedAt; texts.push(item.title, item.body ?? "", item.branch ?? "");
  } else if (item.type === "commit") {
    kind = "COMMIT"; externalId = item.externalId; url = item.url; title = item.title; state = "MERGED";
    author = item.author; ref = item.externalId.slice(0, 12); updatedAt = item.committedAt; texts.push(item.message);
  } else if (item.type === "branch") {
    kind = "BRANCH"; externalId = `${repositoryExternalId}:${item.name}`; url = item.url; title = item.name; state = "OPEN";
    ref = item.name; updatedAt = new Date(); texts.push(item.name);
  } else return;
  try { safeUrl(url, provider === "GITHUB" ? "github" : "gitlab"); } catch { return; }
  const sequences = matchedSequences(project.identifier, texts);
  if (!sequences.length) return;
  for (const sequenceId of sequences) {
    const workItem = await prisma.pmWorkItem.findFirst({ where: { projectId: project.id, sequenceId, project: { kind: "PROJECT" } }, select: { id: true, stateId: true } });
    if (!workItem) continue;
    const mapping = mappings.find((row) => row.projectId === project.id);
    const targetState = kind === "PULL_REQUEST" && (state === "OPEN" || state === "MERGED")
      ? (state === "OPEN" ? mapping?.onOpenedStateId : mapping?.onMergedStateId) : null;
    await prisma.$transaction(async (tx) => {
      const unique = { provider_kind_externalId_workItemId: { provider, kind, externalId, workItemId: workItem.id } };
      const existing = await tx.pmExternalLink.findUnique({ where: unique, select: { id: true, state: true } });
      await tx.pmExternalLink.upsert({
        where: unique,
        create: { workItemId: workItem.id, repositoryId, provider, kind, externalId, url, title, state, author, ref, number, externalUpdatedAt: updatedAt },
        update: { repositoryId, url, title, state, author, ref, number, externalUpdatedAt: updatedAt },
      });
      if (!existing) await writeActivity(tx, { workItemId: workItem.id, actorId: null, verb: "external_link_added", field: provider.toLowerCase(), newValue: `${kind}:${title.slice(0, 180)}` });
      if (targetState && (!existing || existing.state !== state)) {
        const oldItem = await tx.pmWorkItem.findFirst({ where: { id: workItem.id, project: { kind: "PROJECT" } }, select: { stateId: true, completedAt: true, isCompleted: true } });
        const [oldState, newState] = oldItem?.stateId ? await Promise.all([
          tx.pmState.findUnique({ where: { id: oldItem.stateId }, select: { name: true } }),
          tx.pmState.findFirst({ where: { id: targetState, projectId: project.id }, select: { name: true, group: true } }),
        ]) : [null, await tx.pmState.findFirst({ where: { id: targetState, projectId: project.id }, select: { name: true, group: true } })];
        if (oldItem && newState && oldItem.stateId !== targetState) {
          const completed = newState.group === "completed" || newState.group === "cancelled";
          const changed = await tx.pmWorkItem.updateMany({ where: { id: workItem.id, stateId: oldItem.stateId, project: { kind: "PROJECT" } }, data: {
            stateId: targetState,
            isCompleted: completed,
            completedAt: completed ? (oldItem.completedAt ?? new Date()) : null,
          } });
          if (changed.count) await writeActivity(tx, { workItemId: workItem.id, actorId: null, verb: "state_changed", field: "state", oldValue: oldState?.name ?? oldItem.stateId, newValue: newState.name });
        }
      }
    });
  }
}

async function pollFeed(
  connector: DevConnector, egress: ReturnType<typeof createDevelopmentFetch>, repo: { id: string; apiRef: string; webUrl: string; openPrsEtag: string | null; recentPrsEtag: string | null; commitsEtag: string | null; branchesEtag: string | null },
  feed: DevelopmentFeedName, etag: string | null, cutoff?: Date,
) {
  return readDevelopment(connector, egress, { feed, repo: repo.apiRef, repoWebUrl: repo.webUrl, etag, cutoff });
}

async function syncOne(prisma: PrismaClient, row: Awaited<ReturnType<typeof prisma.pmDevRepository.findUniqueOrThrow>>) {
  const provider: Provider = row.provider === "GITHUB" ? "github" : "gitlab";
  const now = new Date();
  const base = { lastAttemptAt: now };
  let connection: Awaited<ReturnType<typeof connectionFor>>;
  let activeEgress: ReturnType<typeof createDevelopmentFetch> | null = null;
  try { connection = await connectionFor(prisma, provider); }
  catch { connection = null; }
  if (!connection?.providerTokensEnc) {
    const stored = await prisma.integrationConnection.findFirst({ where: { provider }, orderBy: { updatedAt: "desc" }, select: { status: true, providerTokensEnc: true } });
    const disconnected = !stored || stored.status === "DISABLED" || stored.status === "NOT_CONFIGURED";
    await prisma.pmDevRepository.update({ where: { id: row.id }, data: disconnected
      ? { ...base, status: "DISCONNECTED", lastError: null, nextSyncAt: new Date(now.getTime() + 5 * 60_000) }
      : { ...base, status: "NEEDS_RECONNECT", lastError: ERROR_COPY.credential } });
    return;
  }
  let seal = connectionSeal(connection.providerTokensEnc);
  if (row.status === "DISCONNECTED") {
    await prisma.pmDevRepository.update({ where: { id: row.id }, data: { ...base, status: "PENDING", lastError: null, nextSyncAt: now } });
  }
  if (row.status === "NEEDS_RECONNECT" && row.credentialSeal === seal) return;
  try {
    const { connector, seal: attemptedSeal, egress } = await connectorFor(prisma, provider);
    seal = attemptedSeal;
    activeEgress = egress;
    const recentSince = new Date(now.getTime() - 90 * 24 * 60 * 60_000);
    const outputs = await Promise.all([
      pollFeed(connector, egress, row, "pullRequestsOpen", row.openPrsEtag),
      pollFeed(connector, egress, row, "pullRequestsRecent", row.recentPrsEtag, recentSince),
      pollFeed(connector, egress, row, "commits", row.commitsEtag, recentSince),
      pollFeed(connector, egress, row, "branches", row.branchesEtag),
    ]);
    const latestCredential = await connectionFor(prisma, provider);
    if (!latestCredential?.providerTokensEnc) {
      await prisma.pmDevRepository.update({ where: { id: row.id }, data: { ...base, status: "DISCONNECTED", lastError: null, nextSyncAt: new Date(now.getTime() + 24 * 60 * 60_000) } });
      return;
    }
    if (connectionSeal(latestCredential.providerTokensEnc) !== attemptedSeal) {
      await prisma.pmDevRepository.update({ where: { id: row.id }, data: { ...base, status: "PENDING", lastError: null, nextSyncAt: now } });
      return;
    }
    const [openPrs, recentPrs, commits, branches] = outputs;
    const mappings = await prisma.pmDevRepositoryProject.findMany({ where: { repositoryId: row.id }, include: { project: { select: { id: true, identifier: true, kind: true } } } });
    const validMappings = mappings.filter((m) => m.project.kind === "PROJECT");
    for (const result of outputs) for (const item of result.items) for (const mapping of validMappings) await upsertLink(prisma, row.id, asPrismaProvider(provider), item, row.externalId, mapping.project, mappings);
    // Only a complete branch inventory is evidence that a prior branch disappeared.
    if (branches.status === "ok" && !branches.truncated) {
      const present = new Set(branches.items.filter((item) => item.type === "branch").map((item) => `${row.externalId}:${item.name}`));
      const oldBranches = await prisma.pmExternalLink.findMany({ where: { repositoryId: row.id, kind: "BRANCH", state: "OPEN" }, select: { id: true, externalId: true } });
      for (const old of oldBranches) if (!present.has(old.externalId)) await prisma.pmExternalLink.update({ where: { id: old.id }, data: { state: "CLOSED" } });
    }
    const anyTruncated = outputs.some((output) => output.truncated);
    const rate = outputs.map((output) => output.rateLimit).find((snapshot) => snapshot?.remaining === 0);
    await prisma.pmDevRepository.update({ where: { id: row.id }, data: {
      ...base, status: rate ? "RATE_LIMITED" : "OK", lastSyncedAt: now, lastError: null,
      consecutiveFailures: 0, credentialSeal: attemptedSeal,
      nextSyncAt: rate?.resetAt ?? new Date(now.getTime() + (anyTruncated ? 2 * 60_000 : 5 * 60_000)),
      // A first-page ETag cannot prove a capped multi-page inventory unchanged.
      openPrsEtag: openPrs.truncated ? null : openPrs.etag, recentPrsEtag: recentPrs.truncated ? null : recentPrs.etag,
      commitsEtag: commits.truncated ? null : commits.etag, branchesEtag: branches.truncated ? null : branches.etag,
    } });
  } catch (err) {
    const latest = await connectionFor(prisma, provider).catch(() => null);
    if (err instanceof DevelopmentConnectionChangedError) {
      await prisma.pmDevRepository.update({ where: { id: row.id }, data: { ...base, status: latest?.providerTokensEnc ? "PENDING" : "DISCONNECTED", lastError: null, nextSyncAt: new Date(now.getTime() + 5 * 60_000) } });
      return;
    }
    if (latest?.providerTokensEnc && connectionSeal(latest.providerTokensEnc) !== seal) {
      await prisma.pmDevRepository.update({ where: { id: row.id }, data: { ...base, status: "PENDING", lastError: null, nextSyncAt: now } });
      return;
    }
    const oldFailures = row.consecutiveFailures;
    const attempts = oldFailures + 1;
    const isEgress = err instanceof DevelopmentEgressBlockedError || activeEgress?.blocked === "egress_switch_off";
    const isAuth = (err instanceof RestCredentialRejectedError && err.status === 401) || (err instanceof RestVendorError && err.status === 401);
    const isInaccessible = (err instanceof RestCredentialRejectedError && err.status === 403) || (err instanceof RestVendorError && err.status === 403 && !(err instanceof RestRateLimitedError));
    const status = err instanceof RestRateLimitedError ? "RATE_LIMITED" : isEgress ? "EGRESS_BLOCKED" : isAuth ? "NEEDS_RECONNECT" : isInaccessible ? "INACCESSIBLE" : "ERROR";
    const lastError = isEgress ? "Blocked by the work_integrations egress setting." : isAuth ? ERROR_COPY.credential : isInaccessible ? ERROR_COPY.inaccessible : ERROR_COPY.transient;
    const retryAt = err instanceof RestRateLimitedError && err.resetAt ? err.resetAt : new Date(now.getTime() + Math.min(6 * 60 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 9)));
    await prisma.pmDevRepository.update({ where: { id: row.id }, data: { ...base, status, lastError, consecutiveFailures: attempts, credentialSeal: isAuth ? seal : row.credentialSeal, nextSyncAt: retryAt } });
  }
}

export async function runDevelopmentSync(prisma: PrismaClient) {
  const due = await prisma.pmDevRepository.findMany({
    where: { nextSyncAt: { lte: new Date() } },
    orderBy: { nextSyncAt: "asc" }, take: 20,
  });
  for (const row of due) await syncOne(prisma, row);
  return { checked: due.length };
}

export async function listWorkItemDevelopment(prisma: PrismaClient, workItemId: string) {
  const item = await prisma.pmWorkItem.findFirst({ where: { id: workItemId, project: { kind: "PROJECT" } }, select: { id: true } });
  if (!item) throw new Error("work_item_not_found");
  return prisma.pmExternalLink.findMany({ where: { workItemId, repository: { status: { not: "DISCONNECTED" } } }, orderBy: [{ externalUpdatedAt: "desc" }, { createdAt: "desc" }], select: { id: true, provider: true, kind: true, url: true, title: true, state: true, author: true, ref: true, number: true, externalUpdatedAt: true, repository: { select: { fullName: true } } } });
}
