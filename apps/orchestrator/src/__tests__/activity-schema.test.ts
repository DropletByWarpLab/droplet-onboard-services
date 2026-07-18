/**
 * WARP-456 — Prisma `ActivityRow` schema shape.
 *
 * Sanity that the generated Prisma client exposes the canonical audit-row
 * model with the expected enum types. The full chain semantics (signature
 * verify, tamper detection, replay) live in
 * `audit-signing.service.test.ts` and `activity.service.test.ts`.
 *
 * The global `@prisma/client` vi.mock from `setup.ts` masks generated
 * enum exports for unit-test isolation. We unmock for this file only and
 * pull the real generated module so we can prove the migration created
 * the right enums on disk.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

vi.unmock("@prisma/client");

let ActivityKind: Record<string, string>;
let ActivitySeverity: Record<string, string>;
let ActivityActorType: Record<string, string>;

beforeAll(async () => {
  const real = await vi.importActual<typeof import("@prisma/client")>(
    "@prisma/client",
  );
  const realModule = real as unknown as Record<string, Record<string, string>>;
  ActivityKind = realModule.ActivityKind;
  ActivitySeverity = realModule.ActivitySeverity;
  ActivityActorType = realModule.ActivityActorType;
});

describe("Prisma ActivityRow schema", () => {
  it("exposes the canonical ActivityKind enum values", () => {
    expect(ActivityKind).toBeDefined();
    expect(ActivityKind.chat).toBe("chat");
    expect(ActivityKind.tool_call).toBe("tool_call");
    expect(ActivityKind.file).toBe("file");
    expect(ActivityKind.camera).toBe("camera");
    expect(ActivityKind.network).toBe("network");
    expect(ActivityKind.smart_home).toBe("smart_home");
    expect(ActivityKind.email).toBe("email");
    expect(ActivityKind.auth).toBe("auth");
    expect(ActivityKind.tool_run).toBe("tool_run");
    expect(ActivityKind.system).toBe("system");
    // WARP-1058 — voice events (wake / DSP / calibration / restarts).
    expect(ActivityKind.voice).toBe("voice");
  });

  it("exposes the canonical ActivitySeverity enum values", () => {
    expect(ActivitySeverity).toBeDefined();
    expect(ActivitySeverity.ok).toBe("ok");
    expect(ActivitySeverity.warn).toBe("warn");
    expect(ActivitySeverity.err).toBe("err");
    expect(ActivitySeverity.info).toBe("info");
  });

  it("exposes the WARP-181 ActivityActorType enum values", () => {
    expect(ActivityActorType).toBeDefined();
    expect(ActivityActorType.user).toBe("user");
    expect(ActivityActorType.ai).toBe("ai");
    expect(ActivityActorType.system).toBe("system");
    expect(ActivityActorType.anonymous).toBe("anonymous");
  });
});
