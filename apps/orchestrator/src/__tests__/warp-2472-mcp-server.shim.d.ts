/**
 * Ambient types for the deep `@droplet/mcp-server/dist/*` imports used by
 * `warp-2305-passthrough-double-prompt.probe.test.ts`.
 *
 * `services/mcp-server/tsconfig.json` sets no `declaration`, so its `dist/`
 * ships `.js` with no `.d.ts`, and no barrel export exists to import from
 * instead. Rather than let the import fall to an implicit `any` (house rule:
 * no `any`), the two symbols the probe uses are declared here with the
 * shapes `src/server.ts` actually exports. If that file's signature changes,
 * this shim is where the probe breaks — deliberately, and loudly.
 */
declare module "@droplet/mcp-server/dist/server.js" {
  import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
  import type { Tool, ToolCallInterceptor } from "@droplet/tools-core";

  export type TrustContext =
    | { kind: "local-trusted" }
    | { kind: "authenticated"; claims: unknown };

  export interface ServerOptions {
    additionalTools?: ReadonlyMap<string, Tool>;
    interceptor?: ToolCallInterceptor;
  }

  export function createServer(
    deps: unknown,
    trust: TrustContext,
    options?: ServerOptions,
  ): Server;
}

declare module "@droplet/mcp-server/dist/context.js" {
  import type { PrismaClient } from "@prisma/client";
  import type { HttpClient, MatterController } from "@droplet/tools-core";

  export interface ContextDeps {
    prisma: PrismaClient;
    matter: MatterController;
    httpFactory: (
      target:
        | "routing"
        | "cameras"
        | "switchSvc"
        | "fileIndexer"
        | "nextcloud"
        | "orchestrator",
    ) => HttpClient;
  }
}
