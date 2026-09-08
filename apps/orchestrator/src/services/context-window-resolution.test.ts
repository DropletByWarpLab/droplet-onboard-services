/**
 * WARP-2851 — `resolveTurnContextWindow`, the one place that decides how many
 * tokens a turn may spend.
 *
 * Before this existed, all three budget sites in `routes/llm.ts` passed
 * `config.OLLAMA_CONTEXT_LENGTH` regardless of provider, so a 200,000-token
 * cloud model was budgeted at 16,384. The failure was not subtle: the tool
 * advertisement ceiling threw, `degradeToFit` dropped the business, persona
 * and brain blocks, and the in-loop guard ended the turn with
 * `stop_reason: "context_budget"` — with ~92% of the window unused.
 *
 * The fail-safe direction is DOWN. Over-stating a window is the WARP-854
 * overflow (empty answers); under-stating it only costs headroom. Every test
 * below that feeds a value the catalogue cannot vouch for asserts the LOCAL
 * window, never a guess.
 */
import { describe, it, expect } from "vitest";
import {
  resolveTurnContextWindow,
  MAX_RESOLVABLE_CONTEXT_WINDOW,
  DEFAULT_CONTEXT_WINDOW,
} from "./context-budget.service.js";

const LOCAL = DEFAULT_CONTEXT_WINDOW; // 16384

describe("resolveTurnContextWindow", () => {
  it("uses the model's own window when it fits under the ceiling", () => {
    const r = resolveTurnContextWindow({
      advertised: MAX_RESOLVABLE_CONTEXT_WINDOW - 1,
      localWindow: LOCAL,
    });

    expect(r.source).toBe("catalogue");
    expect(r.window).toBe(MAX_RESOLVABLE_CONTEXT_WINDOW - 1);
  });

  // ⚠ BOTH shipping cloud providers exceed the ceiling, so today this is the
  // live path for every catalogued model, not an edge case. The binding limit
  // on this box is the ai-gateway's 128,000-char content cap, NOT the model:
  // anthropic's 200,000 and openai's 128,000 are equally unreachable through
  // it. This change is therefore worth 16,384 → MAX_RESOLVABLE_CONTEXT_WINDOW
  // (~2.1x), not 16,384 → 200,000. Raising the gateway cap is a separate
  // decision with its own memory/DoS trade-off (see `_MAX_TOTAL_CONTENT_CHARS`
  // and its "100 messages × 32k chars = 3.2MB" rationale).
  describe("caps every window larger than the gateway can carry", () => {
    const shipping: [string, number][] = [
      ["anthropic (200000)", 200_000],
      ["openai (128000)", 128_000],
    ];

    for (const [label, advertised] of shipping) {
      it(label, () => {
        const r = resolveTurnContextWindow({ advertised, localWindow: LOCAL });

        expect(r.source).toBe("catalogue_capped");
        expect(r.window).toBe(MAX_RESOLVABLE_CONTEXT_WINDOW);
        expect(r.window).toBeLessThan(advertised);
        // The advertised figure survives for the log line — a capped budget
        // must still be able to say what it capped.
        expect(r.advertised).toBe(advertised);
        // …and it is still a real gain over what every turn got before.
        expect(r.window).toBeGreaterThan(LOCAL);
      });
    }
  });

  describe("falls back to the local window for anything the catalogue cannot vouch for", () => {
    // `null` is the shipping local case: ollama_local.py publishes
    // context_window=None for every model it serves.
    const unvouched: [string, number | null | undefined][] = [
      ["null (every local model)", null],
      ["undefined (unknown id, or gateway unreachable)", undefined],
      ["zero", 0],
      ["negative", -1],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
    ];

    for (const [label, advertised] of unvouched) {
      it(label, () => {
        const r = resolveTurnContextWindow({ advertised, localWindow: LOCAL });

        expect(r.source).toBe("local_default");
        expect(r.window).toBe(LOCAL);
        expect(r.advertised).toBeNull();
      });
    }
  });

  it("honours a catalogue window SMALLER than the local setting", () => {
    // Not a fallback case. A small cloud model's real window is authoritative,
    // and honouring it is what stops us over-filling it — the same WARP-854
    // failure in the other direction.
    const r = resolveTurnContextWindow({ advertised: 8_192, localWindow: LOCAL });

    expect(r.source).toBe("catalogue");
    expect(r.window).toBe(8_192);
  });

  it("respects an injected ceiling (the seam the guard test pins)", () => {
    const r = resolveTurnContextWindow({
      advertised: 200_000,
      localWindow: LOCAL,
      ceiling: 20_000,
    });

    expect(r.window).toBe(20_000);
    expect(r.source).toBe("catalogue_capped");
  });

  it("never returns a window the local setting alone would have produced, when the catalogue spoke", () => {
    // Guards the whole point of the change: a cloud turn must not silently
    // resolve to 16384 just because that is what every turn used to get.
    const r = resolveTurnContextWindow({ advertised: 128_000, localWindow: LOCAL });
    expect(r.window).not.toBe(LOCAL);
  });
});
