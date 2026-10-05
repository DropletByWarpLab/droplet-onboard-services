import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { Readable } from "node:stream";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    MAX_UPLOAD_SIZE_MB: 100,
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue("nc-token"),
}));
vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));
vi.mock("../services/nextcloud.client.js", async () => {
  const actual = await vi.importActual<typeof import("../services/nextcloud.client.js")>(
    "../services/nextcloud.client.js",
  );
  return { ...actual, ncDownloadFile: vi.fn() };
});

import { createFilesRouter } from "../routes/files.js";
import { ncDownloadFile } from "../services/nextcloud.client.js";

const BYTES = "the downloaded file's bytes";

function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: "user-1", username: "stefan", displayName: "Stefan", role: "owner" };
    next();
  });
  app.use("/api", createFilesRouter({} as never));
  return app;
}

beforeEach(() => {
  vi.mocked(ncDownloadFile).mockResolvedValue(
    Readable.toWeb(Readable.from([Buffer.from(BYTES)])) as ReadableStream<Uint8Array>,
  );
});

describe("GET /api/files/download preserves Unicode filenames over HTTP", () => {
  it.each([
    { name: "中文.txt", inline: false, disposition: "attachment", fallback: "__.txt" },
    { name: "Café Ω.txt", inline: false, disposition: "attachment", fallback: "Caf_ _.txt" },
    { name: "中文.txt", inline: true, disposition: "inline", fallback: "__.txt" },
    { name: "中文.pdf", inline: true, disposition: "inline", fallback: "__.pdf" },
    { name: "中文.html", inline: true, disposition: "attachment", fallback: "__.html" },
  ])("streams $name with $disposition disposition", async ({ name, inline, disposition, fallback }) => {
    // Real ServerResponse header validation and body piping: raw CJK in filename= used to throw ERR_INVALID_CHAR.
    const res = await request(buildApp()).get("/api/files/download")
      .query({ path: `/${name}`, ...(inline ? { disposition: "inline" } : {}) });

    expect(res.status).toBe(200);
    expect(res.text ?? res.body.toString("utf8")).toBe(BYTES);
    const header = res.headers["content-disposition"] as string;
    expect(header.startsWith(`${disposition}; filename="${fallback}"; filename*=UTF-8''`)).toBe(true);
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    expect(decodeURIComponent(header.split("filename*=UTF-8''")[1])).toBe(name);
    expect(ncDownloadFile).toHaveBeenLastCalledWith("nc-token", "stefan", `/${name}`);
    if (inline && name.endsWith(".txt")) expect(res.headers["content-security-policy"]).toBe("sandbox");
    if (inline && name.endsWith(".pdf")) expect(res.headers["content-security-policy"] ?? "").not.toMatch(/\bsandbox\b/);
  });

  it("percent-encodes punctuation that is not an RFC 5987 attribute character", async () => {
    const res = await request(buildApp()).get("/api/files/download")
      .query({ path: "/中文 (it's)*.txt" });

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain(
      "filename*=UTF-8''%E4%B8%AD%E6%96%87%20%28it%27s%29%2A.txt",
    );
  });
});
