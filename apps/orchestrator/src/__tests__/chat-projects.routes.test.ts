/**
 * WARP-845 — per-user chat projects.
 *
 * Covered:
 *   - CRUD on /api/llm/projects, strictly scoped to the caller
 *   - cross-user access 404s (no existence leak)
 *   - ensureConversation stamps a NEW conversation's projectId only when
 *     the project belongs to the same user
 *   - setConversationProject moves/ungroups with double ownership checks
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../middleware/auth.js", () => ({
  requireRole:
    () => (_req: Request, _res: Response, next: NextFunction) =>
      next(),
}));

import { createChatProjectsRouter } from "../routes/chat-projects.js";
import { ChatPersistenceService } from "../services/chat-persistence.service.js";

interface ProjectRow {
  id: string;
  userId: string;
  name: string;
  systemPrompt: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function createProjectsPrisma(seed: ProjectRow[] = []) {
  const rows = [...seed];
  return {
    rows,
    chatProject: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        rows
          .filter((r) => r.userId === where.userId)
          .map((r) => ({ ...r, _count: { sessions: 2 } })),
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId?: string } }) => {
          const r = rows.find(
            (x) =>
              x.id === where.id &&
              (where.userId === undefined || x.userId === where.userId),
          );
          // The PATCH read-back includes _count; harmless extra for the
          // ownership lookups that don't ask for it.
          return r ? { ...r, _count: { sessions: 2 } } : null;
        },
      ),
      create: vi.fn(async ({ data }: { data: Partial<ProjectRow> }) => {
        const row: ProjectRow = {
          id: `proj-${rows.length + 1}`,
          userId: data.userId!,
          name: data.name!,
          systemPrompt: data.systemPrompt ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        rows.push(row);
        return row;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; userId: string };
          data: Partial<ProjectRow>;
        }) => {
          let count = 0;
          for (const r of rows) {
            if (r.id === where.id && r.userId === where.userId) {
              Object.assign(r, data);
              count++;
            }
          }
          return { count };
        },
      ),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const r = rows.find((x) => x.id === where.id);
        if (!r) throw new Error("not found");
        return r;
      }),
      deleteMany: vi.fn(
        async ({ where }: { where: { id: string; userId: string } }) => {
          const before = rows.length;
          for (let i = rows.length - 1; i >= 0; i--) {
            if (rows[i]!.id === where.id && rows[i]!.userId === where.userId) {
              rows.splice(i, 1);
            }
          }
          return { count: before - rows.length };
        },
      ),
    },
  };
}

function buildApp(prisma: ReturnType<typeof createProjectsPrisma>, username: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const asUser = { id: "uuid", username, role: "family" };
    (req as unknown as { user?: typeof asUser }).user = asUser;
    next();
  });
  app.use("/api", createChatProjectsRouter(prisma as never));
  return app;
}

function project(over: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: over.id ?? "proj-a",
    userId: over.userId ?? "alice",
    name: over.name ?? "House renovation",
    systemPrompt: over.systemPrompt ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("WARP-845 — /api/llm/projects CRUD", () => {
  it("lists only the caller's projects with chat counts", async () => {
    const prisma = createProjectsPrisma([
      project({ id: "p1", userId: "alice" }),
      project({ id: "p2", userId: "bob", name: "bob's" }),
    ]);
    const res = await request(buildApp(prisma, "alice")).get("/api/llm/projects");
    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.projects[0]).toMatchObject({
      id: "p1",
      name: "House renovation",
      chatCount: 2,
    });
  });

  it("creates a project with an optional default prompt", async () => {
    const prisma = createProjectsPrisma();
    const res = await request(buildApp(prisma, "alice"))
      .post("/api/llm/projects")
      .send({ name: "Recipes", systemPrompt: "You are a chef." });
    expect(res.status).toBe(201);
    expect(prisma.rows[0]).toMatchObject({
      userId: "alice",
      name: "Recipes",
      systemPrompt: "You are a chef.",
    });
    // Review fix: POST returns the same DTO shape as GET — chatCount
    // present (0 for a fresh project), no userId leak.
    expect(res.body.project).toMatchObject({ name: "Recipes", chatCount: 0 });
    expect(res.body.project).not.toHaveProperty("userId");
  });

  it("PATCH returns the mapped DTO (chatCount, no userId)", async () => {
    const prisma = createProjectsPrisma([project({ id: "p1", userId: "alice" })]);
    const res = await request(buildApp(prisma, "alice"))
      .patch("/api/llm/projects/p1")
      .send({ name: "Renamed" });
    expect(res.status).toBe(200);
    expect(res.body.project).toMatchObject({
      id: "p1",
      name: "Renamed",
      chatCount: 2,
    });
    expect(res.body.project).not.toHaveProperty("userId");
  });

  it("PATCH/DELETE refuse foreign projects with 404", async () => {
    const prisma = createProjectsPrisma([project({ id: "p2", userId: "bob" })]);
    const app = buildApp(prisma, "alice");
    expect(
      (await request(app).patch("/api/llm/projects/p2").send({ name: "x" }))
        .status,
    ).toBe(404);
    expect((await request(app).delete("/api/llm/projects/p2")).status).toBe(404);
    expect(prisma.rows).toHaveLength(1);
  });

  it("deletes an owned project (chats survive via FK SET NULL)", async () => {
    const prisma = createProjectsPrisma([project({ id: "p1", userId: "alice" })]);
    const res = await request(buildApp(prisma, "alice")).delete(
      "/api/llm/projects/p1",
    );
    expect(res.status).toBe(204);
    expect(prisma.rows).toHaveLength(0);
  });
});

describe("WARP-845 — persistence project stamping/membership", () => {
  function persistencePrisma(projects: ProjectRow[], sessions: Array<{ id: string; userId: string; projectId: string | null }>) {
    return {
      chatProject: {
        findFirst: vi.fn(
          async ({ where }: { where: { id: string; userId: string } }) =>
            projects.find(
              (r) => r.id === where.id && r.userId === where.userId,
            ) ?? null,
        ),
      },
      chatSession: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "sess-new",
          ...data,
        })),
        updateMany: vi.fn(
          async ({
            where,
            data,
          }: {
            where: { id: string; userId: string };
            data: { projectId: string | null };
          }) => {
            let count = 0;
            for (const s of sessions) {
              if (s.id === where.id && s.userId === where.userId) {
                s.projectId = data.projectId;
                count++;
              }
            }
            return { count };
          },
        ),
      },
    };
  }

  it("ensureConversation stamps an owned project and ignores a foreign one", async () => {
    const prisma = persistencePrisma([project({ id: "p1", userId: "alice" })], []);
    const svc = new ChatPersistenceService(prisma as never);

    await svc.ensureConversation({
      conversationId: null,
      userId: "alice",
      model: "m1",
      firstUserContent: "hi",
      projectId: "p1",
    });
    expect(prisma.chatSession.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ projectId: "p1" }),
      }),
    );

    await svc.ensureConversation({
      conversationId: null,
      userId: "mallory",
      model: "m1",
      firstUserContent: "hi",
      projectId: "p1", // alice's — must be ignored
    });
    expect(prisma.chatSession.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ projectId: null }),
      }),
    );
  });

  it("setConversationProject enforces ownership on both sides", async () => {
    const sessions = [{ id: "s1", userId: "alice", projectId: null as string | null }];
    const prisma = persistencePrisma([project({ id: "p1", userId: "alice" })], sessions);
    const svc = new ChatPersistenceService(prisma as never);

    // Foreign project → refused.
    expect(await svc.setConversationProject("s1", "mallory", "p1")).toBe(false);
    // Owned both sides → moved.
    expect(await svc.setConversationProject("s1", "alice", "p1")).toBe(true);
    expect(sessions[0]!.projectId).toBe("p1");
    // Ungroup with null.
    expect(await svc.setConversationProject("s1", "alice", null)).toBe(true);
    expect(sessions[0]!.projectId).toBeNull();
  });
});
