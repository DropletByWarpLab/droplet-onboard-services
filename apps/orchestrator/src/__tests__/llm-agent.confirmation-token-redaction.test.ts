/**
 * WARP-2002 — a minted confirmation token must never reach the model.
 *
 * The agent loop feeds each tool's raw result back to the model as the tool's
 * reply, and it classifies `confirmation_required` as `ok: true` ("a UX pause,
 * not a failure") and keeps iterating. So a token left in `error.details` is
 * readable by the model, which can re-issue the same call carrying it, in the
 * same turn, with no human involved — precisely the bypass server-minted
 * tokens exist to close.
 *
 * The token still has to reach the DASHBOARD, which reads the same `details`
 * to render the "Approve & run" chip. Hence redaction on the model-visible
 * copy only, at the point it is pushed into `messages`.
 *
 * This also covers `run_scene`: `passThroughConfirmation` splats an entire
 * orchestrator 202 body — `confirmationToken` included — into `details`, so
 * the WARP-640 scene token had the same exposure.
 */
import { describe, it, expect } from "vitest";
import { redactConfirmationTokens } from "../services/llm-agent.service.js";

const TOKEN = "a".repeat(64);

describe("redactConfirmationTokens", () => {
  it("removes a token minted into a tool's error.details", () => {
    const text = JSON.stringify({
      ok: false,
      status: "confirmation_required",
      error: {
        code: "CONFIRMATION_REQUIRED",
        message: 'I\'d like to remove "kitchen strip" (node 7) from the home.',
        details: { type: "remove_device", nodeId: "7", confirmationToken: TOKEN },
      },
    });
    const out = redactConfirmationTokens(text);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain('"confirmationToken":"[redacted]"');
  });

  it("keeps everything the model legitimately needs", () => {
    const text = JSON.stringify({
      status: "confirmation_required",
      error: {
        message: "Remove kitchen strip?",
        details: { type: "remove_device", nodeId: "7", confirmationToken: TOKEN },
      },
    });
    const out = redactConfirmationTokens(text);
    // The prompt and the resolved target survive; only the secret goes.
    expect(out).toContain("Remove kitchen strip?");
    expect(out).toContain('"nodeId":"7"');
    expect(JSON.parse(out).error.details.type).toBe("remove_device");
  });

  it("redacts the scene token that passThroughConfirmation splats in", () => {
    // Shape of routes/scenes.ts's 202 body after passThroughConfirmation.
    const text = JSON.stringify({
      status: "confirmation_required",
      error: {
        details: {
          status: "confirmation_required",
          confirmationToken: TOKEN,
          sceneId: "scene-1",
          name: "Movie night",
          actionCount: 4,
        },
      },
    });
    const out = redactConfirmationTokens(text);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain('"sceneId":"scene-1"');
  });

  it("redacts every occurrence, not just the first", () => {
    const text = JSON.stringify({
      a: { confirmationToken: TOKEN },
      b: { confirmationToken: "b".repeat(64) },
    });
    const out = redactConfirmationTokens(text);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("b".repeat(64));
    expect(out.match(/\[redacted\]/g)).toHaveLength(2);
  });

  it("tolerates whitespace in the serialized form", () => {
    const out = redactConfirmationTokens(`{ "confirmationToken" : "${TOKEN}" }`);
    expect(out).not.toContain(TOKEN);
  });

  it("leaves results with no token byte-identical", () => {
    const text = JSON.stringify({ ok: true, data: { type: "list_cameras", cameras: [] } });
    expect(redactConfirmationTokens(text)).toBe(text);
  });

  it("does not choke on a non-JSON payload", () => {
    expect(redactConfirmationTokens("not json at all")).toBe("not json at all");
  });
});
