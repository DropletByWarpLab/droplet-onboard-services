/**
 * WARP-3193 SEC-INJ-6 — the read routes that pass `?path=` straight to the
 * Nextcloud client (download, versions, thumbnail) never ran the `..` guard
 * `rootForSpace` gives the write routes. The guard now lives in the client's
 * `webdavUrl()`; this pins that it surfaces as a 400 with no upstream request.
 * The Nextcloud client is deliberately NOT mocked here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue("session-token"),
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  invalidatePrefix: vi.fn().mockResolvedValue(0),
}));

vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../config.js", () => ({
  config: {
    MAX_UPLOAD_SIZE_MB: 10,
    NODE_ENV: "test",
    DROPLET_SHARED_FOLDER_NAME: "Household",
    NEXTCLOUD_URL: "http://nextcloud.test",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

import { createFilesRouter } from "../routes/files.js";

function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user?: object }).user = { id: "u-1", username: "romain", role: "family" };
    next();
  });
  app.use("/api", createFilesRouter({} as never));
  return app;
}

const fetchSpy = vi.fn();

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});

describe("SEC-INJ-6 — read routes refuse dot segments", () => {
  it.each(["/files/download", "/files/versions", "/files/thumbnail"])(
    "%s?path=/../../ocs/... → 400, no Nextcloud request",
    async (route) => {
      const res = await request(buildApp())
        .get(`/api${route}`)
        .query({ path: "/../../ocs/v2.php/cloud/users" });
      expect(res.status).toBe(400);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});
