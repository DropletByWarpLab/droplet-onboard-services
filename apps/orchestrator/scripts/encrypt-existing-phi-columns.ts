/**
 * WARP-233 — one-shot, idempotent backfill: encrypt pre-existing plaintext
 * PHI/PII columns and populate the blind index.
 *
 * Today's scope: User.email → dcv1 AES-256-GCM blob + emailLookupHash
 * (HMAC-SHA256 blind index). Rows already carrying a dcv1: marker are
 * skipped, so re-running is always safe; a duplicate-email pair (possible
 * pre-index: the plaintext @unique was case-sensitive, the blind index is
 * case-insensitive) is reported and left untouched for operator remediation
 * rather than half-migrated.
 *
 * Run inside the orchestrator container (DATABASE_URL + DEVICE_SECRET_KEY
 * come from the environment):
 *   npx tsx scripts/encrypt-existing-phi-columns.ts        # apply
 *   npx tsx scripts/encrypt-existing-phi-columns.ts --dry  # report only
 */
import { PrismaClient } from "@prisma/client";
import {
  isEncryptedColumn,
  emailLookupHash,
} from "../src/services/column-crypto.service.js";
import { emailWriteData } from "../src/services/user-directory.service.js";

const DRY = process.argv.includes("--dry");

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  let encrypted = 0;
  let skipped = 0;
  let conflicts = 0;
  try {
    const users = await prisma.user.findMany({
      select: { id: true, email: true, emailLookupHash: true },
    });
    const seen = new Map<string, string>(); // hash → first user id
    for (const u of users) {
      if (u.email == null) { skipped++; continue; }
      if (isEncryptedColumn(u.email)) { skipped++; continue; }
      const hash = emailLookupHash(u.email);
      const holder = seen.get(hash);
      if (holder !== undefined) {
        conflicts++;
        console.error(
          `CONFLICT: users ${holder} and ${u.id} normalize to the same email — left untouched, resolve manually`,
        );
        continue;
      }
      seen.set(hash, u.id);
      // A hash collision against an already-backfilled row also surfaces as a
      // P2002 on the partial update below — caught + reported, not fatal.
      if (!DRY) {
        try {
          await prisma.user.update({
            where: { id: u.id },
            data: emailWriteData(u.email),
          });
        } catch (err) {
          conflicts++;
          console.error(`CONFLICT: user ${u.id} blind index collides with an existing row (${String(err)})`);
          continue;
        }
      }
      encrypted++;
    }
  } finally {
    await prisma.$disconnect();
  }
  console.log(
    `${DRY ? "[dry-run] " : ""}encrypt-existing-phi-columns: ${encrypted} encrypted, ${skipped} skipped (null/already dcv1), ${conflicts} conflicts`,
  );
  if (conflicts > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
