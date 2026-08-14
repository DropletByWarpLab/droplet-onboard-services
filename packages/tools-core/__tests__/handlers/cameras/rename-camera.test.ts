import { describe, it, expect, vi } from "vitest";
import renameCamera from "../../../src/handlers/cameras/rename-camera.js";
import type { ToolContext } from "../../../src/types.js";

/**
 * WARP-1893 — rename_camera changes a camera's household-facing label.
 *
 * Two invariants carry most of the weight here:
 *
 *  1. RESOLUTION NEVER GUESSES. Users say "the driveway camera", so the
 *     handler matches on config key OR display name — but `displayName` is
 *     deliberately not unique, so a two-camera match must be an error, not
 *     a coin flip. Renaming the wrong camera is silent and confusing.
 *  2. NOTHING IS WRITTEN UNTIL RESOLUTION SUCCEEDS. Every rejection path
 *     asserts the PATCH was never issued.
 */
function ctxWith(
  get: ReturnType<typeof vi.fn>,
  patch: ReturnType<typeof vi.fn>,
): ToolContext {
  return {
    http: {
      orchestrator: { get, post: vi.fn(), patch, delete: vi.fn() },
      cameras: {} as ToolContext["http"]["cameras"],
      routing: {} as ToolContext["http"]["routing"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    userId: "alice",
    signal: new AbortController().signal,
  };
}

/** A `GET /api/cameras` stub returning the given rows. */
function listing(cameras: Array<{ name: string; displayName?: string | null }>) {
  return vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ cameras }), { status: 200 }));
}

const okPatch = () => vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

const TWO_CAMERAS = [
  { name: "front_door", displayName: "Front Door" },
  { name: "xnv_c8083r_e43022502afd", displayName: "Xnv C8083r E43022502afd" },
];

