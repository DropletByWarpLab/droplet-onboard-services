import type { PrismaClient } from "@prisma/client";
import type { ToolContext, MatterController, HttpClient, Role } from "@droplet/tools-core";

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
}

export interface Claims {
  sub?: string;
  role?: Role;
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
    userId: claims?.sub,
    role: claims?.role,
    ncToken,
    signal,
  };
}
