/** WARP-3535: exercise the actual poller, link/activity transactions and state
 * automation against PostgreSQL. Only the vendor feed and credential material
 * are replaced; Prisma queries, PM reads and writeActivity remain real.
 * Like the other PG suites, this uses the CI throwaway DB with file parallelism
 * disabled. Every fixture and cleanup predicate belongs to this suite. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { DevelopmentFeedRequest, DevelopmentFeedResult, DevPullRequestItem } from "@droplet/erp-connector";

vi.unmock("@prisma/client");
const vendor = vi.hoisted(() => ({ read: vi.fn(), credential: vi.fn().mockResolvedValue("runtime-fixture-token") }));
vi.mock("../services/erp-provider.js", () => ({
  cloudMaterialFromRow: (row: { id: string }) => ({ connectionId: row.id, cloudTokens: { resolveSaasSecret: vendor.credential } }),
  connectorForProvider: () => ({ readDevelopment: vendor.read }),
}));

import { getWorkItem } from "../services/pm/pm.service.js";
import { listWorkItemDevelopment, mapDevelopmentRepository, runDevelopmentSync } from "../services/pm/pm-development.service.js";

const RUN = process.env.RUN_PG_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL);
const PREFIX = "warp3535runtime-";
const OURS = { startsWith: PREFIX } as const;
const AT = new Date("2026-10-04T10:00:00Z");
const response = (feed: string, changes: Partial<DevelopmentFeedResult> = {}): DevelopmentFeedResult => ({
  status: "ok", items: [], etag: `${feed}-complete`, truncated: false, skipped: 0, rateLimit: null, ...changes,
});

describe.skipIf(!RUN)("development polling and PM isolation (real PostgreSQL, WARP-3535)", () => {
  let prisma: PrismaClient;
  let projectId: string, deskId: string, itemId: string, deskItemId: string, repositoryId: string;
  let initialId: string, reviewId: string, manualId: string, mergedId: string;
  let feeds: Record<string, DevelopmentFeedResult>;

  beforeAll(async () => {
    const { PrismaClient: RealClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealClient();
    await prisma.$connect();
  });
  async function cleanup() {
    await prisma.pmDevRepository.deleteMany({ where: { externalId: OURS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    await prisma.integrationConnection.deleteMany({ where: { secretRef: OURS } });
  }
  afterAll(async () => { await cleanup(); await prisma.$disconnect(); });
  beforeEach(async () => {
    await cleanup();
    vi.clearAllMocks();
    const workspace = await prisma.pmWorkspace.create({ data: { slug: `${PREFIX}ws`, name: `${PREFIX}ws` } });
    const project = await prisma.pmProject.create({ data: {
      workspaceId: workspace.id, name: `${PREFIX}project`, identifier: "RT35", kind: "PROJECT",
      states: { create: [
        { name: "Backlog", group: "unstarted", isDefault: true },
        { name: "Review", group: "started" },
        { name: "Manual", group: "started" },
        { name: "Merged", group: "completed" },
      ] },
    }, include: { states: true } });
    projectId = project.id;
    initialId = project.states.find((s) => s.name === "Backlog")!.id;
    reviewId = project.states.find((s) => s.name === "Review")!.id;
    manualId = project.states.find((s) => s.name === "Manual")!.id;
    mergedId = project.states.find((s) => s.name === "Merged")!.id;
    itemId = (await prisma.pmWorkItem.create({ data: {
      projectId, sequenceId: 1, name: `${PREFIX}item`, stateId: initialId,
    } })).id;
    const desk = await prisma.pmProject.create({ data: {
      workspaceId: workspace.id, name: `${PREFIX}desk`, identifier: "DT35", kind: "SERVICE_DESK",
      states: { create: { name: "New", group: "unstarted", isDefault: true } },
    }, include: { states: true } });
    deskId = desk.id;
    deskItemId = (await prisma.pmWorkItem.create({ data: {
      projectId: deskId, sequenceId: 1, name: `${PREFIX}private-ticket`, stateId: desk.states[0]!.id,
      ticket: { create: { requesterKind: "USER", requesterUserId: `${PREFIX}requester`, requesterName: "Private requester", channel: "INTERNAL" } },
    } })).id;
    await prisma.integrationConnection.create({ data: {
      provider: "github", status: "CONNECTED", host: "api.github.com", databaseName: "",
      secretRef: `${PREFIX}credential`, providerTokensEnc: "runtime-fixture-ciphertext",
    } });
    const repository = await prisma.pmDevRepository.create({ data: {
      provider: "GITHUB", externalId: `${PREFIX}repo`, apiRef: "acme/runtime-widget", fullName: "acme/runtime-widget",
      webUrl: "https://github.com/acme/runtime-widget", nextSyncAt: new Date(0),
    } });
    repositoryId = repository.id;
    await prisma.pmDevRepositoryProject.create({ data: { repositoryId, projectId } });
    feeds = Object.fromEntries(["pullRequestsOpen", "pullRequestsRecent", "commits", "branches"].map((feed) => [feed, response(feed)]));
    vendor.read.mockImplementation(async ({ feed, repo }: DevelopmentFeedRequest) => {
      if (repo !== "acme/runtime-widget" || !feeds[feed]) throw new Error("unexpected fixture feed");
      return feeds[feed];
    });
  });

  const pullRequest = (changes: Partial<DevPullRequestItem> = {}): DevPullRequestItem => ({
    type: "pull_request", externalId: `${PREFIX}pr42`, number: 42,
    url: "https://github.com/acme/runtime-widget/pull/42", title: "RT35-1 fix the widget",
    body: "Details for RT35-1", branch: "feature/RT35-1", author: "fixture-author", state: "OPEN", updatedAt: AT, ...changes,
  });
  async function poll() {
    await prisma.pmDevRepository.update({ where: { id: repositoryId }, data: { nextSyncAt: new Date(0) } });
    expect((await runDevelopmentSync(prisma)).checked).toBeGreaterThanOrEqual(1);
    expect((await prisma.pmDevRepository.findUniqueOrThrow({ where: { id: repositoryId } })).status).toBe("OK");
  }
  const state = () => prisma.pmWorkItem.findUniqueOrThrow({ where: { id: itemId } });
  const activityCount = (verb: "external_link_added" | "state_changed") => prisma.pmActivity.count({ where: { workItemId: itemId, verb } });

  it("persists one link and one canonical activity across overlapping feeds and replay", async () => {
    feeds.pullRequestsOpen = response("pullRequestsOpen", { items: [pullRequest()] });
    feeds.pullRequestsRecent = response("pullRequestsRecent", { items: [pullRequest()] });
    await poll();
    await poll();
    const links = await listWorkItemDevelopment(prisma, itemId);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ kind: "PULL_REQUEST", state: "OPEN", number: 42, title: "RT35-1 fix the widget" });
    expect(await activityCount("external_link_added")).toBe(1);
    expect(await activityCount("state_changed")).toBe(0); // The mapping has no optional automation.
    expect((await state()).stateId).toBe(initialId);
  });

  it("automates a first OPEN and real PR transitions while preserving manual state on unchanged replays", async () => {
    await mapDevelopmentRepository(prisma, repositoryId, projectId, { onOpenedStateId: reviewId, onMergedStateId: mergedId });
    feeds.pullRequestsOpen = response("pullRequestsOpen", { items: [pullRequest()] });
    await poll();
    expect((await state()).stateId).toBe(reviewId);
    expect(await activityCount("state_changed")).toBe(1);

    await prisma.pmWorkItem.update({ where: { id: itemId }, data: { stateId: manualId } });
    feeds.pullRequestsOpen = response("pullRequestsOpen", { items: [pullRequest({ title: "RT35-1 amended title", updatedAt: new Date(AT.getTime() + 60000) })] });
    await poll();
    expect((await state()).stateId).toBe(manualId);
    expect(await activityCount("state_changed")).toBe(1);

    feeds.pullRequestsOpen = response("pullRequestsOpen", { items: [pullRequest({ state: "DRAFT" })] });
    await poll();
    expect((await state()).stateId).toBe(manualId);
    feeds.pullRequestsOpen = response("pullRequestsOpen", { items: [pullRequest()] });
    await poll();
    expect((await state()).stateId).toBe(reviewId);
    expect(await activityCount("state_changed")).toBe(2);

    feeds.pullRequestsOpen = response("pullRequestsOpen");
    feeds.pullRequestsRecent = response("pullRequestsRecent", { items: [pullRequest({ state: "MERGED" })] });
    await poll();
    expect(await state()).toMatchObject({ stateId: mergedId, isCompleted: true, completedAt: expect.any(Date) });
    expect(await activityCount("state_changed")).toBe(3);
    await prisma.pmWorkItem.update({ where: { id: itemId }, data: { stateId: manualId, isCompleted: false, completedAt: null } });
    await poll();
    expect(await state()).toMatchObject({ stateId: manualId, isCompleted: false, completedAt: null });
    expect(await activityCount("state_changed")).toBe(3);
    expect(await activityCount("external_link_added")).toBe(1);
  });

  it("refuses canonical Project reads for a Service Desk item and skips even a persisted desk mapping during polling", async () => {
    expect((await getWorkItem(prisma, itemId)).id).toBe(itemId);
    await expect(getWorkItem(prisma, deskItemId)).rejects.toThrow("work_item_not_found");
    await expect(listWorkItemDevelopment(prisma, deskItemId)).rejects.toThrow("work_item_not_found");
    await expect(mapDevelopmentRepository(prisma, repositoryId, deskId, {})).rejects.toThrow("project_not_found");
    // Model a legacy mapping already in persistence: matching must enforce the
    // parent kind too, independently of the route/configuration check.
    await prisma.pmDevRepositoryProject.create({ data: { repositoryId, projectId: deskId } });
    feeds.pullRequestsOpen = response("pullRequestsOpen", { items: [pullRequest({ title: "RT35-1 and DT35-1" })] });
    await poll();
    expect(await prisma.pmExternalLink.count({ where: { workItemId: itemId } })).toBe(1);
    expect(await prisma.pmExternalLink.count({ where: { workItemId: deskItemId } })).toBe(0);
    expect(await prisma.pmActivity.count({ where: { workItemId: deskItemId } })).toBe(0);
  });

  it("keeps unseen branches open and discards incomplete ETags until a complete inventory proves deletion", async () => {
    feeds.branches = response("branches", { items: [{ type: "branch", name: "feature/RT35-1", url: "https://github.com/acme/runtime-widget/tree/feature/RT35-1" }] });
    await poll();
    const branch = await prisma.pmExternalLink.findFirstOrThrow({ where: { repositoryId, workItemId: itemId, kind: "BRANCH" } });
    expect(branch.state).toBe("OPEN");
    for (const feed of Object.keys(feeds)) feeds[feed] = response(feed, { items: [], truncated: true, etag: `${feed}-incomplete` });
    await poll();
    expect((await prisma.pmExternalLink.findUniqueOrThrow({ where: { id: branch.id } })).state).toBe("OPEN");
    expect(await prisma.pmDevRepository.findUniqueOrThrow({ where: { id: repositoryId } })).toMatchObject({
      openPrsEtag: null, recentPrsEtag: null, commitsEtag: null, branchesEtag: null,
    });

    vendor.read.mockClear();
    for (const feed of Object.keys(feeds)) feeds[feed] = response(feed);
    await poll();
    expect(vendor.read.mock.calls).toHaveLength(4);
    expect(vendor.read.mock.calls.map(([request]) => request.etag)).toEqual([null, null, null, null]);
    expect((await prisma.pmExternalLink.findUniqueOrThrow({ where: { id: branch.id } })).state).toBe("CLOSED");
    expect(await activityCount("external_link_added")).toBe(1);
  });
});
