import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpClientService } from "../services/mcp-client.service.js";
import { repoPath } from "./helpers/test-paths.js";

// Anchored to this test file, not to the runner's cwd (WARP-2654), so the
// path to the mcp-server build is the same from any invocation. `__dirname`
// under the hood, not import.meta.url, which trips tsc when the workspace's
// `package.json` doesn't set `"type": "module"`.
const SERVER_BIN = repoPath("services/mcp-server/dist/index.js");

describe("McpClientService", () => {
  let svc: McpClientService;

  beforeAll(async () => {
    svc = new McpClientService({ command: process.execPath, args: [SERVER_BIN, "--transport=stdio"] });
    await svc.start();
  }, 30_000);

  afterAll(async () => {
    await svc.stop();
  });

  it("listTools caches and returns the slice", async () => {
    const a = await svc.listTools();
    const b = await svc.listTools();
    expect(a).toBe(b); // cached reference
    expect(a.map((t) => t.name).sort()).toContain("list_network_devices");
  });

  it("callTool returns parsed JSON content", async () => {
    const r = await svc.callTool("list_smart_home_devices", {});
    expect(r.content).toBeDefined();
    expect(Array.isArray(r.content)).toBe(true);
    expect(r.content[0]?.type).toBe("text");
    expect(typeof r.isError).toBe("boolean");
  });
});
