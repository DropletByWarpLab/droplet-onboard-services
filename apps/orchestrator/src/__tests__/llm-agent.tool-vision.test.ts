/**
 * WARP-3692 — the agent loop hands a tool's image to the model.
 *
 * Pins the loop-side contract (placement, pairing, secrecy of the bytes); the
 * who-may-see-what policy is pinned in services/tool-vision.service.test.ts.
 * The tool payloads come from the REAL tools-core handlers (WARP-1604: no
 * hand-typed wire text).
 */
import { describe, it, expect, vi } from "vitest";
import { getTool, type ToolContext } from "@droplet/tools-core";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";
import type { SSEEvent } from "../types/sse-events.js";
import {
  createToolVision,
  type ToolVision,
  type ToolVisionPorts,
} from "../services/tool-vision.service.js";

const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]).toString("base64");
const BYTES_MARKER = JPEG_B64;

async function wire(name: string, args: Record<string, unknown>): Promise<string> {
  const ctx = { userId: "u1", role: "owner", ncToken: "t", http: {} } as unknown as ToolContext;
  const result = await getTool(name)!.handler(args, ctx);
  if (!result.ok) throw new Error(`${name} failed`);
  return JSON.stringify(result.data);
}

type Msg = { role: string; content: unknown; tool_call_id?: string; tool_calls?: { id: string }[] };

function assistantCalls(...calls: { id: string; name: string; args: Record<string, unknown> }[]) {
  return {
    role: "assistant",
    content: null,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    })),
  };
}

function harness(opts: {
  turns: unknown[];
  toolText: (name: string, args: Record<string, unknown>) => Promise<string> | string;
  toolVision?: ToolVision;
  contextWindow?: number;
}) {
  const requests: { messages: Msg[] }[] = [];
  const chat = vi.fn().mockImplementation(async (req: { messages: Msg[] }) => {
    requests.push({ messages: structuredClone(req.messages) });
    const message = opts.turns[Math.min(requests.length - 1, opts.turns.length - 1)];
    return { ok: true, json: async () => ({ choices: [{ message }] }) };
  });
  const events: SSEEvent[] = [];
  const deps: AgentDeps = {
    mcp: {
      listTools: vi.fn().mockResolvedValue(
        ["get_camera_snapshot", "list_cameras"].map((name) => ({ name, description: "d", inputSchema: {} })),
      ),
      callTool: vi.fn().mockImplementation(async (name: string, args: Record<string, unknown>) => ({
        isError: false,
        content: [{ type: "text", text: await opts.toolText(name, args) }],
      })),
    } as never,
    aiGateway: { chat } as never,
    onEvent: (e) => events.push(e),
  };
  const run = () =>
    runAgent(deps, {
      model: "vision-model",
      messages: [{ role: "user", content: "is anyone at the front door?" }],
      max_iter: 6,
      context_window: opts.contextWindow,
      toolVision: opts.toolVision,
    });
  return { run, requests, events };
}

