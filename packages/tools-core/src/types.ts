import type { PrismaClient } from "@prisma/client";

export type Role = "owner" | "admin" | "family" | "guest";

export interface HttpClient {
  get(path: string, opts?: { params?: Record<string, unknown>; headers?: Record<string, string> }): Promise<Response>;
  post(path: string, body?: unknown, opts?: { headers?: Record<string, string> }): Promise<Response>;
  patch(path: string, body?: unknown, opts?: { headers?: Record<string, string> }): Promise<Response>;
  delete(path: string, opts?: { headers?: Record<string, string> }): Promise<Response>;
}

export interface MatterController {
  listDevices(): Promise<unknown>;
  getDevice(nodeId: string): Promise<unknown>;
  sendCommand(nodeId: string, command: string, data?: unknown): Promise<unknown>;
  discover(): Promise<unknown>;
  commission(pairingCode: string): Promise<unknown>;
  getAuditLog(opts: { entityId?: string; limit?: number }): Promise<unknown>;
}

export interface ToolContext {
  prisma: PrismaClient;
  http: {
    routing: HttpClient;
    cameras: HttpClient;
    switchSvc: HttpClient;
    fileIndexer: HttpClient;
    nextcloud: HttpClient;
  };
  matter: MatterController;
  userId?: string;
  role?: Role;
  ncToken?: string;
  signal: AbortSignal;
}

export interface ToolError {
  code: string;
  message: string;
  details?: unknown;
}

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: ToolError; status: "error" | "confirmation_required" };

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult>;

export interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  requiresWrite: boolean;
  requiresConfirmation: boolean;
  handler: ToolHandler;
}
