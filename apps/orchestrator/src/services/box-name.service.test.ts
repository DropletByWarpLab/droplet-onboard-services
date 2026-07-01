/**
 * WARP-979 — unit tests for the box-name (Secured address) SERVICE.
 *
 * The service is the box-side half of the onboarding "Secured / name your box"
 * step. QA flagged it as covered only transitively by setup-box-name.route.test
 * — this file pins the service contract directly, independent of Express:
 *
 *   - checkBoxName   — format/reserved validation + a best-effort (NON-
 *                      authoritative) availability answer, with the
 *                      `<slug>.droplet-us.com` fqdn.
 *   - persistBoxName — validate, then call the INJECTED persister with the
 *                      NORMALIZED slug (the value written to DROPLET_BOX_NAME);
 *                      throw BoxNameInvalidError (carrying code/reason/slug) for
 *                      a bad name WITHOUT touching the persister.
 *
 * Validation itself lives in @droplet/shared-types and is unit-tested there
 * (packages/shared-types/src/box-name.test.ts); here we assert the service's
 * wiring around it. A fake persister is injected exactly like the route test
 * does (buildApp's persistBoxNameToHost), so no device-bridge is touched.
 */
import { describe, it, expect, vi } from "vitest";
import {
  checkBoxName,
  persistBoxName,
  BoxNameInvalidError,
  BOX_NAME_ENV_KEY,
} from "./box-name.service.js";

describe("box-name.service — checkBoxName", () => {
  it("reports a well-formed name available with slug, fqdn, and authoritative:false", () => {
    const res = checkBoxName("studio");
    expect(res).toEqual({
      available: true,
      slug: "studio",
      fqdn: "studio.droplet-us.com",
      authoritative: false,
    });
    // No reason on the success path.
    expect(res.reason).toBeUndefined();
  });

  it("normalizes (trim + lowercase) before answering", () => {
    const res = checkBoxName("  MyBox  ");
    expect(res.available).toBe(true);
    expect(res.slug).toBe("mybox");
    expect(res.fqdn).toBe("mybox.droplet-us.com");
  });

  it("reports available:false with a reason for a too-short name", () => {
    const res = checkBoxName("ab");
    expect(res.available).toBe(false);
    expect(res.reason).toBe("too_short");
    // Even on rejection the fqdn is derived from the normalized slug.
    expect(res.fqdn).toBe("ab.droplet-us.com");
    expect(res.authoritative).toBe(false);
  });

  it("reports available:false with reason 'reserved' for a reserved name", () => {
    const res = checkBoxName("admin");
    expect(res.available).toBe(false);
    expect(res.reason).toBe("reserved");
  });

  it("reports available:false with reason 'lookalike' for a d-<16 hex> name", () => {
    const res = checkBoxName("d-0123456789abcdef");
    expect(res.available).toBe(false);
    expect(res.reason).toBe("lookalike");
  });

  it("never reports authoritative:true (HQ registry check is a coupled follow-up)", () => {
    expect(checkBoxName("studio").authoritative).toBe(false);
    expect(checkBoxName("admin").authoritative).toBe(false);
    expect(checkBoxName("").authoritative).toBe(false);
  });
});

describe("box-name.service — persistBoxName", () => {
  it("validates then calls the injected persister with the NORMALIZED slug", async () => {
    const persist = vi.fn(async (_name: string) => {});
    const result = await persistBoxName("  Studio  ", persist);

    expect(result).toEqual({ slug: "studio", fqdn: "studio.droplet-us.com" });
    // The persister receives the normalized slug — the value written to
    // DROPLET_BOX_NAME (the host .env key mirroring DROPLET_PUBLIC_FQDN).
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith("studio");
    expect(BOX_NAME_ENV_KEY).toBe("DROPLET_BOX_NAME");
  });

  it("throws BoxNameInvalidError (code/reason/slug) for a bad name WITHOUT persisting", async () => {
    const persist = vi.fn(async (_name: string) => {});
    const err = await persistBoxName("My Box!", persist).catch((e) => e);

    expect(err).toBeInstanceOf(BoxNameInvalidError);
    expect(err.code).toBe("BOX_NAME_INVALID");
    expect(err.reason).toBe("charset");
    // The (normalized) offending slug rides on the error so the route can
    // surface the field error without echoing a coerced value.
    expect(err.slug).toBe("my box!");
    // No write on the reject path.
    expect(persist).not.toHaveBeenCalled();
  });

  it("throws BoxNameInvalidError with reason 'reserved' for a reserved name (no persist)", async () => {
    const persist = vi.fn(async (_name: string) => {});
    const err = await persistBoxName("vpn", persist).catch((e) => e);

    expect(err).toBeInstanceOf(BoxNameInvalidError);
    expect(err.reason).toBe("reserved");
    expect(err.slug).toBe("vpn");
    expect(persist).not.toHaveBeenCalled();
  });

  it("throws BoxNameInvalidError with reason 'empty' for an empty name (no persist)", async () => {
    const persist = vi.fn(async (_name: string) => {});
    const err = await persistBoxName("   ", persist).catch((e) => e);

    expect(err).toBeInstanceOf(BoxNameInvalidError);
    expect(err.reason).toBe("empty");
    expect(persist).not.toHaveBeenCalled();
  });

  it("awaits the persister so a throwing persister surfaces to the caller", async () => {
    const boom = new Error("host .env write failed");
    const persist = vi.fn(async (_name: string) => {
      throw boom;
    });
    await expect(persistBoxName("studio", persist)).rejects.toBe(boom);
    expect(persist).toHaveBeenCalledWith("studio");
  });
});
