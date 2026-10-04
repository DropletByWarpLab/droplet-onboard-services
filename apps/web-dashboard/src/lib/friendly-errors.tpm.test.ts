/**
 * WARP-3515 — a Droplet with no TPM cannot encrypt a drive.
 *
 * ADR-070 / WARP-3512: Prepare (and a pool create or format, which must be LUKS
 * too) seals the drive's unlock key to the TPM2. A box without one refuses with
 * `409 tpm_required` and wipes nothing. The refusal can arrive on the request
 * that mints the confirm token OR on the confirm that executes it, and as a
 * `code`, as the error text, or as prose — so one recogniser serves every flow,
 * and every flow shows the same plain sentence.
 */
import { describe, it, expect } from "vitest";
import { TPM_REQUIRED_MESSAGE, isTpmRequired } from "./friendly-errors";

describe("isTpmRequired", () => {
  it("recognises the typed code", () => {
    expect(isTpmRequired(Object.assign(new Error("x"), { status: 409, code: "tpm_required" }))).toBe(true);
  });

  it("recognises the code as the whole error text (a server that sends only `error`)", () => {
    expect(isTpmRequired(new Error("tpm_required"))).toBe(true);
  });

  it("recognises prose that names the TPM", () => {
    expect(isTpmRequired(new Error("Encryption needs a TPM2 chip on this device"))).toBe(true);
  });

  it.each([
    new Error("drive has data"),
    new Error("Could not start drive adopt: 409"),
    Object.assign(new Error("busy"), { status: 409, code: "drive_busy" }),
    "tpm_required",
    null,
    undefined,
    {},
    42,
  ])("is false for %o", (err) => {
    expect(isTpmRequired(err)).toBe(false);
  });

  it("does not trip on an unrelated word that merely contains the letters", () => {
    expect(isTpmRequired(new Error("stpmail"))).toBe(false);
  });
});

describe("TPM_REQUIRED_MESSAGE", () => {
  it("says, plainly, that there is no security chip and so no encryption", () => {
    expect(TPM_REQUIRED_MESSAGE).toBe(
      "This Droplet has no security chip (TPM); drives can't be encrypted.",
    );
  });
});
