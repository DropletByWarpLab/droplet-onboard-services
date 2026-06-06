/**
 * WARP-823 — route tests for the downloadable, secret-redacted log bundle.
 *
 *   POST /api/logs/bundle   — owner/admin only. Streams a .zip of the host's
 *                             service logs (bounded window), with EVERY byte
 *                             passed through redactSecrets() before it lands in
 *                             the archive. The download is audited via the
 *                             activity chain.
 *
 * Strategy mirrors settings-email.route.test.ts: a minimal Express app +
 * supertest with a synthetic auth middleware that stuffs req.user, the bridge
 * fetch mocked (no host call), and recordActivity mocked.
 *
 * The .zip is read back with yauzl (a devDependency) so we can assert on the
 * actual archived bytes — the planted secret must not appear in ANY entry.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import yauzl from "yauzl";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    DEVICE_BRIDGE_URL: "http://host.docker.internal:9090",
  },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

const { fetchLogBundleMock } = vi.hoisted(() => ({
  fetchLogBundleMock: vi.fn(),
}));
vi.mock("../services/logs-bridge.service.js", () => ({
  fetchLogBundleFromBridge: fetchLogBundleMock,
}));

import { createLogsRouter } from "./logs.js";
import { RouterError } from "../types/router-error.js";

type Role = "owner" | "admin" | "family" | "guest" | "service";

function makeApp(role: Role) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      id: "u-1",
      username: "owner@droplet.local",
      displayName: "Owner",
      role,
    };
    next();
  });
  app.use("/api", createLogsRouter());
  return app;
}

/** Read every entry of a zip buffer into { filename -> utf8 contents }. */
function readZip(buf: Buffer): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("no zip"));
      const out: Record<string, string> = {};
      zip.on("entry", (entry) => {
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e ?? new Error("no stream"));
          const chunks: Buffer[] = [];
          stream.on("data", (c) => chunks.push(c as Buffer));
          stream.on("end", () => {
            out[entry.fileName] = Buffer.concat(chunks).toString("utf8");
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(out));
      zip.readEntry();
    });
  });
}

beforeEach(() => {
  recordActivityMock.mockClear();
  fetchLogBundleMock.mockReset();
});

describe("POST /api/logs/bundle", () => {
  it("returns 403 for a family user (owner/admin only — ADR-004)", async () => {
    const res = await request(makeApp("family")).post("/api/logs/bundle").send({});
    expect(res.status).toBe(403);
    expect(fetchLogBundleMock).not.toHaveBeenCalled();
  });

  it("returns 403 for a guest user", async () => {
    const res = await request(makeApp("guest")).post("/api/logs/bundle").send({});
    expect(res.status).toBe(403);
  });

  it("streams a .zip attachment for an owner", async () => {
    fetchLogBundleMock.mockResolvedValue({
      collected_at: "2026-06-06T10:00:00Z",
      window_hours: 24,
      services: [
        { name: "orchestrator", source: "docker", lines: "GET /api/health 200" },
      ],
      truncated: false,
    });

    const res = await request(makeApp("owner"))
      .post("/api/logs/bundle")
      .send({})
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/zip");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(".zip");
    const entries = await readZip(res.body as Buffer);
    const names = Object.keys(entries);
    // A manifest + the per-service log file are present.
    expect(names.some((n) => n.includes("orchestrator"))).toBe(true);
    expect(names.some((n) => n.toLowerCase().includes("manifest"))).toBe(true);
  });

  it("REDACTS planted secrets in the archived bytes before they leave the box", async () => {
    const PLANTED_TOKEN = "Bearer eyJplantedjwtsecret.aaaa.bbbb";
    const PLANTED_PW = "password=Sup3rSecretValue!";
    const PLANTED_PEM = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEPLANTEDprivatekeymaterialmustnotleak0000000000",
      "-----END PRIVATE KEY-----",
    ].join("\n");

    fetchLogBundleMock.mockResolvedValue({
      collected_at: "2026-06-06T10:00:00Z",
      window_hours: 24,
      services: [
        {
          name: "orchestrator",
          source: "docker",
          lines: [
            "GET /api/llm/models",
            `Authorization: ${PLANTED_TOKEN}`,
            `connecting ${PLANTED_PW}`,
            PLANTED_PEM,
          ].join("\n"),
        },
      ],
      truncated: false,
    });

    const res = await request(makeApp("admin"))
      .post("/api/logs/bundle")
      .send({})
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    // Scan the WHOLE archive payload (entry bytes), not just one file.
    const entries = await readZip(res.body as Buffer);
    const all = Object.values(entries).join("\n");
    expect(all).not.toContain("eyJplantedjwtsecret.aaaa.bbbb");
    expect(all).not.toContain("Sup3rSecretValue!");
    expect(all).not.toContain("MIIEPLANTEDprivatekeymaterialmustnotleak0000000000");
    expect(all).toContain("[REDACTED]");
    // Non-secret context still made it through.
    expect(all).toContain("GET /api/llm/models");
  });

  it("audits the download via the activity chain (kind=system)", async () => {
    fetchLogBundleMock.mockResolvedValue({
      collected_at: "2026-06-06T10:00:00Z",
      window_hours: 24,
      services: [{ name: "orchestrator", source: "docker", lines: "ok" }],
      truncated: false,
    });

    await request(makeApp("owner"))
      .post("/api/logs/bundle")
      .send({})
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    const arg = recordActivityMock.mock.calls[0]![0];
    expect(arg).toMatchObject({ kind: "system" });
    expect(typeof arg.what).toBe("string");
  });

  it("rejects an out-of-range window with 400 (bounded time window)", async () => {
    const res = await request(makeApp("owner"))
      .post("/api/logs/bundle")
      .send({ windowHours: 9999 });
    expect(res.status).toBe(400);
    expect(fetchLogBundleMock).not.toHaveBeenCalled();
  });

  it("surfaces a 503 when the device-bridge is unreachable", async () => {
    fetchLogBundleMock.mockRejectedValue(
      RouterError.unreachable("device-bridge not reachable", {
        label: "Collect diagnostics",
      }),
    );
    const res = await request(makeApp("owner")).post("/api/logs/bundle").send({});
    expect(res.status).toBe(503);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("returns 503 with a clear code when the bridge auth token is unconfigured", async () => {
    fetchLogBundleMock.mockRejectedValue(
      Object.assign(new Error("token not configured"), {
        code: "BRIDGE_AUTH_UNCONFIGURED",
      }),
    );
    const res = await request(makeApp("owner")).post("/api/logs/bundle").send({});
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "BRIDGE_AUTH_UNCONFIGURED" });
  });
});
