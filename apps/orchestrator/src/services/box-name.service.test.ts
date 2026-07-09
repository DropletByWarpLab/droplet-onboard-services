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
  setBoxName,
  renameBoxName,
  BoxNameInvalidError,
  BOX_NAME_ENV_KEY,
} from "./box-name.service.js";
import {
  CLAIM_RESULT_CLAIMED,
  CLAIM_RESULT_NAME_TAKEN,
  CLAIM_RESULT_ALREADY_NAMED,
  CLAIM_RESULT_NOT_REGISTERED,
  CLAIM_RESULT_FAILED,
  RELEASE_RESULT_OK,
  RELEASE_RESULT_SKIPPED,
  RELEASE_RESULT_FAILED,
  type ClaimBoxNameResult,
  type ReleaseResult,
} from "./tls-issuance.service.js";

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

// ---------------------------------------------------------------------------
// WARP-980 — setBoxName: persist THEN device-auth claim (rename → authoritative)
// ---------------------------------------------------------------------------

describe("box-name.service — setBoxName (WARP-980)", () => {
  function claiming(over: Partial<ClaimBoxNameResult>): (
    raw: string,
  ) => Promise<ClaimBoxNameResult> {
    return vi.fn(async () => ({
      outcome: CLAIM_RESULT_CLAIMED,
      authoritative: true,
      slug: "studio",
      fqdn: "studio.droplet-us.com",
      ...over,
    }));
  }

  it("persists first, then claims with the RAW name, and returns authoritative:true on success", async () => {
    const persist = vi.fn(async (_name: string) => {});
    const claim = claiming({});
    const result = await setBoxName("  Studio  ", { persist, claim });

    // The (validated) slug is persisted to DROPLET_BOX_NAME.
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith("studio");
    // The claim is driven with the RAW owner-entered name (HQ slugs it).
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith("  Studio  ");

    expect(result.slug).toBe("studio");
    expect(result.fqdn).toBe("studio.droplet-us.com");
    expect(result.authoritative).toBe(true);
    expect(result.claim.outcome).toBe(CLAIM_RESULT_CLAIMED);
    expect(result.taken).toBe(false);
  });

  it("surfaces a 409 name-taken (with suggestions) as taken:true — the wizard shows the truth", async () => {
    const persist = vi.fn(async (_name: string) => {});
    const claim = claiming({
      outcome: CLAIM_RESULT_NAME_TAKEN,
      authoritative: true,
      suggestions: ["studio-2", "studio-hq"],
      slug: undefined,
      fqdn: undefined,
    });
    const result = await setBoxName("studio", { persist, claim });

    // Persistence still happened (best-effort local write) — but the name is NOT
    // authoritative and the wizard is told it is taken, with suggestions.
    expect(persist).toHaveBeenCalledTimes(1);
    expect(result.taken).toBe(true);
    expect(result.authoritative).toBe(true);
    expect(result.suggestions).toEqual(["studio-2", "studio-hq"]);
  });

  it("threads an already-named claim through as alreadyNamed:true with currentName (WARP-1109)", async () => {
    const persist = vi.fn(async (_name: string) => {});
    const claim = claiming({
      outcome: CLAIM_RESULT_ALREADY_NAMED,
      authoritative: true,
      currentName: "scruceru",
      slug: undefined,
      fqdn: undefined,
    });
    const result = await setBoxName("studio", { persist, claim });

    // Persistence still happened (best-effort local write), but HQ says this
    // box already holds a DIFFERENT name — distinct from taken, so the wizard
    // can offer the rename flow instead of the false "taken".
    expect(persist).toHaveBeenCalledTimes(1);
    expect(result.taken).toBe(false);
    expect(result.alreadyNamed).toBe(true);
    expect(result.currentName).toBe("scruceru");
    expect(result.authoritative).toBe(true);
  });

  it("reports alreadyNamed:false on every other claim outcome", async () => {
    const persist = vi.fn(async (_name: string) => {});
    const result = await setBoxName("studio", { persist, claim: claiming({}) });
    expect(result.alreadyNamed).toBe(false);
    expect(result.currentName).toBeUndefined();
  });

  it("falls back gracefully (authoritative:false) when the device is not registered yet", async () => {
    const persist = vi.fn(async (_name: string) => {});
    const claim = claiming({
      outcome: CLAIM_RESULT_NOT_REGISTERED,
      authoritative: false,
      slug: undefined,
      fqdn: undefined,
    });
    const result = await setBoxName("studio", { persist, claim });

    // The local persist succeeds; issuance falls back to opaque/bootstrap. We
    // still return the derived slug/fqdn so the wizard can show the chosen name.
    expect(persist).toHaveBeenCalledTimes(1);
    expect(result.slug).toBe("studio");
    expect(result.fqdn).toBe("studio.droplet-us.com");
    expect(result.authoritative).toBe(false);
    expect(result.taken).toBe(false);
  });

  it("a transient claim failure is non-fatal to persistence (authoritative:false, not taken)", async () => {
    const persist = vi.fn(async (_name: string) => {});
    const claim = claiming({
      outcome: CLAIM_RESULT_FAILED,
      authoritative: false,
      slug: undefined,
      fqdn: undefined,
    });
    const result = await setBoxName("studio", { persist, claim });

    expect(persist).toHaveBeenCalledTimes(1);
    expect(result.authoritative).toBe(false);
    expect(result.taken).toBe(false);
    expect(result.claim.outcome).toBe(CLAIM_RESULT_FAILED);
  });

  it("rejects an invalid name with BoxNameInvalidError BEFORE persisting or claiming", async () => {
    const persist = vi.fn(async (_name: string) => {});
    const claim = claiming({});
    const err = await setBoxName("My Box!", { persist, claim }).catch((e) => e);

    expect(err).toBeInstanceOf(BoxNameInvalidError);
    expect(persist).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// WARP-1109 — renameBoxName: RELEASE the old name at HQ, THEN claim the new one
// and trigger a re-issue under the new FQDN. Non-fatal on a post-release claim
// failure (the box falls back to opaque/bootstrap + re-claims on the next tick).
// ---------------------------------------------------------------------------

describe("box-name.service — renameBoxName (WARP-1109)", () => {
  function claiming(over: Partial<ClaimBoxNameResult>): (
    raw: string,
  ) => Promise<ClaimBoxNameResult> {
    return vi.fn(async () => ({
      outcome: CLAIM_RESULT_CLAIMED,
      authoritative: true,
      slug: "renamed",
      fqdn: "renamed.droplet-us.com",
      ...over,
    }));
  }

  function makeDeps(over: {
    persist?: (name: string) => Promise<void>;
    release?: () => Promise<ReleaseResult>;
    claim?: (raw: string) => Promise<ClaimBoxNameResult>;
    reissue?: () => Promise<void>;
  } = {}): {
    persist: (name: string) => Promise<void>;
    release: () => Promise<ReleaseResult>;
    claim: (raw: string) => Promise<ClaimBoxNameResult>;
    reissue: () => Promise<void>;
  } {
    return {
      persist: over.persist ?? vi.fn(async (_name: string) => {}),
      release: over.release ?? vi.fn(async () => RELEASE_RESULT_OK),
      claim: over.claim ?? claiming({}),
      reissue: over.reissue ?? vi.fn(async () => {}),
    };
  }

  it("releases the current name FIRST, then persists + claims the new one, then re-issues", async () => {
    const order: string[] = [];
    const release = vi.fn(async () => {
      order.push("release");
      return RELEASE_RESULT_OK;
    });
    const persist = vi.fn(async (_n: string) => {
      order.push("persist");
    });
    const claim = vi.fn(async () => {
      order.push("claim");
      return {
        outcome: CLAIM_RESULT_CLAIMED,
        authoritative: true,
        slug: "renamed",
        fqdn: "renamed.droplet-us.com",
      } as ClaimBoxNameResult;
    });
    const reissue = vi.fn(async () => {
      order.push("reissue");
    });

    const result = await renameBoxName("Renamed", {
      persist,
      release,
      claim,
      reissue,
    });

    // RELEASE must precede the CLAIM (HQ frees the old name before we take a new
    // one) and the re-issue runs last, under the new FQDN.
    expect(order).toEqual(["release", "persist", "claim", "reissue"]);
    // The claim is driven with the RAW owner-entered name (HQ slugs it).
    expect(claim).toHaveBeenCalledWith("Renamed");
    // The new slug is persisted to DROPLET_BOX_NAME.
    expect(persist).toHaveBeenCalledWith("renamed");
    expect(result.ok).toBe(true);
    expect(result.slug).toBe("renamed");
    expect(result.fqdn).toBe("renamed.droplet-us.com");
    expect(result.authoritative).toBe(true);
    expect(result.taken).toBe(false);
    expect(result.reissued).toBe(true);
  });

  it("surfaces a 409 name-taken on the NEW name as taken:true (with suggestions)", async () => {
    const claim = claiming({
      outcome: CLAIM_RESULT_NAME_TAKEN,
      authoritative: true,
      suggestions: ["renamed-2"],
      slug: undefined,
      fqdn: undefined,
    });
    const reissue = vi.fn(async () => {});
    const result = await renameBoxName("renamed", makeDeps({ claim, reissue }));

    expect(result.taken).toBe(true);
    expect(result.suggestions).toEqual(["renamed-2"]);
    expect(result.authoritative).toBe(true);
    // A taken new name means no successful re-issue under it.
    expect(result.reissued).toBe(false);
    expect(reissue).not.toHaveBeenCalled();
  });

  it("release-succeeded / claim-FAILED is NON-FATAL: reports fallback, still re-issues (opaque/bootstrap re-claims next tick)", async () => {
    // The classic rollback path: HQ freed the old name, but the new claim failed
    // transiently. The box must NOT be stranded — it re-issues (falls back to
    // opaque/bootstrap) and the persisted new name is re-claimed on the next tick.
    const release = vi.fn(async () => RELEASE_RESULT_OK);
    const claim = claiming({
      outcome: CLAIM_RESULT_FAILED,
      authoritative: false,
      slug: undefined,
      fqdn: undefined,
    });
    const reissue = vi.fn(async () => {});
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await renameBoxName("renamed", {
      ...makeDeps({ release, claim, reissue }),
      logger,
    });

    expect(release).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.authoritative).toBe(false);
    expect(result.taken).toBe(false);
    // Fallback is loud: a warning is logged.
    expect(logger.warn).toHaveBeenCalled();
    // The box still re-issues so it keeps serving a cert (opaque/bootstrap).
    expect(reissue).toHaveBeenCalledTimes(1);
    expect(result.reissued).toBe(true);
  });

  it("proceeds with the claim even when the release FAILED (HQ reaps the stale name server-side)", async () => {
    const release = vi.fn(async () => RELEASE_RESULT_FAILED);
    const claim = claiming({});
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await renameBoxName("renamed", {
      ...makeDeps({ release, claim }),
      logger,
    });

    // A failed release does not abort the rename — HQ reaps stale names; the
    // claim still runs and can succeed.
    expect(claim).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("treats a SKIPPED release (device not provisioned) as fine and continues", async () => {
    const release = vi.fn(async () => RELEASE_RESULT_SKIPPED);
    const claim = claiming({});
    const result = await renameBoxName("renamed", makeDeps({ release, claim }));
    expect(claim).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("a re-issue failure is non-fatal — the rename result still reflects the successful claim", async () => {
    const reissue = vi.fn(async () => {
      throw new Error("reissue tick threw");
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await renameBoxName("renamed", {
      ...makeDeps({ reissue }),
      logger,
    });
    expect(result.ok).toBe(true);
    expect(result.authoritative).toBe(true);
    // The claim succeeded; the re-issue is best-effort (the 04:00 cron retries).
    expect(result.reissued).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("rejects an invalid NEW name with BoxNameInvalidError BEFORE releasing anything", async () => {
    const release = vi.fn(async () => RELEASE_RESULT_OK);
    const persist = vi.fn(async (_n: string) => {});
    const claim = claiming({});
    const err = await renameBoxName("My Box!", {
      ...makeDeps({ release, persist, claim }),
    }).catch((e) => e);

    expect(err).toBeInstanceOf(BoxNameInvalidError);
    // Never release the CURRENT name for a new name we can't even accept.
    expect(release).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });
});
