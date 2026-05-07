import type { PrismaClient } from "@prisma/client";
import type { ToolContext, MatterController, HttpClient } from "@droplet/tools-core";
// `Claims` is canonically defined in `auth/jwt.ts` (the only place that
// produces them, by verifying a Bearer JWT). Re-export it from here so
// the existing `import { type Claims } from "./context.js"` callers
// (server.ts, transports/*) keep working without duplicating the type.
import type { Claims } from "./auth/jwt.js";
export type { Claims } from "./auth/jwt.js";

export interface ContextDeps {
  prisma: PrismaClient;
  matter: MatterController;
  httpFactory: (target:
    | "routing"
    | "cameras"
    | "switchSvc"
    | "fileIndexer"
    | "nextcloud"
  ) => HttpClient;
  /**
   * Optional embedding RPC. Wired in `index.ts` to a singleton gRPC
   * channel against the ai-gateway's `EmbedText` (WARP-202). Surfaces
   * in `ToolContext.embedText` so handlers like `search_content` can
   * vectorize a query without each one owning its own gRPC plumbing.
   *
   * Optional because:
   *   - In-process unit tests don't exercise the embedder.
   *   - On a fresh device the ai-gateway may be unreachable at boot;
   *     handlers must guard with `if (!ctx.embedText)` rather than
   *     crash. `search_content` returns `EMBEDDING_UNAVAILABLE` when
   *     missing and `EMBEDDING_FAILED` when the call throws.
   */
  embedText?: (texts: string[]) => Promise<number[][]>;
}

export function buildContext(
  deps: ContextDeps,
  claims: Claims | undefined,
  signal: AbortSignal,
  ncToken?: string,
): ToolContext {
  return {
    prisma: deps.prisma,
    matter: deps.matter,
    http: {
      routing: deps.httpFactory("routing"),
      cameras: deps.httpFactory("cameras"),
      switchSvc: deps.httpFactory("switchSvc"),
      fileIndexer: deps.httpFactory("fileIndexer"),
      nextcloud: deps.httpFactory("nextcloud"),
    },
    embedText: deps.embedText,
    userId: claims?.sub,
    role: claims?.role,
    ncToken,
    signal,
  };
}
