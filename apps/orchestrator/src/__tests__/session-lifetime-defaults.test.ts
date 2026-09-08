/**
 * WARP-2856 — the session lifetime a box actually ships with.
 *
 * Romain, 2026-09-07: a signed-in person stays signed in for **12 hours of
 * inactivity** and **30 days absolute** before having to sign in again. The
 * stricter 15-minute admin idle window from WARP-247 is dropped on that
 * instruction; the admin constant survives so it can be tightened again on
 * its own.
 *
 * These numbers live in three places that do not import each other — the zod
 * schema in `config.ts`, the `DEFAULT_*` fallbacks `session.service.ts` uses
 * when config is partial, and `REFRESH_TOKEN_TTL_SECONDS` in `jwt.service.ts`
 * — so this file is the one place all three are compared. It runs on an
 * env-unset boot, which is what makes it a test of the DEFAULTS rather than
 * of whatever `.env` happens to say. Changing the policy means editing this
 * file too: that is the point.
 *
 * `session.service.test.ts` deliberately mocks config with SMALLER, unequal
 * windows (admin 900 / user 3600). Those are fixtures, not policy — they keep
 * the fake-clock tests cheap and are the only way to prove owner/admin reads
 * the admin variable while family/guest reads the user one.
 */
import { describe, it, expect } from "vitest";
import { config } from "../config.js";
import {
  DEFAULT_IDLE_TIMEOUT_ADMIN_SECONDS,
  DEFAULT_IDLE_TIMEOUT_USER_SECONDS,
  DEFAULT_ABSOLUTE_TIMEOUT_SECONDS,
} from "../services/session.service.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from "../services/jwt.service.js";

const TWELVE_HOURS = 12 * 60 * 60; // 43_200
const THIRTY_DAYS = 30 * 24 * 60 * 60; // 2_592_000

describe("shipped session lifetime defaults (WARP-2856)", () => {
  it("is 12 h idle for BOTH role classes and 30 d absolute", () => {
    expect(DEFAULT_IDLE_TIMEOUT_USER_SECONDS).toBe(TWELVE_HOURS);
    expect(DEFAULT_IDLE_TIMEOUT_ADMIN_SECONDS).toBe(TWELVE_HOURS);
    expect(DEFAULT_ABSOLUTE_TIMEOUT_SECONDS).toBe(THIRTY_DAYS);
  });

  it("has config.ts's zod defaults carrying the same three numbers", () => {
    expect(config.SESSION_IDLE_TIMEOUT_ADMIN_SECONDS).toBe(TWELVE_HOURS);
    expect(config.SESSION_IDLE_TIMEOUT_USER_SECONDS).toBe(TWELVE_HOURS);
    expect(config.SESSION_ABSOLUTE_TIMEOUT_SECONDS).toBe(THIRTY_DAYS);
  });

  it("keeps a refresh possible for the WHOLE absolute window", () => {
    // A refresh TTL under the absolute cap strands a live session: the record
    // is still inside its window but no new access token can be minted for
    // it, so the person is signed out early with nothing to show for it.
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(DEFAULT_ABSOLUTE_TIMEOUT_SECONDS);
    // The access token stays short — the long windows above are the session's,
    // not the bearer credential's.
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(15 * 60);
  });
});
