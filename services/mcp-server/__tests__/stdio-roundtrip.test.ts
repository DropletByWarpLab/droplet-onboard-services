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
  let routingMock: Server;
  let routingHits = 0;

  beforeAll(async () => {
    // Stand up a tiny HTTP fake at a free port so the routing-backed tool
    // (`get_network_status`) can call it without depending on the real
    // OpenWrt routing service. ROUTING_SERVICE_URL is the only knob the
    // mcp-server reads.
    routingMock = createHttpServer((req, res) => {
      if (req.method === "GET" && req.url === "/status") {
        routingHits++;
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(MOCK_STATUS_PAYLOAD));
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    await new Promise<void>((r) => routingMock.listen(0, "127.0.0.1", r));
    const addr = routingMock.address();
    if (!addr || typeof addr === "string") throw new Error("routing mock did not bind");
    const ROUTING_URL = `http://127.0.0.1:${addr.port}`;

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_BIN, "--transport=stdio"],
      env: {
        ...process.env,
        ROUTING_SERVICE_URL: ROUTING_URL,
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
    await new Promise<void>((r) => routingMock?.close(() => r()));
  });

  it("tools/list returns the 5 vertical-slice tools", async () => {
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "block_network_device",
      "get_network_status",
      "list_files",
      "list_network_devices",
      "list_smart_home_devices",
    ]);
  });

  it("tools/call get_network_status proxies to the routing service and returns the payload", async () => {
    const res = await client.callTool({ name: "get_network_status", arguments: {} });
    expect(res.isError).toBe(false);
    const blocks = res.content as { type: string; text: string }[];
    expect(blocks[0].type).toBe("text");
    const parsed = JSON.parse(blocks[0].text);
    expect(parsed).toEqual(MOCK_STATUS_PAYLOAD);
    expect(routingHits).toBeGreaterThan(0);
  });
});
