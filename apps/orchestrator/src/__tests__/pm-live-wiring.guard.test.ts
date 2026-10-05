/**
 * WARP-3536 — live updates are only live if the consumer is scheduled, the
 * topic is forwarded and the presence routes are mounted, and they are only
 * safe while two conventions hold. All of them are things a later slice can
 * break without a single unit test noticing, so they are pinned by reading
 * source, the way pm-outbox-wiring.guard.test.ts does.
 *
 *   P13 (droplet-pr-review-patterns): "a job promised in docs but not wired in
 *   index.ts" — the `pm-live` consumer must have its registration.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "..");
const read = (rel: string): string => readFileSync(path.join(SRC, rel), "utf8");
/** Strip comments so a mention in prose is not a call site. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the pm-live consumer is scheduled (index.ts), forwarded (ws-bridge) and mounted (app.ts)", () => {
  const index = code(read("index.ts"));

  it("registers `pm-live` on the shared cron runtime, with the live audience", () => {
    expect(index).toMatch(
      /registerOutboxConsumer\(\s*createPmLiveConsumer\(\{[\s\S]*?audience: createPmLiveAudience\(\{[\s\S]*?\}\),?\s*\}\),\s*\{ prisma, cronRuntime \},?\s*\)/,
    );
  });

  it("registers it AFTER createApp, which is what initialises the access resolver the audience reads", () => {
    const app = index.indexOf("createApp(prisma");
    const live = index.indexOf("createPmLiveConsumer(");
    expect(app).toBeGreaterThan(-1);
    expect(live).toBeGreaterThan(app);
  });

  it("reads the box's effective modules through the same function the module gate does", () => {
    expect(index).toMatch(/boxModuleIds: \(\) => getEffectiveModuleIds\(prisma, config\)/);
  });

  it("forwards droplet/pm/<username> to the browser, on the USERNAME only", () => {
    const bridge = code(read("services/ws-bridge.service.ts"));
    expect(bridge).toMatch(/`droplet\/pm\/\$\{user\.username\}`/);
    expect(bridge).not.toMatch(/droplet\/pm\/\$\{user\.id\}/);
  });

  it("mounts the presence router on /api", () => {
    expect(code(read("app.ts"))).toMatch(/app\.use\("\/api", createPmPresenceRouter\(prisma\)\)/);
  });

  it("needs no ACL change: the orchestrator's own grant already covers droplet/#", () => {
    const acl = readFileSync(path.resolve(SRC, "../../../docker/mosquitto.acl"), "utf8");
    expect(acl).toMatch(/user orchestrator\s+topic readwrite droplet\/#/);
  });

  it("introduces no timer of its own — the sweep and the nudge are the outbox's", () => {
    for (const rel of ["services/pm/pm-live.ts", "services/pm/pm-live-audience.ts", "services/pm/pm-presence.ts", "routes/pm/presence.ts"]) {
      const text = code(read(rel));
      expect(text, rel).not.toMatch(/\bsetInterval\(/);
      expect(text, rel).not.toMatch(/\bsetTimeout\(/);
    }
  });

  it("publishes through the shared client, never a second MQTT connection", () => {
    const text = code(read("services/pm/pm-live.ts"));
    expect(text).toMatch(/from "\.\.\/mqtt\.service\.js"/);
    expect(text).not.toMatch(/mqtt\.connect\(/);
  });
});

describe("Projects live updates exclude the Support service desk", () => {
  it("keeps the PROJECT kind check at both live-row and deleted-tombstone boundaries", () => {
    const schema = readFileSync(path.resolve(SRC, "../prisma/schema.prisma"), "utf8");
    const model = /^model PmProject \{([\s\S]*?)^\}/m.exec(schema)?.[1];
    expect(model, "model PmProject not found in schema.prisma").toBeTruthy();
    expect(model).toMatch(/^\s*kind\s+PmProjectKind\b/m);
    expect(schema).toMatch(/^enum PmProjectKind \{[\s\S]*?^\s*PROJECT\s*$/m);
    const consumer = code(read("services/pm/pm-live.ts"));
    expect(consumer).toMatch(/project: \{ select: \{ kind: true \} \}/);
    expect(consumer).toMatch(/item\.project\.kind !== "PROJECT"/);
    expect(consumer).toMatch(/pmProject\.findUnique\([\s\S]*?select: \{ kind: true \}[\s\S]*?project\.kind !== "PROJECT"/);
  });
});
