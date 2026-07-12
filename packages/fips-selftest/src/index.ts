// @droplet/fips-selftest — FIPS 140-3 boot self-test for Node services.
//
// Each service calls `assertFipsAtBoot(serviceName)` at startup. The helper:
//   1. Confirms `crypto.getFips()` is true. NOTE: this mirrors OpenSSL's
//      `EVP_default_properties_is_fips_enabled` — it proves the fips=yes
//      property PIN, not that the validated provider actually activated.
//   2. Positive-confirms the provider is ACTIVE by requiring an approved
//      digest (SHA-256) to work (WARP-1063). If the fips provider failed
//      to activate, the fips=yes pin leaves NOTHING fetchable — MD5 is
//      "refused" but so is everything else, and every TLS client in the
//      process dies constructing its SSL context (LIBRARY_HAS_NO_CIPHERS,
//      Prisma P1011). This probe turns that state into an immediate,
//      correctly diagnosed boot failure. See docs/fips.md.
//   3. Negative-confirms by attempting an MD5 digest and asserting it
//      raises a FIPS-disabled error.
//   4. Emits a structured JSON log line on stdout so audit log integration
//      (WARP-237) can ingest it retroactively:
//        {"event":"fips_self_test","service":"<name>","fips":true,
//         "provider":"OpenSSL 3 FIPS"}
//   5. On failure throws a `FipsSelfTestError` — callers that want
//      fail-closed behavior should let it propagate so the process exits
//      non-zero. `assertFipsAtBootOrExit()` is the shorthand for that.
//
// Wraps the runtime FIPS-state check (`crypto.getFips()`) behind one
// helper so a future Node runtime change is a single-file fix.

import crypto from "node:crypto";

export const FIPS_PROVIDER_NAME = "OpenSSL 3 FIPS";

export interface FipsSelfTestResult {
  event: "fips_self_test";
  service: string;
  fips: true;
  provider: string;
}

export class FipsSelfTestError extends Error {
  constructor(public readonly reason: string, public readonly service: string) {
    super(`FIPS self-test failed for ${service}: ${reason}`);
    this.name = "FipsSelfTestError";
  }
}

/**
 * Internal — checks `crypto.getFips()`. Behind a function so tests can
 * mock and so a future Node change is one place.
 */
export function isFipsEnabled(): boolean {
  // `getFips()` returns 1 / 0; coerce.
  try {
    return crypto.getFips() === 1;
  } catch {
    return false;
  }
}

/**
 * Internal — confirm an MD5 call raises a FIPS-disabled error.
 * Returns the error message on success, or null if MD5 unexpectedly worked
 * (which means FIPS is NOT enforced and we should fail closed).
 */
export function md5ShouldFail(): string | null {
  try {
    // fips:allowed: fips-selftest-negative-probe
    crypto.createHash("md5").update("fips-selftest-probe").digest("hex");
    // If we got here, MD5 succeeded — FIPS is not actually enforced.
    return null;
  } catch (err) {
    return (err as Error).message ?? "md5 rejected";
  }
}

/**
 * Internal — confirm a FIPS-APPROVED digest (SHA-256) works. Returns null
 * when it does (the expected state), or the error message when it does not.
 *
 * WARP-1063: the negative MD5 probe alone cannot distinguish "provider
 * active and enforcing" from "provider failed to activate" — under the
 * shared FIPS config's `default_properties = fips=yes` pin, an activation
 * failure also refuses MD5 (nothing is fetchable at all) while getFips()
 * still reads 1 from the property pin. Requiring an approved digest to
 * work makes a dead provider fail the boot self-test with the real reason
 * instead of the process later crashing on LIBRARY_HAS_NO_CIPHERS.
 */
export function sha256ShouldWork(): string | null {
  try {
    crypto.createHash("sha256").update("fips-selftest-probe").digest("hex");
    return null;
  } catch (err) {
    return (err as Error).message ?? "sha256 unavailable";
  }
}

export interface AssertOptions {
  /** Override the log sink. Defaults to writing one JSON line to stdout. */
  log?: (line: string) => void;
}

/**
 * Assert FIPS is loaded and enforcing at boot. Emits a structured log
 * line on success. Throws `FipsSelfTestError` on any failure mode:
 *   - `getFips()` returns false (the fips=yes property pin is absent)
 *   - SHA-256 fails (property pin present but the validated provider did
 *     NOT activate — nothing is fetchable; WARP-1063)
 *   - MD5 succeeds (FIPS not actually enforcing)
 *
 * Callers should let the throw propagate so the container exits non-zero.
 */
export function assertFipsAtBoot(
  service: string,
  options: AssertOptions = {},
): FipsSelfTestResult {
  if (!service || typeof service !== "string") {
    throw new FipsSelfTestError("service name required", String(service));
  }

  if (!isFipsEnabled()) {
    throw new FipsSelfTestError(
      "crypto.getFips() returned false — OpenSSL FIPS provider not loaded",
      service,
    );
  }

  const sha256Err = sha256ShouldWork();
  if (sha256Err !== null) {
    throw new FipsSelfTestError(
      "approved digest SHA-256 unavailable — the fips=yes property pin is " +
        "set but the validated provider did not activate (check fips.so / " +
        "OPENSSL_MODULES / fipsmodule.cnf integrity; TLS clients would fail " +
        `with LIBRARY_HAS_NO_CIPHERS): ${sha256Err}`,
      service,
    );
  }

  const md5Err = md5ShouldFail();
  if (md5Err === null) {
    throw new FipsSelfTestError(
      "MD5 digest succeeded — FIPS provider is loaded but not enforcing",
      service,
    );
  }

  const result: FipsSelfTestResult = {
    event: "fips_self_test",
    service,
    fips: true,
    provider: FIPS_PROVIDER_NAME,
  };

  const sink = options.log ?? ((line: string) => process.stdout.write(line + "\n"));
  sink(JSON.stringify(result));
  return result;
}

/**
 * Same as `assertFipsAtBoot` but logs the failure and exits non-zero
 * instead of throwing. Convenience for top-of-file boot guards.
 */
export function assertFipsAtBootOrExit(
  service: string,
  options: AssertOptions = {},
): FipsSelfTestResult {
  try {
    return assertFipsAtBoot(service, options);
  } catch (err) {
    const e = err as FipsSelfTestError;
    const payload = {
      event: "fips_self_test",
      service,
      fips: false,
      reason: e.reason ?? e.message,
    };
    const sink =
      options.log ?? ((line: string) => process.stderr.write(line + "\n"));
    sink(JSON.stringify(payload));
    process.exit(1);
  }
}
