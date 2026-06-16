import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer as createHttpServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_BIN = resolve(__dirname, "../dist/index.js");

const MOCK_STATUS_PAYLOAD = {
  wan: { ip: "203.0.113.42", connected: true },
  lan: { interface: "br-lan", connected_devices: 7 },
  wifi: { enabled: true, ssid: "DropletNet" },
  router: { uptime_s: 12345 },
};

describe("stdio roundtrip", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let orchestratorMock: Server;
  let orchestratorHits = 0;

  beforeAll(async () => {
    // Stand up a tiny HTTP fake at a free port so the orchestrator-backed
    // network tool (`get_network_status`, which proxies the orchestrator's
    // /api/network/status safety-tiered surface) can call it without
    // depending on a live orchestrator. ORCHESTRATOR_URL is the knob the
    // mcp-server reads for that target.
    orchestratorMock = createHttpServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/network/status") {
        orchestratorHits++;
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(MOCK_STATUS_PAYLOAD));
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    await new Promise<void>((r) => orchestratorMock.listen(0, "127.0.0.1", r));
    const addr = orchestratorMock.address();
    if (!addr || typeof addr === "string") throw new Error("orchestrator mock did not bind");
    const ORCHESTRATOR_MOCK_URL = `http://127.0.0.1:${addr.port}`;

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_BIN, "--transport=stdio"],
      env: {
        ...process.env,
        ORCHESTRATOR_URL: ORCHESTRATOR_MOCK_URL,
      },
    });
    client = new Client(
      { name: "stdio-roundtrip-test", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await new Promise<void>((r) => orchestratorMock?.close(() => r()));
  });

  it("tools/list exposes the WARP-100 vertical slice + every WARP-102 port", async () => {
    // WARP-102 grew the registry from 5 to 56 tools. We assert the original
    // slice names are still present (the foundation contract) plus a sample
    // of WARP-102 ports across domains. A full-set equality assertion would
    // be brittle and re-tested by `packages/tools-core/__tests__/registry.test.ts`.
    const res = await client.listTools();
    const names = new Set(res.tools.map((t) => t.name));

    // WARP-100 vertical slice — must always be present.
    for (const name of [
      "block_network_device",
      "get_network_status",
      "list_files",
      "list_network_devices",
      "list_smart_home_devices",
    ]) {
      expect(names.has(name), `slice tool missing: ${name}`).toBe(true);
    }

    // Spot-check one tool per WARP-102 domain so the stdio roundtrip
    // confirms the port actually reached the registry-over-the-wire.
    // Reviewer follow-up: include the three highest-risk destructive
    // ports (`setup_camera_ports`, `accept_discovered_camera`,
    // `add_port_forward`) so the live MCP roundtrip exercises high-risk
    // paths, not just one read tool per domain.
    for (const name of [
      "set_wifi_ssid", // network write
      "add_port_forward", // network write — port-forward rule (high-risk)
      "write_file", // files write
      "control_device", // smart-home write
      "commission_device", // smart-home write+confirm (Matter pairing)
      "list_cameras", // cameras read
      "accept_discovered_camera", // cameras write — commissions onto LAN (high-risk)
      "set_port_poe", // switch write
      "setup_camera_ports", // switch write+confirm — VLAN+PoE+uplink (high-risk)
      "create_event", // calendar
      "create_reminder", // reminders
      "send_notification", // notifications
      "get_system_health", // system
    ]) {
      expect(names.has(name), `WARP-102 port missing: ${name}`).toBe(true);
    }

    // Sanity: at least 50 tools advertised.
    expect(res.tools.length).toBeGreaterThanOrEqual(50);
  });

  it("tools/call get_network_status proxies to the orchestrator network surface and returns the payload", async () => {
    const res = await client.callTool({ name: "get_network_status", arguments: {} });
    expect(res.isError).toBe(false);
    const blocks = res.content as { type: string; text: string }[];
    expect(blocks[0].type).toBe("text");
    const parsed = JSON.parse(blocks[0].text);
    expect(parsed).toEqual(MOCK_STATUS_PAYLOAD);
    expect(orchestratorHits).toBeGreaterThan(0);
  });
});
