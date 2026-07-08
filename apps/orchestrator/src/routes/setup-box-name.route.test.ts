/**
 * WARP-979 — route tests for the onboarding "Secured / name your box" endpoints.
 *
 *   GET  /api/setup/box-name/check?name=<n>
 *     → 200 { available, slug, fqdn, authoritative, reason?, message? }
 *   POST /api/setup/box-name { name }
 *     → 200 { ok, slug, fqdn }                    — name validated + persisted.
 *     → 400 { code: "BOX_NAME_INVALID", reason }  — malformed / reserved name.
 *     → 400 { code: "BOX_NAME_REQUIRED" }         — missing name.
 *     → 401 { code: "BOX_NAME_AUTH_REQUIRED" }    — unauth POST on a claimed box.
 *
 * Strategy mirrors setup-org.route.test.ts: a minimal Express app + supertest
 * with an in-memory `applianceSetup` Prisma stand-in and a FAKE host persister
 * injected into createSetupRouter (so no device-bridge is touched).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";

vi.unmock("@prisma/client");

vi.mock("../services/jwt.service.js", () => ({
  verifyAccessToken: (token: string) =>
    token === "valid-session"
      ? { sub: "u1", username: "owner", displayName: "Owner", role: "owner" }
      : null,
}));

import { createSetupRouter } from "./setup.js";
import {
  CLAIM_RESULT_CLAIMED,
  CLAIM_RESULT_NAME_TAKEN,
  CLAIM_RESULT_ALREADY_NAMED,
  CLAIM_RESULT_NOT_REGISTERED,
  CLAIM_RESULT_FAILED,
  RELEASE_RESULT_OK,
  type ClaimBoxNameResult,
} from "../services/tls-issuance.service.js";

// ── In-memory store: applianceSetup singleton (drives the auth gate) ──
function createPrismaMock() {
  let setup: Record<string, unknown> | null = null;
  return {
    _seedSetup: (s: Record<string, unknown> | null) => {
      setup = s;
    },
    applianceSetup: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        setup && setup.id === where.id ? { ...setup } : null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        if (setup && setup.id === where.id) {
          setup = { ...setup, ...update };
        } else {
          setup = {
            state: "unclaimed",
            setupStep: "welcome",
            userTourCompleted: false,
            ...create,
          };
        }
        return { ...setup };
      },
    },
  };
}

/** A fake device-auth claimer. Defaults to a happy `CLAIMED` (authoritative)
 *  result; tests override to exercise the taken / fallback branches. The claimer
 *  receives the RAW owner-entered name (HQ slugs it). */
function makeClaimResult(over: Partial<ClaimBoxNameResult> = {}): ClaimBoxNameResult {
  return {
    outcome: CLAIM_RESULT_CLAIMED,
    authoritative: true,
    slug: "studio",
    fqdn: "studio.droplet-us.com",
    ...over,
  };
}

function buildApp(
  prisma: ReturnType<typeof createPrismaMock>,
  claimResult: ClaimBoxNameResult = makeClaimResult(),
  envBoxName = "",
) {
  const persisted: string[] = [];
  const persistBoxNameToHost = vi.fn(async (name: string) => {
    persisted.push(name);
  });
  const claimed: string[] = [];
  const claimBoxName = vi.fn(async (raw: string) => {
    claimed.push(raw);
    return claimResult;
  });
  // WARP-1109 — rename collaborators. The release frees the CURRENT name at HQ;
  // the reissue triggers a cert re-issue under the NEW fqdn. Both injected so no
  // HQ / issuance runtime is touched.
  const released: number[] = [];
  const releaseBoxName = vi.fn(async () => {
    released.push(Date.now());
    return RELEASE_RESULT_OK;
  });
  const reissued: number[] = [];
  const reissueTls = vi.fn(async () => {
    reissued.push(Date.now());
  });
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    "/api",
    createSetupRouter(prisma as never, {
      persistBoxNameToHost,
      claimBoxName,
      releaseBoxName,
      reissueTls,
      // WARP-1039 — boot-env fallback for GET /setup/box-name, injected so the
      // tests never touch the real config snapshot.
      getEnvBoxName: () => envBoxName,
    }),
  );
  return {
    app,
    persisted,
    persistBoxNameToHost,
    claimed,
    claimBoxName,
    released,
    releaseBoxName,
    reissued,
    reissueTls,
  };
}

