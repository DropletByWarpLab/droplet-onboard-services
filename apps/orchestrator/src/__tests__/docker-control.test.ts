import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Server, IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// We point DOCKER_SOCKET_PATH at a temp Unix socket spun up by the test,
// then exercise the real client code against an in-process fake daemon.
const SOCKET = path.join(tmpdir(), `droplet-docker-test-${process.pid}.sock`);

let server: Server | null = null;
let nextHandler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;

beforeEach(async () => {
  process.env.DOCKER_SOCKET_PATH = SOCKET;
  if (existsSync(SOCKET)) unlinkSync(SOCKET);
  server = createServer((req, res) => {
    if (nextHandler) nextHandler(req, res);
    else { res.statusCode = 500; res.end("no handler set"); }
  });
  await new Promise<void>((resolve) => server!.listen(SOCKET, resolve));
});

afterEach(async () => {
  nextHandler = null;
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  if (existsSync(SOCKET)) unlinkSync(SOCKET);
});

// Each test imports the SUT fresh so any module-level constants are stable.
async function importSut() {
  return import("../services/docker-control.service.js");
}

const sampleContainers = [
  {
    Id: "c-frigate",
    Names: ["/docker-frigate-1"],
    Image: "frigate:0.13",
    State: "running",
    Status: "Up 2 hours",
    Labels: { "com.docker.compose.service": "frigate" },
    Created: 1776000000,
  },
  {
    Id: "c-orchestrator",
    Names: ["/docker-orchestrator-1"],
    Image: "orchestrator:dev",
    State: "running",
    Status: "Up 2 hours",
    Labels: { "com.docker.compose.service": "orchestrator" },
    Created: 1776000000,
  },
  {
    Id: "c-fileindexer",
    Names: ["/docker-file-indexer-1"],
    Image: "file-indexer:dev",
    State: "exited",
    Status: "Exited (1) 5 minutes ago",
    Labels: { "com.docker.compose.service": "file-indexer" },
    Created: 1776000000,
  },
];

describe("listContainers", () => {
  it("decodes the daemon response and stamps `restartable` from the denylist", async () => {
    nextHandler = (req, res) => {
      expect(req.method).toBe("GET");
      expect(req.url).toContain("/containers/json");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(sampleContainers));
    };
    const { listContainers } = await importSut();
    const got = await listContainers();
    expect(got.find((c) => c.service === "frigate")?.restartable).toBe(true);
    expect(got.find((c) => c.service === "orchestrator")?.restartable).toBe(false);
    expect(got.find((c) => c.service === "file-indexer")?.restartable).toBe(true);
    expect(got.every((c) => !c.name.startsWith("/"))).toBe(true);
  });
});

describe("restartContainer", () => {
  it("resolves a compose-service name to a container id and POSTs /restart", async () => {
    let postedPath = "";
    let postedMethod = "";
    nextHandler = (req, res) => {
      if (req.method === "GET") {
        res.end(JSON.stringify(sampleContainers));
      } else {
        postedPath = req.url ?? "";
        postedMethod = req.method ?? "";
        res.statusCode = 204;
        res.end();
      }
    };
    const { restartContainer } = await importSut();
    const result = await restartContainer("frigate");
    expect(result).toEqual({ service: "frigate", restarted: true });
    expect(postedMethod).toBe("POST");
    expect(postedPath).toMatch(/\/containers\/c-frigate\/restart/);
  });

  it("refuses to restart a denylisted service", async () => {
    nextHandler = (req, res) => {
      if (req.method === "GET") res.end(JSON.stringify(sampleContainers));
      else { res.statusCode = 500; res.end("should not be called"); }
    };
    const { restartContainer } = await importSut();
    await expect(restartContainer("orchestrator")).rejects.toThrow(/restart_blocked_by_denylist/);
    await expect(restartContainer("gateway")).rejects.toThrow(/container_not_found/); // not in sample but still
  });

  it("rejects a malformed container name BEFORE talking to docker", async () => {
    let calls = 0;
    nextHandler = (_req, res) => { calls++; res.end("[]"); };
    const { restartContainer } = await importSut();
    for (const bad of [
      "frigate; rm -rf /",
      "../../etc/passwd",
      "frigate'\nDROP TABLE",
      "",
      "  ",
      "name with space",
      "a".repeat(200),
    ]) {
      await expect(restartContainer(bad)).rejects.toThrow(/invalid_container_name/);
    }
    expect(calls).toBe(0);
  });

  it("returns container_not_found when the target doesn't exist", async () => {
    nextHandler = (_req, res) => { res.end(JSON.stringify(sampleContainers)); };
    const { restartContainer } = await importSut();
    await expect(restartContainer("nonexistent")).rejects.toThrow(/container_not_found: nonexistent/);
  });
});

