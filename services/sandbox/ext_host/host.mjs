// WARP-2900 (ADR-056 slice H2) — the first-party MCP host for a node20
// extension. The Node twin of host.py; read that file's header for the why.
//
//   node --max-old-space-size=<memoryMb> host.mjs <extension-dir>
//
// Loopback only (127.0.0.1 inside the sandbox container), POST /mcp,
// JSON-RPC with application/json responses and no SSE. tools/list is the
// verified manifest's provides.tools (name, description, inputSchema, no
// annotations); tools/call dynamically imports the manifest's entrypoint and
// calls the tool's declared named export. Every request must carry
// X-Droplet-Relay-Key equal to DROPLET_EXT_RELAY_KEY; an unset key refuses
// everything. No dependencies: node:http, node:fs, node:path, node:url only.
import { createServer } from "node:http";
import { readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { timingSafeEqual } from "node:crypto";

export const LOOPBACK = "127.0.0.1";
export const PROTOCOL_VERSION = "2025-06-18";
const MANIFEST_FILE = "extension-manifest.json";
const MAX_REQUEST_BYTES = 1024 * 1024;
const RELAY_KEY_HEADER = "x-droplet-relay-key";

export async function loadExtension(extDir) {
  const dir = realpathSync(extDir);
  const manifest = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"));
  const entry = realpathSync(join(dir, manifest.entrypoint));
  if (!entry.startsWith(dir + sep)) {
    throw new Error("the entrypoint must be inside the extension directory");
  }
  const mod = await import(pathToFileURL(entry).href);
  const tools = new Map(manifest.provides.tools.map((t) => [t.name, t]));
  return { dir, manifest, mod, tools };
}

const toolError = (text) => ({ content: [{ type: "text", text }], isError: true });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

export async function handle(ext, msg) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(null, -32600, "invalid request");
  }
  if (!("id" in msg)) return null;
  const { id, method } = msg;
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  let result;
  if (method === "initialize") {
    result = {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: ext.manifest.id, version: ext.manifest.version },
    };
  } else if (method === "ping") {
    result = {};
  } else if (method === "tools/list") {
    result = {
      tools: ext.manifest.provides.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  } else if (method === "tools/call") {
    const tool = ext.tools.get(String(params.name));
    if (!tool) return rpcError(id, -32602, `unknown tool: ${params.name}`);
    const fn = ext.mod[tool.export];
    if (typeof fn !== "function") {
      result = toolError(`export ${tool.export} is not a function`);
    } else {
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      try {
        const value = await fn(args);
        result = { content: [{ type: "text", text: JSON.stringify(value) }], isError: false };
      } catch (err) {
        result = toolError(`${err?.name ?? "Error"}: ${err?.message ?? String(err)}`);
      }
    }
  } else {
    return rpcError(id, -32601, `method not found: ${method}`);
  }
  return { jsonrpc: "2.0", id, result };
}

function keyMatches(given, expected) {
  if (!expected || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function makeServer(ext, relayKey) {
  return createServer((req, res) => {
    const send = (status, body) => {
      const data = body === null ? "" : JSON.stringify(body);
      res.writeHead(status, {
        ...(body === null ? {} : { "Content-Type": "application/json" }),
        "Content-Length": Buffer.byteLength(data),
      });
      res.end(data);
    };
    if (req.method !== "POST" || req.url !== "/mcp") {
      send(req.method === "POST" ? 404 : 405, { error: "POST /mcp only" });
      return;
    }
    if (!keyMatches(req.headers[RELAY_KEY_HEADER], relayKey)) {
      send(401, { error: "unauthorized" });
      return;
    }
    const chunks = [];
    let size = 0;
    let refused = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES && !refused) {
        refused = true;
        send(413, { error: "request too large" });
        req.destroy();
        return;
      }
      if (!refused) chunks.push(chunk);
    });
    req.on("end", async () => {
      if (refused) return;
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        send(400, rpcError(null, -32700, "parse error"));
        return;
      }
      const response = await handle(ext, msg);
      send(response === null ? 202 : 200, response);
    });
  });
}

async function main(argv) {
  if (argv.length !== 1) {
    process.stderr.write("usage: host.mjs <extension-dir>\n");
    process.exit(2);
  }
  const port = Number(process.env.DROPLET_EXT_PORT);
  const ext = await loadExtension(argv[0]);
  makeServer(ext, process.env.DROPLET_EXT_RELAY_KEY ?? "").listen(port, LOOPBACK);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main(process.argv.slice(2));
}