describe("GET /api/setup/box-name/check (WARP-979)", () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it("reports a well-formed name as available with the droplet-us.com fqdn", async () => {
    const { app } = buildApp(prisma);
    const res = await request(app).get("/api/setup/box-name/check?name=studio");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.slug).toBe("studio");
    expect(res.body.fqdn).toBe("studio.droplet-us.com");
    // MVP: format-valid availability is not authoritative (HQ registry check is
    // a coupled fleet-hq follow-up).
    expect(res.body.authoritative).toBe(false);
    expect(res.body.reason).toBeUndefined();
  });

  it("normalizes (trim + lowercase) before answering", async () => {
    const { app } = buildApp(prisma);
    const res = await request(app).get("/api/setup/box-name/check?name=%20%20MyBox%20%20");
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("mybox");
    expect(res.body.available).toBe(true);
  });

  it("rejects a too-short name with a reason", async () => {
    const { app } = buildApp(prisma);
    const res = await request(app).get("/api/setup/box-name/check?name=ab");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBe("too_short");
    expect(typeof res.body.message).toBe("string");
  });

  it("rejects a reserved name", async () => {
    const { app } = buildApp(prisma);
    const res = await request(app).get("/api/setup/box-name/check?name=admin");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBe("reserved");
  });

  it("rejects a d-<16hex> device lookalike", async () => {
    const { app } = buildApp(prisma);
    const res = await request(app).get(
      "/api/setup/box-name/check?name=d-0123456789abcdef",
    );
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBe("lookalike");
  });

  it("rejects bad characters (spaces / uppercase) as a charset failure", async () => {
    const { app } = buildApp(prisma);
    const res = await request(app).get("/api/setup/box-name/check?name=my%20box");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBe("charset");
  });

  it("rejects a leading/trailing hyphen", async () => {
    const { app } = buildApp(prisma);
    const res = await request(app).get("/api/setup/box-name/check?name=-studio");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBe("hyphen");
  });

  it("treats a missing name param as invalid (empty)", async () => {
    const { app } = buildApp(prisma);
    const res = await request(app).get("/api/setup/box-name/check");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBe("empty");
  });
});