describe("containerLogs", () => {
  it("strips Docker's stream-multiplex framing", async () => {
    // Build a multiplexed buffer: 8-byte header + payload, repeated.
    function frame(stream: 1 | 2, payload: string): Buffer {
      const buf = Buffer.from(payload);
      const header = Buffer.alloc(8);
      header[0] = stream; // 1=stdout, 2=stderr
      header.writeUInt32BE(buf.length, 4);
      return Buffer.concat([header, buf]);
    }
    const body = Buffer.concat([
      frame(1, "hello\n"),
      frame(2, "warning\n"),
      frame(1, "world\n"),
    ]);
    nextHandler = (req, res) => {
      if (req.method === "GET" && req.url?.includes("/logs")) {
        res.end(body);
      } else {
        res.end(JSON.stringify(sampleContainers));
      }
    };
    const { containerLogs } = await importSut();
    const result = await containerLogs("frigate", 100);
    expect(result.service).toBe("frigate");
    expect(result.logs).toBe("hello\nwarning\nworld\n");
    expect(result.truncated).toBe(false);
  });

  it("treats non-multiplexed (TTY) logs as plain text", async () => {
    const plain = "plain text without docker framing\n";
    nextHandler = (req, res) => {
      if (req.method === "GET" && req.url?.includes("/logs")) {
        res.end(Buffer.from(plain));
      } else {
        res.end(JSON.stringify(sampleContainers));
      }
    };
    const { containerLogs } = await importSut();
    const result = await containerLogs("frigate", 100);
    expect(result.logs).toBe(plain);
  });

  it("clamps tail between 1 and 2000 lines", async () => {
    let logsUrl = "";
    nextHandler = (req, res) => {
      if (req.method === "GET" && req.url?.includes("/logs")) {
        logsUrl = req.url ?? "";
        res.end(Buffer.from("ok\n"));
      } else {
        res.end(JSON.stringify(sampleContainers));
      }
    };
    const { containerLogs } = await importSut();
    await containerLogs("frigate", 99999);
    expect(logsUrl).toMatch(/tail=2000/);
    await containerLogs("frigate", 0);
    expect(logsUrl).toMatch(/tail=200/); // 0 → fallback default 200
  });

  it("rejects malformed container name before contacting docker", async () => {
    let calls = 0;
    nextHandler = (_req, res) => { calls++; res.end("[]"); };
    const { containerLogs } = await importSut();
    await expect(containerLogs("frig; reboot", 100)).rejects.toThrow(/invalid_container_name/);
    expect(calls).toBe(0);
  });
});

describe("SERVICE_RESTART_DENYLIST", () => {
  it("includes the orchestrator and the services it depends on", async () => {
    const { SERVICE_RESTART_DENYLIST } = await importSut();
    for (const must of ["orchestrator", "gateway", "db", "cache", "broker", "ai-gateway"]) {
      expect(SERVICE_RESTART_DENYLIST.has(must)).toBe(true);
    }
    // Sanity: services we DO want restartable should NOT be in the set.
    for (const ok of ["frigate", "homeassistant", "file-indexer", "camera-discovery", "routing", "switch"]) {
      expect(SERVICE_RESTART_DENYLIST.has(ok)).toBe(false);
    }
  });
});
