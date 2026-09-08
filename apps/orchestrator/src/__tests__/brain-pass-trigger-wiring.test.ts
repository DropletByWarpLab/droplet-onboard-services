/**
 * WARP-2850 — the wiring the unit lane cannot otherwise see.
 *
 * `createApp`'s `brainPassTrigger` parameter is OPTIONAL, because ~100 test
 * files call `createApp` and none of them should have to care. The cost of
 * that convenience is precise and worth naming: if somebody deletes the
 * argument from the single real call site in `index.ts`, every existing test
 * still passes, `tsc` still passes, and the manual-run route quietly answers
 * 503 forever on real boxes — the "built but unreachable" failure this epic
 * has already found four times.
 *
 * A source-text assertion is a weak guarantee about behaviour and a strong one
 * about attention, which is the failure mode that actually happens here.
 * Nothing else in the DB-less lane can reach `index.ts`: it opens sockets,
 * schedules crons and connects to Postgres on import.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(__dirname, "..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

describe("brain pass trigger is wired into the app (WARP-2850)", () => {
  it("index.ts passes the trigger to createApp", () => {
    // Not a regex over the whole call — just that the identifier reaches it.
    const index = read("index.ts");
    expect(index).toContain("createApp(prisma, sceneMatterDispatcher, brainPassTrigger)");
  });

  it("index.ts builds one, and schedules the boot run", () => {
    const index = read("index.ts");
    expect(index).toContain("createBrainPassTrigger({");
    expect(index).toContain("scheduleBootRun(");
  });

  it("app.ts forwards it to the brain router", () => {
    expect(read("app.ts")).toContain("createBrainRouter(prisma, brainPassTrigger)");
  });

  it("🔴 NEITHER brain pass is registered with a cron lockKey", () => {
    // WARP-2837: cron-runtime's lock runs the handler inside a 60 s
    // `$transaction`, and the corpus pass makes ten model calls. Both passes
    // take the lease instead. Re-adding a lockKey here is the regression, and
    // it would look perfectly reasonable in a diff.
    const index = read("index.ts");
    const brainBlock = index.slice(
      index.indexOf("const passRunners"),
      index.indexOf("logger.info(", index.indexOf("const passRunners")),
    );
    expect(brainBlock.length).toBeGreaterThan(200); // the slice actually found the block
    expect(brainBlock).not.toContain("lockKey");
  });

  it("🔴 the run route does NOT use the mcp-admitting gate", () => {
    // `requireRoleOrMcpService` calls next() for `_service:mcp` before any
    // role check. The reads survive that because a row filter re-checks the
    // human; an ACTION route has no rows and therefore no second line of
    // defence. Tidying this to match its neighbours is the vulnerability.
    const brain = read("routes/brain.ts");
    // Anchor on the PATH, not on the surrounding formatting. This file is CRLF
    // on disk, so a needle containing "\n" matches nothing — which would leave
    // this guard passing while guarding zero characters, the exact failure the
    // repo has a name for.
    const at = brain.indexOf('"/brain/passes/:passKey/run"');
    expect(at).toBeGreaterThan(-1);
    const route = brain.slice(at, brain.indexOf('router.get("/brain/findings"'));
    expect(route.length).toBeGreaterThan(200);
    expect(route).toContain('requireRole("owner", "admin")');
    expect(route).not.toContain("requireRoleOrMcpService");
    expect(route).not.toMatch(/\bgate\b/);
  });
});
