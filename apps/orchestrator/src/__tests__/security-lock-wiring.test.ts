/**
 * WARP-2977 P2b-2 (spec §11 L0) — the Matter lock adapter is wired into the
 * orchestrator's boot, where nothing else in the DB-less lane can see it.
 *
 * `index.ts` opens sockets, schedules crons and connects to Postgres on
 * import, so no unit test runs it. Without these pins, deleting either call
 * leaves every test and `tsc` green while /security quietly says the locks
 * are "Not running" on every box — the built-but-dark failure this repo has
 * shipped before. A source-text assertion is a weak guarantee about
 * behaviour and a strong one about attention, which is what fails here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PACKAGE_ROOT } from "./helpers/test-paths.js";

const index = readFileSync(resolve(PACKAGE_ROOT, "src", "index.ts"), "utf8");

/** The source between two markers (both must exist, in order). */
function between(from: string, to: string): string {
  const a = index.indexOf(from);
  const b = index.indexOf(to, a + from.length);
  expect(a, `marker ${JSON.stringify(from)}`).toBeGreaterThanOrEqual(0);
  expect(b, `marker ${JSON.stringify(to)} after ${JSON.stringify(from)}`).toBeGreaterThan(a);
  return index.slice(a, b);
}

describe("the Matter lock adapter is wired into boot (WARP-2977 P2b-2)", () => {
  it("starts right after the Matter init block — outside its try, so a failed init still captures once the bridge heals", () => {
    const init = index.indexOf("await initMatterService();");
    const catchEnd = index.indexOf('logger.warn("Matter controller unavailable', init);
    const start = index.indexOf("startSecurityLockAdapter({");
    const network = index.indexOf("await initNetworkService();");
    expect(init).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(catchEnd);
    expect(start).toBeLessThan(network);
    // Not inside the try: nothing between the catch and the start opens another block.
    expect(index.slice(catchEnd, start)).not.toMatch(/\btry\s*\{/);
  });

  it("is fed the real store and the existing matter.service exports — never an import of matter.service by the adapter", () => {
    const call = between("startSecurityLockAdapter({", "});");
    expect(call).toContain("store: createPrismaLockStore(prisma)");
    expect(call).toContain("matterLockDeviceSource({");
    // The DeviceAlias name and room ride along, so rows and the Areas page name the lock as the household does.
    expect(call).toMatch(/getCommissionedDevices:\s*async \(\) => enrichGrouped\(prisma, await getCommissionedDevices\(\)\)/);
    expect(call).toContain("isMatterInitialized");
    expect(call).toContain("subscribeStateChanges");
    // Review F8: the connection stream, so a change heard as a lock reconnects is recorded as found (polled).
    expect(call).toMatch(/^\s*subscribeConnectionChanges,\s*$/m);
    expect(index).toMatch(/import \{[^}]*\bsubscribeConnectionChanges,[^}]*\} from "\.\/services\/matter\.service\.js";/);
    const adapter = readFileSync(resolve(PACKAGE_ROOT, "src", "services", "security-lock-adapter.ts"), "utf8");
    expect(adapter).not.toMatch(/from\s+["']\.\/matter\.service\.js["']/);
  });

  it("its 60 s sweep is registered on the cron runtime right beside the other Security jobs, unconditionally", () => {
    const jobs = between("registerSecurityJobs(cronRuntime, prisma);", "cronRuntime.scheduleCron(");
    expect(jobs).toContain("registerSecurityLockJobs(cronRuntime, securityLocks);");
    // Capture runs whether or not Security or Devices is switched on (the DS-015 analogue).
    expect(jobs).not.toMatch(/if\s*\(/);
  });

  it("the started adapter is the one whose sweep is registered", () => {
    expect(index).toMatch(/const securityLocks = startSecurityLockAdapter\(\{/);
  });

  it("graceful shutdown stops it right before the Matter bridge it subscribes to (rjouffret, review of 4fa950c8)", () => {
    const teardown = between("const shutdown = createShutdownRunner(logger, async () => {", "await prisma.$disconnect();");
    // Its own statement, directly before the bridge's shutdown: nothing awaits between them.
    expect(teardown).toMatch(/\n\s*securityLocks\.stop\(\);\n\s*await shutdownMatterService\(\);/);
  });
});
