/**
 * WARP-1440 — `search_camera_events` LLM tool.
 *
 * Natural-language semantic search over recorded camera events via the
 * orchestrator's `GET /api/cameras/events/search` (Frigate CLIP
 * embeddings). Tier-1 read — no writes, no confirmation.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import searchCameraEvents from "../../../src/handlers/cameras/search-camera-events.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(orchestratorGet: Mock): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: {
        get: orchestratorGet,
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

// Two events in the route's EventDetail shape (camera.service.ts
// searchEventsSemanticTyped) — passed through untouched by the tool.
const EVENTS = [
  {
    id: "1719000000.123-abc",
    camera: "front_door",
    label: "car",
    score: 0.91,
    startTime: 1719000000.1,
    endTime: 1719000042.5,
    thumbnail: "/api/cameras/events/1719000000.123-abc/thumbnail",
    hasClip: true,
    hasSnapshot: true,
    subLabel: null,
    subLabelScore: null,
    zones: ["driveway"],
    retainIndefinitely: false,
    clipUrl: "/api/cameras/clips/event/1719000000.123-abc",
    snapshotUrl: "/api/cameras/events/1719000000.123-abc/snapshot",
    description: "A white delivery truck backs into the driveway.",
  },
  {
    id: "1719000100.456-def",
    camera: "garage",
    label: "person",
    score: 0.72,
    startTime: 1719000100.4,
    endTime: null,
    thumbnail: "/api/cameras/events/1719000100.456-def/thumbnail",
    hasClip: false,
    hasSnapshot: false,
    subLabel: null,
    subLabelScore: null,
    zones: [],
    retainIndefinitely: false,
    clipUrl: null,
    snapshotUrl: null,
    description: null,
  },
];

const SEMANTIC_DISABLED_HINT =
  "Semantic search isn't enabled on this Frigate. Add `semantic_search.enabled: true` to config.yml under your model section, save from the System page, and try again.";

function jsonGet(body: unknown, status = 200): Mock {
  // Fresh Response per call — a Response body can only be read once.
  return vi
    .fn()
    .mockImplementation(
      async () => new Response(JSON.stringify(body), { status }),
    );
}

function expectError(
  res: Awaited<ReturnType<typeof searchCameraEvents.handler>>,
  code: string,
): void {
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe("error");
    expect(res.error.code).toBe(code);
  }
}

describe("search_camera_events", () => {
  it("searches with just a query and passes the route's events through", async () => {
    const get = jsonGet({ events: EVENTS, nextCursor: null });
    const ctx = ctxWith(get);

    const res = await searchCameraEvents.handler(
      { query: "delivery truck last week" },
      ctx,
    );

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/cameras/events/search", {
      params: { query: "delivery truck last week" },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "search_camera_events",
        query: "delivery truck last week",
        events: EVENTS,
        count: 2,
      });
    }
  });

  it("forwards camera (as the route's `cameras` param), limit, and search_type", async () => {
    const get = jsonGet({ events: [EVENTS[0]], nextCursor: null });
    const res = await searchCameraEvents.handler(
      {
        query: "white truck",
        camera: "front_door",
        limit: 25,
        search_type: "description",
      },
      ctxWith(get),
    );

    expect(get).toHaveBeenCalledWith("/api/cameras/events/search", {
      params: {
        query: "white truck",
        cameras: "front_door",
        limit: 25,
        search_type: "description",
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "search_camera_events",
        query: "white truck",
        events: [EVENTS[0]],
        count: 1,
      });
    }
  });

  it("clamps an out-of-range limit into 1..50", async () => {
    const get = jsonGet({ events: [], nextCursor: null });
    await searchCameraEvents.handler(
      { query: "cat", limit: 500 },
      ctxWith(get),
    );
    expect(get).toHaveBeenCalledWith("/api/cameras/events/search", {
      params: { query: "cat", limit: 50 },
    });
  });

  it("returns an empty result cleanly when nothing matches", async () => {
    const get = jsonGet({ events: [], nextCursor: null });
    const res = await searchCameraEvents.handler(
      { query: "unicorn" },
      ctxWith(get),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "search_camera_events",
        query: "unicorn",
        events: [],
        count: 0,
      });
    }
  });

  it("maps the route's 503 to SEMANTIC_SEARCH_DISABLED with the route's hint text", async () => {
    const get = jsonGet({ error: SEMANTIC_DISABLED_HINT }, 503);
    const res = await searchCameraEvents.handler(
      { query: "delivery truck" },
      ctxWith(get),
    );
    expectError(res, "SEMANTIC_SEARCH_DISABLED");
    if (!res.ok) {
      expect(res.error.message).toBe(SEMANTIC_DISABLED_HINT);
      expect(res.error.message).toContain("semantic_search.enabled: true");
    }
  });

  it("still maps a 503 with an unparseable body to SEMANTIC_SEARCH_DISABLED", async () => {
    const get = vi
      .fn()
      .mockImplementation(
        async () => new Response("upstream said no", { status: 503 }),
      );
    const res = await searchCameraEvents.handler(
      { query: "delivery truck" },
      ctxWith(get),
    );
    expectError(res, "SEMANTIC_SEARCH_DISABLED");
    if (!res.ok) {
      expect(res.error.message).toContain("Semantic search isn't enabled");
    }
  });

  it("maps another non-OK status to SEARCH_FAILED", async () => {
    const get = jsonGet({ error: "boom" }, 500);
    const res = await searchCameraEvents.handler(
      { query: "delivery truck" },
      ctxWith(get),
    );
    expectError(res, "SEARCH_FAILED");
  });

  it("maps a thrown fetch error to SEARCH_FAILED", async () => {
    const get = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await searchCameraEvents.handler(
      { query: "delivery truck" },
      ctxWith(get),
    );
    expectError(res, "SEARCH_FAILED");
  });

  it("rejects a missing query with INVALID_ARGS (no HTTP call)", async () => {
    const get = vi.fn();
    const res = await searchCameraEvents.handler({}, ctxWith(get));
    expectError(res, "INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects an empty query with INVALID_ARGS (no HTTP call)", async () => {
    const get = vi.fn();
    const res = await searchCameraEvents.handler({ query: "" }, ctxWith(get));
    expectError(res, "INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only query with INVALID_ARGS (no HTTP call)", async () => {
    const get = vi.fn();
    const res = await searchCameraEvents.handler(
      { query: "   " },
      ctxWith(get),
    );
    expectError(res, "INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a query over 300 characters with INVALID_ARGS (no HTTP call)", async () => {
    const get = vi.fn();
    const res = await searchCameraEvents.handler(
      { query: "x".repeat(301) },
      ctxWith(get),
    );
    expectError(res, "INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a non-string query with INVALID_ARGS (no HTTP call)", async () => {
    const get = vi.fn();
    const res = await searchCameraEvents.handler({ query: 42 }, ctxWith(get));
    expectError(res, "INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects an invalid camera name with INVALID_ARGS (no HTTP call)", async () => {
    const get = vi.fn();
    const res = await searchCameraEvents.handler(
      { query: "truck", camera: "front door!" },
      ctxWith(get),
    );
    expectError(res, "INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects an unknown search_type with INVALID_ARGS (no HTTP call)", async () => {
    const get = vi.fn();
    const res = await searchCameraEvents.handler(
      { query: "truck", search_type: "audio" },
      ctxWith(get),
    );
    expectError(res, "INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });
});

describe("search_camera_events — tool metadata", () => {
  it("is named search_camera_events and is Tier-1 (no write, no confirm)", () => {
    expect(searchCameraEvents.name).toBe("search_camera_events");
    expect(searchCameraEvents.requiresWrite).toBe(false);
    expect(searchCameraEvents.requiresConfirmation).toBe(false);
  });

  it("has an additionalProperties:false schema requiring only query", () => {
    const schema = searchCameraEvents.inputSchema as {
      additionalProperties?: boolean;
      required?: readonly string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["query"]);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      "camera",
      "limit",
      "query",
      "search_type",
    ]);
  });
});
