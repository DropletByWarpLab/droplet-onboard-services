import express, { type Request } from "express";
import request from "supertest";
import { createServer, request as httpRequest, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostedRelayRouter } from "../routes/hosted.js";
import { hostedJwtKey, HOSTED_BODY_CAP } from "./hosted.service.js";
import { deriveHostedAppRelayKey, encryptColumn } from "./column-crypto.service.js";

vi.mock("../config.js", () => ({ config: { JWT_SECRET: "dashboard-secret-with-at-least-32-bytes", DEVICE_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"), SANDBOX_PROCESS_SUPERVISION: true, SANDBOX_URL: "http://sandbox:8030", SANDBOX_SERVICE_TOKEN: "sandbox-bearer", DROPLET_LAN_HOSTNAME: "droplet-ai.lan" } }));
vi.mock("./activity.singleton.js", () => ({ recordActivity: vi.fn() }));
vi.mock("./session.service.js", () => ({ checkSession: vi.fn(async () => ({ kind: "ok", record: { userId: "user-id" } })) }));
vi.mock("./auth-denylist.service.js", () => ({ isUserDenied: vi.fn(async () => false) }));

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(async (server) => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); })); });
const token = () => jwt.sign({ sid: "dashboard-sid" }, hostedJwtKey(), { subject: "user-id", audience: "app:shop", issuer: "droplet-hosted", expiresIn: "1h" });
const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, id: "shop", name: "Shop", version: "1.0.0", kind: "app", runtime: "static", http: { health: "/", dir: "." }, provides: { tools: [], routineDrafts: [], proposedGrants: [] }, resources: { memoryMb: 64, processes: 1 }, egress: "none" }));
function app(fetchImpl: typeof fetch, requestTimeoutMs = 60_000) {
  const prisma = { user: { findUnique: async () => ({ id: "user-id", username: "alice", displayName: "Alice", role: "owner", directoryStatus: "ACTIVE" }) }, extension: { findUnique: async () => ({ id: "shop", kind: "app", status: "live", currentVersion: { manifestBytes: manifest }, hostedAppGrants: [], appRelayKeyEnc: encryptColumn(deriveHostedAppRelayKey(), "k".repeat(43), "hosted-app:shop") }) } } as unknown as PrismaClient;
  const application = express(); application.use("/api/hosted/relay", createHostedRelayRouter(prisma, { fetchImpl, enabled: () => true, requestTimeoutMs, gatewayPeer: async (req: Request) => req.header("x-forwarded-port") === "8443" }));
  return application;
}
async function listen(server: Server) { servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening"); return `http://127.0.0.1:${(server.address() as AddressInfo).port}`; }
const gateway = { "X-Forwarded-Port": "8443", Cookie: `droplet_app_shop=${token()}` };

describe("hosted relay streaming budgets and resource ownership", () => {
  it("refuses known oversized uploads before allocating or dialing an upstream", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const response = await request(app(fetchImpl)).post("/api/hosted/relay/shop/upload").set(gateway).set("Content-Length", String(HOSTED_BODY_CAP + 1));
    expect(response.status).toBe(413); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("caps chunked uploads without buffering 32 MiB", async () => {
    let received = 0;
    const fetchImpl = (async (_url, init) => {
      for await (const chunk of init!.body as unknown as AsyncIterable<Buffer>) received += chunk.length;
      return new Response("done");
    }) as typeof fetch;
    const url = await listen(createServer(app(fetchImpl)));
    const result = new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest(`${url}/api/hosted/relay/shop/upload`, { method: "POST", headers: { ...gateway, "Transfer-Encoding": "chunked" } }, (incoming) => { incoming.resume(); incoming.once("end", () => resolve(incoming.statusCode!)); });
      outgoing.on("error", reject);
      void (async () => {
        const chunk = Buffer.alloc(1024 * 1024);
        for (let index = 0; index < 33; index++) { if (!outgoing.write(chunk)) await once(outgoing, "drain"); }
        outgoing.end();
      })().catch(reject);
    });
    expect(await result).toBe(413); expect(received).toBeLessThanOrEqual(HOSTED_BODY_CAP);
  });
  it("enforces an absolute deadline while waiting for upstream headers", async () => {
    let peerClosed!: () => void; const closed = new Promise<void>((resolve) => { peerClosed = resolve; });
    const upstream = await listen(createServer((incoming) => { incoming.socket.once("close", peerClosed); }));
    const before = Date.now();
    const response = await request(app((_url, init) => fetch(upstream, init), 80)).get("/api/hosted/relay/shop/").set(gateway);
    expect(response.status).toBe(504); expect(Date.now() - before).toBeLessThan(1500);
    await closed;
  });
  it("aborts a stalled streamed response after its first SSE chunk", async () => {
    let peerClosed!: () => void; const closed = new Promise<void>((resolve) => { peerClosed = resolve; });
    const upstream = await listen(createServer((_incoming, response) => {
      response.socket!.once("close", peerClosed); response.writeHead(200, { "content-type": "text/event-stream" }); response.write("data: first\n\n");
    }));
    const server = await listen(createServer(app((_url, init) => fetch(upstream, init), 120)));
    const before = Date.now(); let output = "";
    await new Promise<void>((resolve, reject) => {
      const outgoing = httpRequest(`${server}/api/hosted/relay/shop/`, { headers: gateway }, (incoming) => {
        incoming.on("data", (chunk) => { output += chunk; }); incoming.once("error", () => resolve()); incoming.once("end", () => resolve());
      }); outgoing.once("error", reject); outgoing.end();
    });
    expect(output).toContain("data: first"); expect(Date.now() - before).toBeLessThan(1500); await closed;
  });
  it("closes the upstream when the browser disconnects midstream", async () => {
    let peerClosed!: () => void; const closed = new Promise<void>((resolve) => { peerClosed = resolve; });
    const upstream = await listen(createServer((_incoming, response) => {
      response.socket!.once("close", peerClosed); response.writeHead(200, { "content-type": "text/event-stream" }); response.write("data: first\n\n");
    }));
    const server = await listen(createServer(app((_url, init) => fetch(upstream, init))));
    await new Promise<void>((resolve, reject) => {
      const outgoing = httpRequest(`${server}/api/hosted/relay/shop/`, { headers: gateway }, (incoming) => {
        incoming.once("data", () => { incoming.destroy(); outgoing.destroy(); resolve(); });
      }); outgoing.once("error", reject); outgoing.end();
    });
    await Promise.race([closed, new Promise<never>((_resolve, reject) => { const timeout = setTimeout(() => reject(new Error("upstream was not closed")), 1000); void closed.finally(() => clearTimeout(timeout)); })]);
  });
});