describe("POST /api/setup/box-name (WARP-979)", () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it("validates + persists + device-auth CLAIMS a valid name (200 authoritative)", async () => {
    const { app, persisted, persistBoxNameToHost, claimed, claimBoxName } =
      buildApp(prisma);
    const res = await request(app)
      .post("/api/setup/box-name")
      .send({ name: "Studio" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.slug).toBe("studio");
    expect(res.body.fqdn).toBe("studio.droplet-us.com");
    // WARP-980 — the wizard now gets a REAL authoritative answer.
    expect(res.body.authoritative).toBe(true);
    expect(res.body.taken).toBe(false);
    // The chosen name was persisted (host .env write-back), normalized.
    expect(persistBoxNameToHost).toHaveBeenCalledTimes(1);
    expect(persisted).toEqual(["studio"]);
    // The claim was driven with the RAW owner-entered name (HQ slugs it).
    expect(claimBoxName).toHaveBeenCalledTimes(1);
    expect(claimed).toEqual(["Studio"]);
  });

  it("409s with BOX_NAME_TAKEN + suggestions when HQ says the name is taken", async () => {
    const { app, persistBoxNameToHost } = buildApp(
      prisma,
      makeClaimResult({
        outcome: CLAIM_RESULT_NAME_TAKEN,
        authoritative: true,
        suggestions: ["studio-2", "studio-hq"],
        slug: undefined,
        fqdn: undefined,
      }),
    );
    const res = await request(app)
      .post("/api/setup/box-name")
      .send({ name: "studio" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOX_NAME_TAKEN");
    expect(res.body.taken).toBe(true);
    expect(res.body.suggestions).toEqual(["studio-2", "studio-hq"]);
    // The name was still persisted locally (best-effort) before the claim.
    expect(persistBoxNameToHost).toHaveBeenCalledTimes(1);
  });

  it("409s with BOX_NAME_ALREADY_NAMED when THIS box already holds a name (WARP-1109)", async () => {
    const { app, persistBoxNameToHost } = buildApp(
      prisma,
      makeClaimResult({
        outcome: CLAIM_RESULT_ALREADY_NAMED,
        authoritative: true,
        currentName: "scruceru",
        slug: undefined,
        fqdn: undefined,
      }),
    );
    const res = await request(app)
      .post("/api/setup/box-name")
      .send({ name: "studio" });

    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe("BOX_NAME_ALREADY_NAMED");
    // Distinct from a taken name — the wizard shows the current address + a
    // Rename affordance instead of the false "taken".
    expect(res.body.taken).toBe(false);
    expect(res.body.currentName).toBe("scruceru");
    expect(res.body.authoritative).toBe(true);
    expect(typeof res.body.error).toBe("string");
    // The name was still persisted locally (best-effort) before the claim.
    expect(persistBoxNameToHost).toHaveBeenCalledTimes(1);
  });

  it("omits currentName on the already-named 409 when HQ did not send it", async () => {
    const { app } = buildApp(
      prisma,
      makeClaimResult({
        outcome: CLAIM_RESULT_ALREADY_NAMED,
        authoritative: true,
        slug: undefined,
        fqdn: undefined,
      }),
    );
    const res = await request(app)
      .post("/api/setup/box-name")
      .send({ name: "studio" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOX_NAME_ALREADY_NAMED");
    expect(res.body.currentName).toBeUndefined();
  });

  it("200 authoritative:false when the device is not registered yet (graceful fallback)", async () => {
    const { app } = buildApp(
      prisma,
      makeClaimResult({
        outcome: CLAIM_RESULT_NOT_REGISTERED,
        authoritative: false,
        slug: undefined,
        fqdn: undefined,
      }),
    );
    const res = await request(app)
      .post("/api/setup/box-name")
      .send({ name: "studio" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Persisted + will issue under opaque/bootstrap; wizard is told it's not
    // authoritative yet (issuance re-claims on the next tick).
    expect(res.body.slug).toBe("studio");
    expect(res.body.fqdn).toBe("studio.droplet-us.com");
    expect(res.body.authoritative).toBe(false);
    expect(res.body.taken).toBe(false);
  });

  it("400s a reserved name with BOX_NAME_INVALID (no persist)", async () => {
    const { app, persistBoxNameToHost } = buildApp(prisma);
    const res = await request(app)
      .post("/api/setup/box-name")
      .send({ name: "vpn" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BOX_NAME_INVALID");
    expect(res.body.reason).toBe("reserved");
    expect(persistBoxNameToHost).not.toHaveBeenCalled();
  });

  it("400s a malformed name with BOX_NAME_INVALID (no persist)", async () => {
    const { app, persistBoxNameToHost } = buildApp(prisma);
    const res = await request(app)
      .post("/api/setup/box-name")
      .send({ name: "My Box!" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BOX_NAME_INVALID");
    expect(persistBoxNameToHost).not.toHaveBeenCalled();
  });

  it("400s a missing name with BOX_NAME_REQUIRED", async () => {
    const { app } = buildApp(prisma);
    const res = await request(app).post("/api/setup/box-name").send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BOX_NAME_REQUIRED");
  });

  it("allows first-run (unclaimed) POST WITHOUT a session", async () => {
    // No setup row → appliance defaults to unclaimed (first run).
    const { app, persisted } = buildApp(prisma);
    const res = await request(app)
      .post("/api/setup/box-name")
      .send({ name: "studio" });
    expect(res.status).toBe(200);
    expect(persisted).toEqual(["studio"]);
  });

  it("rejects an unauthenticated POST once the appliance is `ready` (401, no persist)", async () => {
    prisma._seedSetup({
      id: "singleton",
      state: "ready",
      setupStep: "done",
      userTourCompleted: true,
    });
    const { app, persistBoxNameToHost } = buildApp(prisma);
    const res = await request(app)
      .post("/api/setup/box-name")
      .send({ name: "evil" });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("BOX_NAME_AUTH_REQUIRED");
    expect(persistBoxNameToHost).not.toHaveBeenCalled();
  });

  it("writes the accepted slug to the ApplianceSetup singleton on the ok path (WARP-1039)", async () => {
    const { app } = buildApp(prisma);
    const res = await request(app)
      .post("/api/setup/box-name")
      .send({ name: "Studio" });

    expect(res.status).toBe(200);
    // The DB singleton now carries the slug so GET /setup/box-name (and any
    // in-process reader) can surface it without a container restart.
    const read = await request(app).get("/api/setup/box-name");
    expect(read.status).toBe(200);
    expect(read.body.name).toBe("studio");
    expect(read.body.fqdn).toBe("studio.droplet-us.com");
  });

  it("does NOT write the DB singleton when HQ says the name is taken (409 path)", async () => {
    const { app } = buildApp(
      prisma,
      makeClaimResult({
        outcome: CLAIM_RESULT_NAME_TAKEN,
        authoritative: true,
        suggestions: ["studio-2"],
        slug: undefined,
        fqdn: undefined,
      }),
    );
    const res = await request(app)
      .post("/api/setup/box-name")
      .send({ name: "studio" });
    expect(res.status).toBe(409);

    const read = await request(app).get("/api/setup/box-name");
    expect(read.status).toBe(200);
    expect(read.body.name).toBeNull();
  });

  it("allows an AUTHENTICATED owner to set the name on a claimed appliance", async () => {
    prisma._seedSetup({
      id: "singleton",
      state: "ready",
      setupStep: "done",
      userTourCompleted: true,
    });
    const { app, persisted } = buildApp(
      prisma,
      makeClaimResult({ slug: "renamed", fqdn: "renamed.droplet-us.com" }),
    );
    const res = await request(app)
      .post("/api/setup/box-name")
      .set("Cookie", "droplet_session=valid-session")
      .send({ name: "renamed" });

    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("renamed");
    expect(res.body.authoritative).toBe(true);
    expect(persisted).toEqual(["renamed"]);
  });
});

describe("POST /api/setup/box-name/rename (WARP-1109)", () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it("releases the current name, claims the new one, re-issues, and 200s authoritative", async () => {
    const { app, released, releaseBoxName, claimed, claimBoxName, reissueTls, persisted } =
      buildApp(
        prisma,
        makeClaimResult({ slug: "renamed", fqdn: "renamed.droplet-us.com" }),
      );
    const res = await request(app)
      .post("/api/setup/box-name/rename")
      .send({ name: "Renamed" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.slug).toBe("renamed");
    expect(res.body.fqdn).toBe("renamed.droplet-us.com");
    expect(res.body.authoritative).toBe(true);
    // The old name was released, the new one claimed (RAW), a re-issue fired.
    expect(releaseBoxName).toHaveBeenCalledTimes(1);
    expect(claimBoxName).toHaveBeenCalledTimes(1);
    expect(claimed).toEqual(["Renamed"]);
    expect(persisted).toEqual(["renamed"]);
    expect(reissueTls).toHaveBeenCalledTimes(1);
    expect(released.length).toBe(1);

    // The DB singleton is updated so GET /setup/box-name reads the new name.
    const read = await request(app)
      .get("/api/setup/box-name")
      .set("Cookie", "droplet_session=valid-session");
    expect(read.body.name).toBe("renamed");
  });

  it("409s with BOX_NAME_TAKEN when the NEW name is taken by another box (still released the old one)", async () => {
    const { app, releaseBoxName, reissueTls } = buildApp(
      prisma,
      makeClaimResult({
        outcome: CLAIM_RESULT_NAME_TAKEN,
        authoritative: true,
        suggestions: ["renamed-2"],
        slug: undefined,
        fqdn: undefined,
      }),
    );
    const res = await request(app)
      .post("/api/setup/box-name/rename")
      .send({ name: "renamed" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOX_NAME_TAKEN");
    expect(res.body.taken).toBe(true);
    expect(res.body.suggestions).toEqual(["renamed-2"]);
    expect(releaseBoxName).toHaveBeenCalledTimes(1);
    // No successful re-issue under a taken name.
    expect(reissueTls).not.toHaveBeenCalled();
  });

  it("200 authoritative:false when the post-release claim fails (fallback, still re-issues)", async () => {
    const { app, releaseBoxName, reissueTls } = buildApp(
      prisma,
      makeClaimResult({
        outcome: CLAIM_RESULT_FAILED,
        authoritative: false,
        slug: undefined,
        fqdn: undefined,
      }),
    );
    const res = await request(app)
      .post("/api/setup/box-name/rename")
      .send({ name: "renamed" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.authoritative).toBe(false);
    expect(releaseBoxName).toHaveBeenCalledTimes(1);
    // The box falls back to opaque/bootstrap so it keeps serving a cert.
    expect(reissueTls).toHaveBeenCalledTimes(1);
  });

  it("400s an invalid new name with BOX_NAME_INVALID and does NOT release the current name", async () => {
    const { app, releaseBoxName, reissueTls } = buildApp(prisma);
    const res = await request(app)
      .post("/api/setup/box-name/rename")
      .send({ name: "My Box!" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BOX_NAME_INVALID");
    expect(releaseBoxName).not.toHaveBeenCalled();
    expect(reissueTls).not.toHaveBeenCalled();
  });

  it("400s a missing name with BOX_NAME_REQUIRED", async () => {
    const { app } = buildApp(prisma);
    const res = await request(app).post("/api/setup/box-name/rename").send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BOX_NAME_REQUIRED");
  });

  it("rejects an unauthenticated rename once the appliance is `ready` (401, no release)", async () => {
    prisma._seedSetup({
      id: "singleton",
      state: "ready",
      setupStep: "done",
      userTourCompleted: true,
      boxName: "studio",
    });
    const { app, releaseBoxName } = buildApp(prisma);
    const res = await request(app)
      .post("/api/setup/box-name/rename")
      .send({ name: "evil" });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("BOX_NAME_AUTH_REQUIRED");
    expect(releaseBoxName).not.toHaveBeenCalled();
  });

  it("allows an AUTHENTICATED owner to rename on a claimed appliance", async () => {
    prisma._seedSetup({
      id: "singleton",
      state: "ready",
      setupStep: "done",
      userTourCompleted: true,
      boxName: "studio",
    });
    const { app, releaseBoxName } = buildApp(
      prisma,
      makeClaimResult({ slug: "renamed", fqdn: "renamed.droplet-us.com" }),
    );
    const res = await request(app)
      .post("/api/setup/box-name/rename")
      .set("Cookie", "droplet_session=valid-session")
      .send({ name: "renamed" });

    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("renamed");
    expect(releaseBoxName).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/setup/box-name (WARP-1039)", () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  beforeEach(() => {
    prisma = createPrismaMock();
  });

  it("returns empty (name:null, fqdn:null) before any name is saved", async () => {
    const { app } = buildApp(prisma);
    const res = await request(app).get("/api/setup/box-name");
    expect(res.status).toBe(200);
    expect(res.body.name).toBeNull();
    expect(res.body.fqdn).toBeNull();
  });

  it("returns the saved slug + fqdn after a successful POST", async () => {
    const { app } = buildApp(prisma);
    await request(app).post("/api/setup/box-name").send({ name: "Studio" });

    const res = await request(app).get("/api/setup/box-name");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("studio");
    expect(res.body.fqdn).toBe("studio.droplet-us.com");
  });

  it("falls back to the boot-env DROPLET_BOX_NAME when the DB has no saved name (restart mid-wizard)", async () => {
    const { app } = buildApp(prisma, makeClaimResult(), "warp");
    const res = await request(app).get("/api/setup/box-name");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("warp");
    expect(res.body.fqdn).toBe("warp.droplet-us.com");
  });

  it("prefers the DB-saved name over the boot-env fallback", async () => {
    const { app } = buildApp(prisma, makeClaimResult(), "old-name");
    await request(app).post("/api/setup/box-name").send({ name: "studio" });

    const res = await request(app).get("/api/setup/box-name");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("studio");
  });

  it("treats an invalid hand-edited boot-env value as no name (defense-in-depth)", async () => {
    const { app } = buildApp(prisma, makeClaimResult(), "My Box!");
    const res = await request(app).get("/api/setup/box-name");
    expect(res.status).toBe(200);
    expect(res.body.name).toBeNull();
    expect(res.body.fqdn).toBeNull();
  });

  it("allows an anonymous GET during first-run (unclaimed) onboarding", async () => {
    // No setup row → appliance defaults to unclaimed (first run).
    const { app } = buildApp(prisma, makeClaimResult(), "warp");
    const res = await request(app).get("/api/setup/box-name");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("warp");
  });

  it("rejects an anonymous GET once the appliance is `ready` (401) — same gate as the POST", async () => {
    prisma._seedSetup({
      id: "singleton",
      state: "ready",
      setupStep: "done",
      userTourCompleted: true,
      boxName: "studio",
    });
    const { app } = buildApp(prisma);
    const res = await request(app).get("/api/setup/box-name");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("BOX_NAME_AUTH_REQUIRED");
    expect(res.body.name).toBeUndefined();
  });

  it("allows an AUTHENTICATED session to read the name on a ready appliance", async () => {
    prisma._seedSetup({
      id: "singleton",
      state: "ready",
      setupStep: "done",
      userTourCompleted: true,
      boxName: "studio",
    });
    const { app } = buildApp(prisma);
    const res = await request(app)
      .get("/api/setup/box-name")
      .set("Cookie", "droplet_session=valid-session");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("studio");
    expect(res.body.fqdn).toBe("studio.droplet-us.com");
  });
});
