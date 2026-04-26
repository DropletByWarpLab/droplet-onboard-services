import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_BIN = resolve(__dirname, "../dist/index.js");

describe("stdio roundtrip", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_BIN, "--transport=stdio"],
    });
    client = new Client(
      { name: "stdio-roundtrip-test", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
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

  it("tools/call list_smart_home_devices returns a content block", async () => {
    const res = await client.callTool({ name: "list_smart_home_devices", arguments: {} });
    expect((res.content as { type: string }[])[0].type).toBe("text");
  });
});
