/**
 * Identity prompt loader — the data/droplet-identity.md block that
 * leads buildBaseSystemPrompt for every chat surface.
 *
 * Covers: the bundled file loads and carries the identity + capability
 * sections; missing/empty files fail open to the legacy one-liner;
 * oversized files truncate to IDENTITY_MAX_CHARS instead of blowing
 * the local model's context window.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FALLBACK_IDENTITY,
  IDENTITY_MAX_CHARS,
  defaultIdentityPath,
  loadIdentityPrompt,
  resetIdentityPromptCache,
} from "../services/identity-prompt.js";

let tmp: string;

beforeEach(() => {
  resetIdentityPromptCache();
  tmp = mkdtempSync(path.join(tmpdir(), "identity-prompt-"));
});

afterEach(() => {
  resetIdentityPromptCache();
  rmSync(tmp, { recursive: true, force: true });
});

describe("loadIdentityPrompt", () => {
  it("loads the bundled droplet-identity.md with identity + capabilities", () => {
    // vitest runs with cwd = apps/orchestrator, same as the deployed
    // container (WORKDIR /app/apps/orchestrator) — the default path
    // must resolve in both.
    const text = loadIdentityPrompt(defaultIdentityPath());
    expect(text).toContain("You are Droplet");
    expect(text).toContain("What the box does");
    expect(text.length).toBeLessThanOrEqual(IDENTITY_MAX_CHARS);
  });

  it("falls back to the legacy one-liner when the file is missing", () => {
    const text = loadIdentityPrompt(path.join(tmp, "nope.md"));
    expect(text).toBe(FALLBACK_IDENTITY);
  });

  it("falls back to the legacy one-liner when the file is empty", () => {
    const p = path.join(tmp, "empty.md");
    writeFileSync(p, "   \n  ");
    const text = loadIdentityPrompt(p);
    expect(text).toBe(FALLBACK_IDENTITY);
  });

  it("truncates an oversized file to IDENTITY_MAX_CHARS", () => {
    const p = path.join(tmp, "huge.md");
    writeFileSync(p, "x".repeat(IDENTITY_MAX_CHARS * 3));
    const text = loadIdentityPrompt(p);
    expect(text.length).toBe(IDENTITY_MAX_CHARS);
  });

  it("caches the first load until reset", () => {
    const p = path.join(tmp, "v1.md");
    writeFileSync(p, "version one");
    expect(loadIdentityPrompt(p)).toBe("version one");
    writeFileSync(p, "version two");
    // Still the cached first read…
    expect(loadIdentityPrompt(p)).toBe("version one");
    // …until the cache is dropped.
    resetIdentityPromptCache();
    expect(loadIdentityPrompt(p)).toBe("version two");
  });
});
