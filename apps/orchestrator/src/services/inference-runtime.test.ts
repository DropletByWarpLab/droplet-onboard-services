/**
 * WARP-1749 — inference-runtime: which backend, and the parsing only the
 * non-default backend needs.
 *
 * Two invariants this file exists to pin:
 *   1. NOTHING selects DMR except the literal `INFERENCE_RUNTIME=dmr`. Unset,
 *      empty, "ollama", and any typo all resolve to the default backend, so a
 *      misconfigured box degrades to today's behaviour rather than to DMR
 *      semantics it can't honour.
 *   2. A size string we cannot parse is UNKNOWN. Never 0. Printing a confident
 *      zero on the "honest metrics" page is the exact defect this ticket is
 *      about, and the parser is where a lazy `Number(x) || 0` would introduce
 *      it.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  inferenceRuntime,
  inferenceRuntimeUrl,
  isDmrRuntime,
  modelRepositoryKey,
  normalizeModelReference,
  parseHumanSizeBytes,
} from "./inference-runtime.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("inferenceRuntime()", () => {
  it("defaults to ollama when INFERENCE_RUNTIME is unset or empty", () => {
    vi.stubEnv("INFERENCE_RUNTIME", "");
    expect(inferenceRuntime()).toBe("ollama");
    expect(isDmrRuntime()).toBe(false);
  });

  it("selects dmr only for the exact word (case/whitespace tolerant)", () => {
    for (const raw of ["dmr", "DMR", "  dmr  "]) {
      vi.stubEnv("INFERENCE_RUNTIME", raw);
      expect(inferenceRuntime()).toBe("dmr");
      expect(isDmrRuntime()).toBe(true);
    }
  });

  it("falls back to ollama for an unrecognised value — never to dmr", () => {
    // ollama-manager treats this as fatal (WARP-1743), so the box is already
    // broken; this module's only duty is to not CLAIM dmr semantics. Falling
    // back to the default keeps an Ollama box's rendering intact.
    for (const raw of ["docker", "vllm", "dmr2", "ollama-dmr"]) {
      vi.stubEnv("INFERENCE_RUNTIME", raw);
      expect(inferenceRuntime()).toBe("ollama");
      expect(isDmrRuntime()).toBe(false);
    }
  });

  it("reads the env on every call, not once at import", () => {
    vi.stubEnv("INFERENCE_RUNTIME", "ollama");
    expect(isDmrRuntime()).toBe(false);
    vi.stubEnv("INFERENCE_RUNTIME", "dmr");
    expect(isDmrRuntime()).toBe(true);
  });
});

describe("inferenceRuntimeUrl()", () => {
  it("prefers INFERENCE_RUNTIME_URL, falls back to OLLAMA_URL", () => {
    vi.stubEnv("OLLAMA_URL", "http://ollama:11434");
    vi.stubEnv("INFERENCE_RUNTIME_URL", "");
    expect(inferenceRuntimeUrl()).toBe("http://ollama:11434");
    vi.stubEnv("INFERENCE_RUNTIME_URL", "http://model-runner:12434");
    expect(inferenceRuntimeUrl()).toBe("http://model-runner:12434");
  });

  it("strips trailing slashes so callers can concatenate a path", () => {
    vi.stubEnv("INFERENCE_RUNTIME_URL", "http://model-runner:12434//");
    expect(inferenceRuntimeUrl()).toBe("http://model-runner:12434");
  });
});

describe("parseHumanSizeBytes()", () => {
  it("parses the binary units DMR reports (`256.35 MiB`)", () => {
    expect(parseHumanSizeBytes("256.35 MiB")).toBeCloseTo(256.35 * 1024 ** 2, 3);
    expect(parseHumanSizeBytes("1.5 GiB")).toBeCloseTo(1.5 * 1024 ** 3, 3);
  });

  it("parses decimal units (`1.2 GB`)", () => {
    expect(parseHumanSizeBytes("1.2 GB")).toBeCloseTo(1.2e9, 3);
    expect(parseHumanSizeBytes("512 B")).toBe(512);
  });

  it("is tolerant of case and surrounding whitespace", () => {
    expect(parseHumanSizeBytes("  13.8gb ")).toBeCloseTo(13.8e9, 3);
    expect(parseHumanSizeBytes("256.35mib")).toBeCloseTo(256.35 * 1024 ** 2, 3);
  });

  it("returns null for garbage — the caller must render unknown, not zero", () => {
    for (const bad of [
      "",
      "   ",
      "unknown",
      "n/a",
      "-1 GB",
      "1.2 parsecs",
      "GB",
      "1.2.3 GB",
      "12", // a bare number: no unit means no measurement
      null,
      undefined,
      42,
      {},
      ["1 GB"],
    ]) {
      expect(parseHumanSizeBytes(bad)).toBeNull();
    }
  });

  it("parses a literal zero rather than hiding it — believability is the caller's call", () => {
    expect(parseHumanSizeBytes("0 B")).toBe(0);
  });
});

describe("normalizeModelReference() / modelRepositoryKey()", () => {
  it("drops the registry host and the implicit :latest tag", () => {
    expect(normalizeModelReference("docker.io/ai/smollm2:latest")).toBe(
      "ai/smollm2",
    );
    expect(normalizeModelReference("ai/smollm2")).toBe("ai/smollm2");
  });

  it("KEEPS a meaningful tag — it selects a quantization, i.e. a different file", () => {
    expect(normalizeModelReference("ai/smollm2:360M-Q4_K_M")).toBe(
      "ai/smollm2:360M-Q4_K_M",
    );
  });

  it("is idempotent", () => {
    const once = normalizeModelReference("docker.io/ai/smollm2:latest");
    expect(normalizeModelReference(once)).toBe(once);
  });

  it("never mistakes a registry port for a tag", () => {
    expect(normalizeModelReference("localhost:5000/ai/smollm2:latest")).toBe(
      "ai/smollm2",
    );
  });

  it("leaves an Ollama-style name alone", () => {
    expect(normalizeModelReference("gpt-oss:20b")).toBe("gpt-oss:20b");
    expect(modelRepositoryKey("gpt-oss:20b")).toBe("gpt-oss");
  });

  it("modelRepositoryKey drops every tag (membership, not addressing)", () => {
    expect(modelRepositoryKey("docker.io/ai/smollm2:360M-Q4_K_M")).toBe(
      "ai/smollm2",
    );
  });
});