describe("rename_camera", () => {
  it("resolves by config key and PATCHes the new display name", async () => {
    const get = listing(TWO_CAMERAS);
    const patch = okPatch();

    const r = await renameCamera.handler(
      { camera: "xnv_c8083r_e43022502afd", display_name: "Driveway" },
      ctxWith(get, patch),
    );

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("/api/cameras/xnv_c8083r_e43022502afd", {
      displayName: "Driveway",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toMatchObject({
        type: "rename_camera",
        camera: "xnv_c8083r_e43022502afd",
        previousDisplayName: "Xnv C8083r E43022502afd",
        displayName: "Driveway",
      });
    }
  });

  it("resolves by CURRENT display name, case-insensitively — 'the front door camera'", async () => {
    const get = listing(TWO_CAMERAS);
    const patch = okPatch();

    const r = await renameCamera.handler(
      { camera: "front door", display_name: "Porch" },
      ctxWith(get, patch),
    );

    expect(r.ok).toBe(true);
    expect(patch).toHaveBeenCalledWith("/api/cameras/front_door", { displayName: "Porch" });
  });

  it("an exact config-key hit beats another camera's colliding display name", async () => {
    // `garage` is BOTH the id of one camera and the label of another. The id
    // is unique, so it must win — otherwise the unambiguous reading loses to
    // the ambiguous one.
    const get = listing([
      { name: "garage", displayName: "Bikes" },
      { name: "cam_2", displayName: "Garage" },
    ]);
    const patch = okPatch();

    const r = await renameCamera.handler(
      { camera: "garage", display_name: "Workshop" },
      ctxWith(get, patch),
    );

    expect(r.ok).toBe(true);
    expect(patch).toHaveBeenCalledWith("/api/cameras/garage", { displayName: "Workshop" });
  });

  it("refuses to guess when two cameras share a display name — no PATCH", async () => {
    const get = listing([
      { name: "cam_1", displayName: "Side Gate" },
      { name: "cam_2", displayName: "Side Gate" },
    ]);
    const patch = okPatch();

    const r = await renameCamera.handler(
      { camera: "Side Gate", display_name: "North Gate" },
      ctxWith(get, patch),
    );

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("CAMERA_AMBIGUOUS");
      // The message must name both candidates so the model can ask usefully.
      expect(r.error.message).toContain("cam_1");
      expect(r.error.message).toContain("cam_2");
    }
    expect(patch).not.toHaveBeenCalled();
  });

  it("unknown camera → CAMERA_NOT_FOUND listing what does exist, no PATCH", async () => {
    const get = listing(TWO_CAMERAS);
    const patch = okPatch();

    const r = await renameCamera.handler(
      { camera: "basement", display_name: "Cellar" },
      ctxWith(get, patch),
    );

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("CAMERA_NOT_FOUND");
      expect(r.error.message).toContain("front_door");
    }
    expect(patch).not.toHaveBeenCalled();
  });

  it("no cameras configured → CAMERA_NOT_FOUND, no PATCH", async () => {
    const get = listing([]);
    const patch = okPatch();

    const r = await renameCamera.handler(
      { camera: "front_door", display_name: "Porch" },
      ctxWith(get, patch),
    );

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("CAMERA_NOT_FOUND");
    expect(patch).not.toHaveBeenCalled();
  });

  it("a failing camera listing surfaces CAMERAS_UNAVAILABLE, no PATCH", async () => {
    const get = vi.fn().mockResolvedValue(new Response("boom", { status: 503 }));
    const patch = okPatch();

    const r = await renameCamera.handler(
      { camera: "front_door", display_name: "Porch" },
      ctxWith(get, patch),
    );

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("CAMERAS_UNAVAILABLE");
      expect(r.error.message).toContain("503");
    }
    expect(patch).not.toHaveBeenCalled();
  });

  it("rejects bad arguments with INVALID_ARGS before any HTTP at all", async () => {
    const get = listing(TWO_CAMERAS);
    const patch = okPatch();
    const badArgs: Array<Record<string, unknown>> = [
      {},
      { camera: "", display_name: "Porch" },
      { camera: "   ", display_name: "Porch" },
      { camera: 42, display_name: "Porch" },
      { camera: "front_door" },
      { camera: "front_door", display_name: "" },
      { camera: "front_door", display_name: "   " },
      { camera: "front_door", display_name: 7 },
      // 65 chars — one past the route's cap.
      { camera: "front_door", display_name: "x".repeat(65) },
      // NOTE: a merely trailing-space name like "Porch " is NOT invalid —
      // it trims to a valid label. Asserted in the trimming test below.
      // Newlines would break log lines and every surface that renders it.
      { camera: "front_door", display_name: "Porch\nDoor" },
    ];

    for (const args of badArgs) {
      const r = await renameCamera.handler(args, ctxWith(get, patch));
      expect(r.ok, `expected INVALID_ARGS for ${JSON.stringify(args)}`).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    }
    // Validation runs before resolution, so not even the listing is fetched.
    expect(get).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("accepts a 64-char name and trims surrounding whitespace", async () => {
    const get = listing(TWO_CAMERAS);
    const patch = okPatch();
    const exactly64 = "y".repeat(64);

    const r = await renameCamera.handler(
      { camera: "  front_door  ", display_name: `  ${exactly64}  ` },
      ctxWith(get, patch),
    );

    expect(r.ok).toBe(true);
    expect(patch).toHaveBeenCalledWith("/api/cameras/front_door", { displayName: exactly64 });
  });

  it("sends NFC to the orchestrator and echoes NFC back to the model", async () => {
    // WARP-1893 review — iOS dictation and some IMEs emit decomposed (NFD)
    // strings. The route normalizes on write; the handler normalizes too so
    // the displayName it echoes in its result matches what was persisted.
    const nfd = "Cafe\u0301"; // "Cafe" + combining acute (decomposed)
    const nfc = "Caf\u00e9"; // precomposed
    expect(nfd).not.toBe(nfc); // the fixture really is two byte forms
    const get = listing(TWO_CAMERAS);
    const patch = okPatch();

    const r = await renameCamera.handler(
      { camera: "front_door", display_name: nfd },
      ctxWith(get, patch),
    );

    expect(r.ok).toBe(true);
    expect(patch).toHaveBeenCalledWith("/api/cameras/front_door", { displayName: nfc });
    if (r.ok) {
      expect(r.data).toMatchObject({ displayName: nfc });
    }
  });

  it("percent-encodes the camera id into the path", async () => {
    // CAMERA_NAME_RE keeps ids tame, but the handler must not build the URL
    // by naive concatenation regardless.
    const get = listing([{ name: "cam-1_a", displayName: null }]);
    const patch = okPatch();

    await renameCamera.handler(
      { camera: "cam-1_a", display_name: "Yard" },
      ctxWith(get, patch),
    );
    expect(patch).toHaveBeenCalledWith("/api/cameras/cam-1_a", { displayName: "Yard" });
  });

  it("maps a PATCH 404 to CAMERA_NOT_FOUND (raced with a delete)", async () => {
    const get = listing(TWO_CAMERAS);
    const patch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "Camera not found" }), { status: 404 }),
      );

    const r = await renameCamera.handler(
      { camera: "front_door", display_name: "Porch" },
      ctxWith(get, patch),
    );

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("CAMERA_NOT_FOUND");
  });

  it("surfaces the server's own message on a PATCH rejection", async () => {
    const get = listing(TWO_CAMERAS);
    const patch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "displayName cannot be empty" }), { status: 400 }),
      );

    const r = await renameCamera.handler(
      { camera: "front_door", display_name: "Porch" },
      ctxWith(get, patch),
    );

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("RENAME_FAILED");
      expect(r.error.message).toBe("displayName cannot be empty");
    }
  });

  it("falls back to the status code when the error body is unparseable", async () => {
    const get = listing(TWO_CAMERAS);
    const patch = vi.fn().mockResolvedValue(new Response("<html>502</html>", { status: 502 }));

    const r = await renameCamera.handler(
      { camera: "front_door", display_name: "Porch" },
      ctxWith(get, patch),
    );

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("RENAME_FAILED");
      expect(r.error.message).toContain("502");
    }
  });

  describe("metadata", () => {
    it("is a write tool but NOT confirmation-gated", () => {
      // Write so `toolAllowedForTier` hides it from non-owner/admin roles;
      // unconfirmed because a label change is instantly reversible and
      // destroys nothing. Contrast delete_clip, which is both.
      expect(renameCamera.name).toBe("rename_camera");
      expect(renameCamera.requiresWrite).toBe(true);
      expect(renameCamera.requiresConfirmation).toBe(false);
    });

    it("schema requires camera + display_name and rejects unknown properties", () => {
      const schema = renameCamera.inputSchema as {
        required: string[];
        additionalProperties: boolean;
        properties: Record<string, unknown>;
      };
      expect(schema.required.sort()).toEqual(["camera", "display_name"]);
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties).sort()).toEqual(["camera", "display_name"]);
    });
  });
});
