// WARP-3193 SEC-INJ-2 — the file tools that can DESTROY or EXPOSE data without
// deleting anything. delete_file needs the user's approval; before this,
// move_file / copy_file with overwrite=true, write_file over an existing file
// and a move into a shared folder did not, so an injected instruction could
// replace a whole tree or publish a private file with no human involved.
//
// tools-core has no argument-dependent confirmation (the interceptor keys on
// the static `requiresConfirmation` flag), so these calls are REFUSED with a
// code the model can act on: ask the user.

import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import { getTool } from "../../../src/index.js";
import type { ToolContext } from "../../../src/types.js";

function makeCtx(ncPost: Mock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }))) {
  const ctx = {
    prisma: {},
    http: {
      nextcloud: { get: vi.fn(), post: ncPost, patch: vi.fn(), delete: vi.fn() },
      routing: {},
      cameras: {},
      switchSvc: {},
      fileIndexer: {},
      orchestrator: {},
    },
    matter: {},
    userId: "alice",
    ncToken: "tok",
    signal: new AbortController().signal,
  } as unknown as ToolContext;
  return { ctx, ncPost };
}

async function run(name: string, args: Record<string, unknown>, ctx: ToolContext) {
  return getTool(name)!.handler(args, ctx);
}

describe("SEC-INJ-2 — overwrite needs the user", () => {
  for (const name of ["move_file", "copy_file"]) {
    it(`${name} refuses overwrite=true before any request`, async () => {
      const { ctx, ncPost } = makeCtx();
      const res = await run(name, { from_path: "/a.txt", to_path: "/b.txt", overwrite: true }, ctx);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("USER_APPROVAL_REQUIRED");
        expect(res.error.message).toMatch(/ask the user/i);
      }
      expect(ncPost).not.toHaveBeenCalled();
    });

    it(`${name} surfaces the route's shared-folder refusal as USER_APPROVAL_REQUIRED`, async () => {
      const ncPost = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "moving into a shared folder needs the user's approval",
            code: "USER_APPROVAL_REQUIRED",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      );
      const { ctx } = makeCtx(ncPost);
      const res = await run(name, { from_path: "/a.txt", to_path: "/Household/a.txt" }, ctx);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("USER_APPROVAL_REQUIRED");
        expect(res.error.message).toMatch(/shared folder/);
        expect(res.error.message).toMatch(/ask the user/i);
      }
    });
  }

  it("write_file asks the route for a create-only write", async () => {
    const { ctx, ncPost } = makeCtx();
    const res = await run("write_file", { path: "/Notes/a.md", content: "x" }, ctx);
    expect(res.ok).toBe(true);
    expect(ncPost).toHaveBeenCalledWith(
      "/upload",
      expect.objectContaining({ createOnly: true }),
      expect.anything(),
    );
  });

  it("write_file over an existing file (409) needs the user", async () => {
    const ncPost = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "file already exists", path: "/Notes/a.md" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    const { ctx } = makeCtx(ncPost);
    const res = await run("write_file", { path: "/Notes/a.md", content: "x" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("USER_APPROVAL_REQUIRED");
      expect(res.error.message).toMatch(/already exists/);
      expect(res.error.message).toMatch(/ask the user/i);
    }
  });
});