function visionPorts(over: Partial<ToolVisionPorts> = {}): ToolVisionPorts {
  const jpeg = () => new Response(Buffer.from(JPEG_B64, "base64"));
  return {
    canAccessCamera: vi.fn().mockResolvedValue(true),
    eventCamera: vi.fn().mockResolvedValue("front_door"),
    fetchFrame: vi.fn().mockImplementation(async () => jpeg()),
    fetchEventSnapshot: vi.fn().mockImplementation(async () => jpeg()),
    fetchEventThumbnail: vi.fn().mockImplementation(async () => jpeg()),
    fetchRecordingFrame: vi.fn().mockImplementation(async () => jpeg()),
    fileId: vi.fn().mockResolvedValue(null),
    fileThumbnail: vi.fn().mockResolvedValue(null),
    brainImage: vi.fn().mockResolvedValue(null),
    auditCamera: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

const answer = { role: "assistant", content: "Nobody is at the front door." };
const toolVisionFor = (over: Partial<ToolVisionPorts> = {}, flags: { vision?: boolean; offLan?: boolean } = {}) =>
  createToolVision({
    offLan: flags.offLan ?? false,
    isVisionModel: async () => flags.vision ?? true,
    ports: visionPorts(over),
  });

describe("runAgent — tool images (WARP-3692)", () => {
  it("injects the image as a user message right AFTER the tool result, before the next model call", async () => {
    const h = harness({
      turns: [assistantCalls({ id: "c1", name: "get_camera_snapshot", args: { camera: "front_door" } }), answer],
      toolText: (n, a) => wire(n, a),
      toolVision: toolVisionFor(),
    });
    const result = await h.run();
    expect(result.message.content).toBe("Nobody is at the front door.");

    const second = h.requests[1]!.messages;
    const iAsst = second.findIndex((m) => m.role === "assistant" && m.tool_calls);
    expect(second[iAsst + 1]).toMatchObject({ role: "tool", tool_call_id: "c1" });
    const injected = second[iAsst + 2]!;
    expect(injected.role).toBe("user");
    const blocks = injected.content as { type: string; text?: string; image_url?: { url: string } }[];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    expect(text).toMatch(/\[Image from tool get_camera_snapshot: front_door, captured \d{4}-\d{2}-\d{2}T/);
    const image = blocks.find((b) => b.type === "image_url")!;
    expect(image.image_url!.url).toBe(`data:image/jpeg;base64,${JPEG_B64}`);
    // It is the LAST message the model gets: nothing was reordered after it.
    expect(iAsst + 2).toBe(second.length - 1);
    // The first call (before any tool ran) carried no image.
    expect(JSON.stringify(h.requests[0]!.messages)).not.toContain("image_url");
  });

  it("keeps tool_call / tool-result pairing intact with parallel calls: ONE user message after ALL tool results", async () => {
    const h = harness({
      turns: [
        assistantCalls(
          { id: "a", name: "get_camera_snapshot", args: { camera: "front_door" } },
          { id: "b", name: "get_camera_snapshot", args: { camera: "driveway" } },
        ),
        answer,
      ],
      toolText: (n, a) => wire(n, a),
      toolVision: toolVisionFor(),
    });
    await h.run();
    const second = h.requests[1]!.messages;
    const iAsst = second.findIndex((m) => m.role === "assistant" && m.tool_calls);
    expect(second.slice(iAsst + 1, iAsst + 3).map((m) => [m.role, m.tool_call_id])).toEqual([
      ["tool", "a"],
      ["tool", "b"],
    ]);
    const injected = second[iAsst + 3]!;
    expect(injected.role).toBe("user");
    const images = (injected.content as { type: string }[]).filter((b) => b.type === "image_url");
    expect(images).toHaveLength(2);
    expect(second.filter((m) => m.role === "user" && Array.isArray(m.content))).toHaveLength(1);
  });

  it("never puts image bytes in the trace, the SSE stream, or the returned message", async () => {
    const h = harness({
      turns: [assistantCalls({ id: "c1", name: "get_camera_snapshot", args: { camera: "front_door" } }), answer],
      toolText: (n, a) => wire(n, a),
      toolVision: toolVisionFor(),
    });
    const result = await h.run();
    expect(JSON.stringify(result)).not.toContain(BYTES_MARKER);
    expect(JSON.stringify(h.events)).not.toContain(BYTES_MARKER);
    expect(JSON.stringify(h.events)).not.toContain("image_url");
    // …while the model DID get them (guards against a vacuous pass).
    expect(JSON.stringify(h.requests[1]!.messages)).toContain(BYTES_MARKER);
    // The descriptor, which the client renders, is still in the trace.
    expect(JSON.stringify(result.trace)).toContain("camera_snapshot");
  });

  it("a non-vision model gets a one-line note on the tool result and no image", async () => {
    const fetchFrame = vi.fn();
    const h = harness({
      turns: [assistantCalls({ id: "c1", name: "get_camera_snapshot", args: { camera: "front_door" } }), answer],
      toolText: (n, a) => wire(n, a),
      toolVision: toolVisionFor({ fetchFrame }, { vision: false }),
    });
    await h.run();
    const second = h.requests[1]!.messages;
    const tool = second.find((m) => m.role === "tool")!;
    expect(String(tool.content)).toContain("[image not viewable by the current model; the user can see it inline]");
    expect(JSON.stringify(second)).not.toContain("image_url");
    expect(fetchFrame).not.toHaveBeenCalled();
  });

  it("an off-LAN turn is told the image was withheld and is sent nothing", async () => {
    const fetchFrame = vi.fn();
    const h = harness({
      turns: [assistantCalls({ id: "c1", name: "get_camera_snapshot", args: { camera: "front_door" } }), answer],
      toolText: (n, a) => wire(n, a),
      toolVision: toolVisionFor({ fetchFrame }, { offLan: true }),
    });
    await h.run();
    const second = h.requests[1]!.messages;
    expect(String(second.find((m) => m.role === "tool")!.content)).toContain("image withheld");
    expect(JSON.stringify(second)).not.toContain("image_url");
    expect(fetchFrame).not.toHaveBeenCalled();
  });

  it("an ACL denial leaves the tool result unchanged apart from a could-not-view note", async () => {
    const h = harness({
      turns: [assistantCalls({ id: "c1", name: "get_camera_snapshot", args: { camera: "bedroom" } }), answer],
      toolText: (n, a) => wire(n, a),
      toolVision: toolVisionFor({ canAccessCamera: vi.fn().mockResolvedValue(false) }),
    });
    await h.run();
    const second = h.requests[1]!.messages;
    const tool = String(second.find((m) => m.role === "tool")!.content);
    expect(tool).toContain('"camera":"bedroom"');
    expect(tool).toContain("[could not view the image; the user can see it inline]");
    expect(JSON.stringify(second)).not.toContain("image_url");
  });

  it("with no toolVision wired (voice, runs, email analysis) the loop is unchanged", async () => {
    const h = harness({
      turns: [assistantCalls({ id: "c1", name: "get_camera_snapshot", args: { camera: "front_door" } }), answer],
      toolText: (n, a) => wire(n, a),
    });
    await h.run();
    const second = h.requests[1]!.messages;
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(String(second[2]!.content)).not.toContain("[image");
  });

  it("does not look at a tool result that carries no media", async () => {
    const inspect = vi.fn().mockResolvedValue({ blocks: [], notes: [], attached: 0 });
    const h = harness({
      turns: [assistantCalls({ id: "c1", name: "list_cameras", args: {} }), answer],
      toolText: () => JSON.stringify({ cameras: [] }),
      toolVision: { inspect },
    });
    await h.run();
    expect(h.requests[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  });

  it("a throwing vision service cannot fail the tool call or the turn", async () => {
    const h = harness({
      turns: [assistantCalls({ id: "c1", name: "get_camera_snapshot", args: { camera: "front_door" } }), answer],
      toolText: (n, a) => wire(n, a),
      toolVision: { inspect: vi.fn().mockRejectedValue(new Error("boom")) },
    });
    const result = await h.run();
    expect(result.stop_reason).toBe("model_done");
    expect(result.message.content).toBe("Nobody is at the front door.");
  });

  it("a 1 MB-class image does not trip the context guard (charged a bounded cost, not its base64)", async () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(900_000, 1)]);
    const h = harness({
      turns: [
        assistantCalls({ id: "c1", name: "get_camera_snapshot", args: { camera: "front_door" } }),
        assistantCalls({ id: "c2", name: "list_cameras", args: {} }),
        answer,
      ],
      toolText: async (n, a) => (n === "list_cameras" ? JSON.stringify({ cameras: [] }) : wire(n, a)),
      toolVision: toolVisionFor({ fetchFrame: vi.fn().mockImplementation(async () => new Response(big)) }),
      contextWindow: 16_384,
    });
    const result = await h.run();
    expect(result.stop_reason).toBe("model_done");
    expect(result.iterations).toBe(3);
  });
});
