/**
 * WARP-883 (ADR-027 WS-5) — DROPLET_SHARED_FOLDER_NAME config default.
 *
 * The shared "Household" space is defined entirely by this one var: the
 * provisioning hook creates the group folder under it, and the files route
 * maps `?space=shared` onto `/${DROPLET_SHARED_FOLDER_NAME}`. Pin the default
 * ("Household") and that a non-empty override is honoured. Loading config.ts
 * is environment-sensitive, so each case imports it in an isolated module
 * registry with a controlled process.env (same approach the rest of the suite
 * uses for env-driven config behaviour).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("WARP-883 — DROPLET_SHARED_FOLDER_NAME config", () => {
  const original = process.env.DROPLET_SHARED_FOLDER_NAME;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.DROPLET_SHARED_FOLDER_NAME;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.DROPLET_SHARED_FOLDER_NAME;
    else process.env.DROPLET_SHARED_FOLDER_NAME = original;
  });

  it("defaults to \"Household\" when unset", async () => {
    const { config } = await import("./config.js");
    expect(config.DROPLET_SHARED_FOLDER_NAME).toBe("Household");
  });

  it("honours an explicit override", async () => {
    process.env.DROPLET_SHARED_FOLDER_NAME = "Family";
    vi.resetModules();
    const { config } = await import("./config.js");
    expect(config.DROPLET_SHARED_FOLDER_NAME).toBe("Family");
  });
});
