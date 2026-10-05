/**
 * WARP-3532 — the outbox is only an outbox if every writer wakes it and the
 * consumers are actually scheduled. Both are conventions a later slice can break
 * silently (a new `pmActivity.create` with no nudge still works, just 6 s late
 * on a quiet box; a consumer registered in a doc and not in index.ts never runs),
 * so they are pinned by reading source, the way `undici-fetch-pairing.guard`
 * pins its convention.
 *
 *   P13 (droplet-pr-review-patterns): "a sweep promised in docs but not wired in
 *   index.ts" — the webhook worker, its retention prune and the fan-out consumer
 *   must each have their `cronRuntime` registration.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "..");
const read = (rel: string): string => readFileSync(path.join(SRC, rel), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

/** Strip comments so a mention in prose is not a call site. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("every PmActivity writer wakes the outbox", () => {
  const writers = sourceFiles(SRC)
    .map((file) => ({ file, text: code(readFileSync(file, "utf8")) }))
    .filter(({ text }) => /\bpmActivity\.(create|createMany)\(/.test(text));

  it("finds the writers (guards the scan, so the rows below are not vacuous)", () => {
    const names = writers.map((w) => path.basename(w.file));
    expect(names).toContain("pm.service.ts");
    expect(names).toContain("pm-relations.service.ts");
  });

  it.each(writers.map((w) => [path.relative(SRC, w.file).replace(/\\/g, "/"), w.text] as const))(
    "%s imports nudgeOutbox and calls it at least once per write site",
    (_name, text) => {
      const sites = text.match(/\bpmActivity\.(create|createMany)\(/g)?.length ?? 0;
      const nudges = text.match(/\bnudgeOutbox\(\)/g)?.length ?? 0;
      if (_name === "services/pm/pm.service.ts") {
        expect(text).toMatch(/import \{[^}]*\bnudgeOutbox\b[^}]*\} from "\.\/pm-outbox\.js"/);
        // `writeActivity` wakes once per ordinary committed write. Deletion is
        // one logical transaction with three possible activity inserts
        // (tombstone, child audit rows and relation audit rows), so it wakes
        // once after commit rather than once per insert. Pin both paths instead
        // of demanding a misleading one-nudge-per-insert count.
        expect(sites).toBe(3);
        expect(nudges).toBe(2);
        expect(text).toMatch(/if \(input\.nudge !== false\) nudgeOutbox\(\)/);
        expect(text).toMatch(/\}, \{ \.\.\.SERIALIZABLE_TX, timeout: 5_000 \}\);\s*nudgeOutbox\(\)/);
      } else if (_name === "services/support/escalation.service.ts") {
        // Escalation batches a related PM item and two relation activity rows
        // in one transaction. Its shared writeActivity call is the single
        // wake-up for that transaction; per-insert nudges would be redundant.
        expect(sites).toBe(1);
        expect(nudges).toBe(0);
        expect(text).toMatch(/import \{ writeActivity \} from "\.\.\/pm\/pm\.service\.js"/);
        expect(text).toMatch(/await writeActivity\(tx,[\s\S]*?await tx\.pmActivity\.createMany\(/);
      } else {
        expect(text).toMatch(/import \{[^}]*\bnudgeOutbox\b[^}]*\} from "\.\/pm-outbox\.js"/);
        expect(nudges).toBeGreaterThanOrEqual(sites);
      }
    },
  );
});

describe("the webhook machinery is scheduled (index.ts) and mounted (app.ts)", () => {
  const index = code(read("index.ts"));

  it("registers the `webhooks` outbox consumer on the shared cron runtime", () => {
    expect(index).toMatch(
      /registerOutboxConsumer\(\s*createWebhookFanOutConsumer\(prisma, \{[^}]*\}\),\s*\{ prisma, cronRuntime \},?\s*\)/,
    );
  });

  it("wakes the delivery worker when the fan-out queues something, instead of waiting out its interval", () => {
    expect(index).toMatch(/onQueued: \(\) => webhookDeliveryJob\?\.runNow\(\)/);
    expect(index).toMatch(/webhookDeliveryJob = cronRuntime\.scheduleInterval\(/);
  });

  it("schedules the delivery worker and the retention prune, each under its own advisory lock", () => {
    expect(index).toMatch(/runWebhookDeliveries\(prisma\)[\s\S]{0,200}lockKey: "droplet:pm-webhook-deliveries"/);
    expect(index).toMatch(/pruneWebhookDeliveries\(prisma\)[\s\S]{0,200}lockKey: "droplet:pm-webhook-delivery-prune"/);
  });

  it("cancels a pending outbox wake-up on shutdown", () => {
    expect(index).toMatch(/cronRuntime\.stop\(\);\s*stopOutbox\(\);/);
  });

  it("introduces no timer of its own — every schedule goes through cron-runtime", () => {
    for (const rel of [
      "services/pm/pm-outbox.ts",
      "services/pm/webhook-delivery.service.ts",
      "services/pm/webhook-fanout.ts",
      "routes/pm/webhooks.ts",
    ]) {
      const text = code(read(rel));
      // The one exception is the nudge's debounce in pm-outbox.ts: an unref'd,
      // cancellable, non-recurring setTimeout, never a setInterval.
      expect(text, rel).not.toMatch(/\bsetInterval\(/);
      if (rel !== "services/pm/pm-outbox.ts") expect(text, rel).not.toMatch(/\bsetTimeout\(/);
    }
  });

  it("mounts the router on /api, owner/admin routes behind the PM prefix", () => {
    expect(code(read("app.ts"))).toMatch(/app\.use\("\/api", createPmWebhooksRouter\(prisma\)\)/);
  });
});
