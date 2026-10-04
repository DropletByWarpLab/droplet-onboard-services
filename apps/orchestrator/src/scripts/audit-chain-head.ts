/**
 * WARP-3628 — print the activity chain's current head as JSON, for copying
 * off the box (see services/audit-chain-head.service.ts for what to keep and
 * how to compare it later). Read-only; run it from cron on the owner's
 * archive host over SSH, or by hand:
 *
 *   docker compose exec -T orchestrator node dist/scripts/audit-chain-head.js
 *
 * Ships compiled in the runtime image (src/scripts -> dist/scripts).
 */
import { PrismaClient } from "@prisma/client";
import { readChainHead } from "../services/audit-chain-head.service.js";

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    process.stdout.write(`${JSON.stringify(await readChainHead(prisma), null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("audit-chain-head failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
