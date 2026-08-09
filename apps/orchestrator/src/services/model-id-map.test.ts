/**
 * WARP-1749 — the model-id vocabulary map.
 *
 * The rows in `model-id-map.ts` are claims about a registry that lives outside
 * this repo, so the tests that matter are the ones that lock the SHAPE of those
 * claims (no ambiguity, no invented target, idempotent normalisation) plus the
 * two behaviours the migration's safety rests on: an unknown id is never
 * rewritten, and a second forward pass is a no-op.
 */
import { describe, expect, it } from "vitest";
import {
  BLOCKED_MODEL_ROWS,
  MAPPED_MODEL_ROWS,
  TARGET_OCI_REPOSITORIES,
  aliasIndexSize,
  canonicalOciId,
  classifyModelId,
  ociRepository,
} from "./model-id-map.js";

describe("table integrity", () => {
  it("builds without an ambiguous alias (the index throws on conflict)", () => {
    // The module-level build already ran at import; reaching here means it did
    // not throw. Assert it actually indexed something so this can't pass vacuously.
    expect(aliasIndexSize()).toBeGreaterThan(0);
  });

  it("every target is an ai/ namespace OCI id, never a bare Ollama tag", () => {
    for (const row of MAPPED_MODEL_ROWS) {
      expect(row.oci).toMatch(/^ai\/[a-z0-9][a-z0-9.\-]*$/);
      // An Ollama size selector must never survive into the target: `ai/gemma4:26b`
      // would address a tag nobody verified exists.
      expect(row.oci).not.toContain(":");
    }
  });

  it("every row carries evidence (a file:line or a verified source)", () => {
    for (const row of [...MAPPED_MODEL_ROWS, ...BLOCKED_MODEL_ROWS]) {
      expect(row.evidence.length).toBeGreaterThan(10);
    }
  });

  it("the three vision models are BLOCKED, not mapped — their ai/ repos do not exist", () => {
    // The whole reason the map is a table rather than `ai/${repo}`: a derived
    // migration would have produced ai/llava and ai/llama3.2-vision, neither of
    // which is in the registry (verified 2026-08-05, `docker model search`).
    for (const id of ["llava:7b", "llama3.2-vision:11b", "moondream"]) {
      expect(classifyModelId(id).kind).toBe("blocked");
    }
    const blockedIds = BLOCKED_MODEL_ROWS.flatMap((r) => r.ollamaIds);
    for (const id of blockedIds) {
      expect(TARGET_OCI_REPOSITORIES.has(`ai/${id.split(":")[0]}`)).toBe(false);
    }
  });
});

describe("canonicalOciId", () => {
  it("drops the registry host DMR actually reports", () => {
    expect(canonicalOciId("docker.io/ai/smollm2:latest")).toBe("ai/smollm2");
  });

  it("drops a two-segment registry host too (the adapter's three-segment-only bug)", () => {
    // dmr.py:_normalize_oci_reference only strips a host when the reference has
    // exactly three segments, so this one keeps its prefix there. Here it must not.
    expect(canonicalOciId("docker.io/gpt-oss:latest")).toBe("gpt-oss");
  });

  it("keeps a meaningful tag — it selects a quantization", () => {
    expect(canonicalOciId("ai/smollm2:360M-Q4_K_M")).toBe("ai/smollm2:360m-q4_k_m");
  });

  it("never mistakes a registry port for a tag", () => {
    expect(canonicalOciId("localhost:5000/ai/gpt-oss")).toBe("ai/gpt-oss");
  });

  it("is idempotent", () => {
    for (const v of ["docker.io/ai/gpt-oss:latest", "ai/gemma4", "ai/smollm2:360M-Q4_K_M", ""]) {
      expect(canonicalOciId(canonicalOciId(v))).toBe(canonicalOciId(v));
    }
  });
});

describe("ociRepository (set-membership form, mirrors DmrRuntime.comparable_id)", () => {
  it("drops even a meaningful tag — it answers 'which repo', not 'which weights'", () => {
    expect(ociRepository("ai/smollm2:360M-Q4_K_M")).toBe("ai/smollm2");
    expect(ociRepository("docker.io/ai/gpt-oss:latest")).toBe("ai/gpt-oss");
  });

  it("is idempotent", () => {
    const v = "docker.io/ai/gpt-oss:latest";
    expect(ociRepository(ociRepository(v))).toBe(ociRepository(v));
  });
});

describe("classifyModelId", () => {
  it("maps the single-box default", () => {
    const c = classifyModelId("gpt-oss:20b");
    expect(c).toMatchObject({ kind: "rewrite", oci: "ai/gpt-oss" });
  });

  it("maps the voice model", () => {
    expect(classifyModelId("qwen2.5:3b-instruct")).toMatchObject({
      kind: "rewrite",
      oci: "ai/qwen2.5",
    });
  });

  it("collapses both gemma4 tiers onto one repository (the map is LOSSY on purpose)", () => {
    expect(classifyModelId("gemma4:26b")).toMatchObject({ oci: "ai/gemma4" });
    expect(classifyModelId("gemma4:31b")).toMatchObject({ oci: "ai/gemma4" });
  });

  it("maps the PRETTIFIED display name the Models page actually persists", () => {
    // ActiveModelPicker.tsx:92 PATCHes LocalModelRow.name, which is
    // ModelInfo.name — prettify_ollama_name output, not the tag. This is what
    // `ai.model.chat` really holds on a box where somebody used the picker.
    expect(classifyModelId("Gpt-oss 20B")).toMatchObject({ kind: "rewrite", oci: "ai/gpt-oss" });
    expect(classifyModelId("Qwen 2.5 3B Instruct")).toMatchObject({ oci: "ai/qwen2.5" });
  });

  it("accepts Ollama's registry-qualified spelling", () => {
    expect(classifyModelId("library/gpt-oss:20b")).toMatchObject({ oci: "ai/gpt-oss" });
  });

  it("treats an already-OCI value as already migrated (second run is a no-op)", () => {
    expect(classifyModelId("ai/gpt-oss").kind).toBe("already");
    expect(classifyModelId("docker.io/ai/gpt-oss:latest").kind).toBe("already");
  });

  it("treats the seeded blank as skip, not as unknown", () => {
    // workspace-settings.service.ts:137 seeds ai.model.chat to "".
    expect(classifyModelId("").kind).toBe("skip");
    expect(classifyModelId("   ").kind).toBe("skip");
    expect(classifyModelId(null).kind).toBe("skip");
  });

  it("leaves a customer-pulled model we've never heard of as unknown", () => {
    expect(classifyModelId("deepseek-coder-v2:16b").kind).toBe("unknown");
    expect(classifyModelId("some-persons-finetune:q8").kind).toBe("unknown");
  });

  it("does not collide llama3.2 with llama3.2-vision", () => {
    expect(classifyModelId("llama3.2:3b")).toMatchObject({ kind: "rewrite", oci: "ai/llama3.2" });
    expect(classifyModelId("llama3.2-vision:11b").kind).toBe("blocked");
  });

  it("is case-insensitive on stored values", () => {
    expect(classifyModelId("GPT-OSS:20B")).toMatchObject({ oci: "ai/gpt-oss" });
  });
});
