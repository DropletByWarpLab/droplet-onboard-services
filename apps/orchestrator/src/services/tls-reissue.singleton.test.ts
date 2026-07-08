/**
 * WARP-1093 — the process-wide TLS re-issue hook. The rename endpoint triggers a
 * cert re-issue under the box's new FQDN via `reissueTlsNow()`; boot registers
 * the composed issuance service's `runOnce` via `initTlsReissueHook`. These tests
 * pin: no-op before registration, delegation after, idempotent registration, and
 * rejection propagation (the rename flow catches it — the re-issue is best-effort).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  initTlsReissueHook,
  reissueTlsNow,
  _setTlsReissueHookForTests,
} from "./tls-reissue.singleton.js";

afterEach(() => {
  _setTlsReissueHookForTests(null);
});

describe("tls-reissue.singleton", () => {
  it("reissueTlsNow is a no-op (resolves) before a hook is registered", async () => {
    await expect(reissueTlsNow()).resolves.toBeUndefined();
  });

  it("delegates to the registered tick", async () => {
    const tick = vi.fn(async () => {});
    initTlsReissueHook(tick);
    await reissueTlsNow();
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("registration is idempotent — a second init does NOT replace the first hook", async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    initTlsReissueHook(first);
    initTlsReissueHook(second);
    await reissueTlsNow();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("propagates a rejection from the tick (the caller decides it's non-fatal)", async () => {
    _setTlsReissueHookForTests(async () => {
      throw new Error("issuance tick threw");
    });
    await expect(reissueTlsNow()).rejects.toThrow("issuance tick threw");
  });
});
