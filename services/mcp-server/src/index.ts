#!/usr/bin/env node
import { PrismaClient } from "@prisma/client";
import { createServer } from "./server.js";
import { startStdio } from "./transports/stdio.js";
import type { ContextDeps } from "./context.js";

function parseTransport(argv: string[]): "stdio" | "http" {
  const arg = argv.find((a) => a.startsWith("--transport="));
  const value = arg?.split("=")[1];
  if (value === "http") return "http";
  return "stdio";
}

async function main(): Promise<void> {
  const transport = parseTransport(process.argv.slice(2));

  // Build dependencies. For WARP-100 we only support stdio + a minimal Matter
  // stub; HTTP transport + full deps land in WARP-103.
  const prisma = new PrismaClient();
  const deps: ContextDeps = {
    prisma,
    matter: {
      listDevices: async () => ({}),
      getDevice: async () => ({}),
      sendCommand: async () => ({}),
      discover: async () => ({}),
      commission: async () => ({}),
      getAuditLog: async () => ({}),
    },
    httpFactory: () => ({
      get: () => Promise.reject(new Error("http transport not configured in WARP-100")),
      post: () => Promise.reject(new Error("http transport not configured in WARP-100")),
      patch: () => Promise.reject(new Error("http transport not configured in WARP-100")),
      delete: () => Promise.reject(new Error("http transport not configured in WARP-100")),
    }),
  };
  const server = createServer(deps);

  if (transport === "stdio") {
    await startStdio(server);
  } else {
    console.error("HTTP transport not yet implemented (WARP-103)");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
