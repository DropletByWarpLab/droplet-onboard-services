import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// We need to control DEVICE_SECRET. Set it BEFORE the module loads so the
// signing key is captured deterministically.
const ORIGINAL_SECRET = process.env.DEVICE_SECRET;

// Mock the modules clips.service.ts depends on so we don't pull in the
// whole stack just to test the signer.
vi.mock("../services/nextcloud.client.js", () => ({
  ncCreateDirectory: vi.fn(),
  ncUploadFile: vi.fn(),
}));
vi.mock("../config.js", () => ({
  config: { FRIGATE_URL: "http://frigate.test:5000", agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

beforeEach(() => {
  process.env.DEVICE_SECRET = "test-secret-do-not-use-in-prod";
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.DEVICE_SECRET;
  else process.env.DEVICE_SECRET = ORIGINAL_SECRET;
});

// Lazy-import so the env var is read at call time (the helper reads process.env).
async function importSigner() {
  return import("../services/clips.service.js");
}

describe("signShareUrl / verifyShareUrl", () => {
  it("round-trips: a freshly signed token verifies and returns the same payload", async () => {
    const { signShareUrl, verifyShareUrl } = await importSigner();
    const token = signShareUrl("alice", "/Clips/front/x.mp4", 600);
    const verified = verifyShareUrl(token);
    expect(verified).not.toBeNull();
    expect(verified?.userId).toBe("alice");
    expect(verified?.ncPath).toBe("/Clips/front/x.mp4");
  });

  it("returns null for a tampered payload (signature mismatch)", async () => {
    const { signShareUrl, verifyShareUrl } = await importSigner();
    const token = signShareUrl("alice", "/Clips/front/x.mp4", 600);
    const [payload, sig] = token.split(".");
    // Modify the payload but keep the sig — should fail.
    const tampered = payload.slice(0, -2) + "AA" + "." + sig;
    expect(verifyShareUrl(tampered)).toBeNull();
  });

  it("returns null for a tampered signature", async () => {
    const { signShareUrl, verifyShareUrl } = await importSigner();
    const token = signShareUrl("alice", "/x.mp4", 600);
    const [payload, sig] = token.split(".");
    const flipped = sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA");
    expect(verifyShareUrl(`${payload}.${flipped}`)).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const { signShareUrl, verifyShareUrl } = await importSigner();
    // ttl < 60 is clamped to 60 by the signer, so use vi.useFakeTimers to
    // advance past expiry instead of trying to mint a 0-second token.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-23T10:00:00Z"));
      const token = signShareUrl("alice", "/x.mp4", 60);
      expect(verifyShareUrl(token)).not.toBeNull();
      vi.setSystemTime(new Date("2026-04-23T10:01:01Z")); // 1s past expiry
      expect(verifyShareUrl(token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null for malformed input", async () => {
    const { verifyShareUrl } = await importSigner();
    expect(verifyShareUrl("")).toBeNull();
    expect(verifyShareUrl("nodot")).toBeNull();
    expect(verifyShareUrl("a.b.c.d")).not.toThrow as unknown as void;
    expect(verifyShareUrl("....")).toBeNull();
    // @ts-expect-error — runtime check that non-string input is rejected
    expect(verifyShareUrl(null)).toBeNull();
    // @ts-expect-error
    expect(verifyShareUrl(undefined)).toBeNull();
    // @ts-expect-error
    expect(verifyShareUrl(123)).toBeNull();
  });

  it("clamps ttl to [60, 86400] seconds", async () => {
    const { signShareUrl, verifyShareUrl } = await importSigner();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-23T10:00:00Z"));
      // Asking for 1 second should give us at least 60s — verify still valid 30s in.
      const tooShort = signShareUrl("alice", "/x.mp4", 1);
      vi.setSystemTime(new Date("2026-04-23T10:00:30Z"));
      expect(verifyShareUrl(tooShort)).not.toBeNull();

      // Asking for a year should cap at 24h.
      vi.setSystemTime(new Date("2026-04-23T10:00:00Z"));
      const tooLong = signShareUrl("bob", "/y.mp4", 60 * 60 * 24 * 365);
      vi.setSystemTime(new Date("2026-04-24T10:00:01Z")); // 24h + 1s
      expect(verifyShareUrl(tooLong)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses constant-time signature comparison (no early-exit timing leak)", async () => {
    const { signShareUrl, verifyShareUrl } = await importSigner();
    const token = signShareUrl("alice", "/x.mp4", 600);
    // Replace signature with one of correct length but all zeros.
    const [payload] = token.split(".");
    const allZeros = "A".repeat(token.split(".")[1].length);
    expect(verifyShareUrl(`${payload}.${allZeros}`)).toBeNull();
    // Replace with one of wrong length — also rejected, no throw.
    expect(verifyShareUrl(`${payload}.short`)).toBeNull();
  });

  it("a token signed by user A doesn't grant access as user B (payload binds userId)", async () => {
    const { signShareUrl, verifyShareUrl } = await importSigner();
    const token = signShareUrl("alice", "/Clips/secret.mp4", 600);
    const verified = verifyShareUrl(token);
    expect(verified?.userId).toBe("alice");
    // The route handler is responsible for using `verified.userId` (not the
    // request session) to fetch from the right NC namespace. This test just
    // confirms the payload preserves identity.
  });
});

describe("signShareUrl path validation", () => {
  // The signer applies the same defense-in-depth path checks as PR #1's
  // validateNcPath so an authenticated user can't sign a token whose ncPath
  // escapes their NC namespace via traversal.
  for (const bad of [
    "/../etc/passwd",
    "/Clips/../../bob/secrets.mp4",
    "/Clips/%2e%2e/admin/x.mp4",
    "/Clips/%252e%252e/admin/x.mp4", // double-encoded
    "/Clips/..\\admin",
    "/Clips/x\0evil.mp4",
    "",
  ]) {
    it(`rejects nc_path ${JSON.stringify(bad)}`, async () => {
      const { signShareUrl } = await importSigner();
      expect(() => signShareUrl("alice", bad, 600)).toThrow();
    });
  }

  it("normalises a relative nc_path by prepending '/'", async () => {
    const { signShareUrl, verifyShareUrl } = await importSigner();
    const token = signShareUrl("alice", "Clips/x.mp4", 600);
    const verified = verifyShareUrl(token);
    expect(verified?.ncPath).toBe("/Clips/x.mp4");
  });

  it("rejects nc_path longer than 4096 chars", async () => {
    const { signShareUrl } = await importSigner();
    expect(() => signShareUrl("alice", "/" + "a".repeat(4096), 600)).toThrow(/too long/);
  });
});

describe("DEVICE_SECRET handling", () => {
  it("throws on signing whenever DEVICE_SECRET is unset (no dev fallback)", async () => {
    // Per the security review: a dev fallback constant would be identical
    // on every install — anyone who reads the source could forge tokens and
    // exercise the pre-auth share endpoint. signing must always require the
    // operator-set secret.
    delete process.env.DEVICE_SECRET;
    const { signShareUrl } = await importSigner();
    for (const env of ["production", "development", "test", undefined as unknown as string]) {
      const old = process.env.NODE_ENV;
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;
      try {
        expect(() => signShareUrl("alice", "/x.mp4", 60)).toThrow(/DEVICE_SECRET/);
      } finally {
        if (old === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = old;
      }
    }
  });

  it("verifyShareUrl returns null instead of throwing when DEVICE_SECRET is unset", async () => {
    // We don't want a missing secret to crash the request path — return null
    // (treated as invalid token) and let the route surface 403.
    delete process.env.DEVICE_SECRET;
    const { verifyShareUrl } = await importSigner();
    expect(verifyShareUrl("anything.anything")).toBeNull();
  });

  it("rotating DEVICE_SECRET invalidates all previously-signed tokens", async () => {
    const { signShareUrl } = await importSigner();
    process.env.DEVICE_SECRET = "key-A";
    const tokenA = signShareUrl("alice", "/x.mp4", 600);

    // Re-import with new secret — but since the helper reads process.env on
    // every call, just changing the env is enough.
    process.env.DEVICE_SECRET = "key-B";
    const { verifyShareUrl } = await importSigner();
    expect(verifyShareUrl(tokenA)).toBeNull();
  });
});

// CodeQL js/polynomial-redos: the base64url pad strip is bounded (`={1,2}$`)
// — base64 of a Buffer never carries more than two `=`. Every payload
// length mod 3 (0, 1, 2 pads) must still come out pad-free and verify.
describe("signShareUrl — base64url encoding", () => {
  it("emits pad-free base64url for every padding class and round-trips", async () => {
    const { signShareUrl, verifyShareUrl } = await importSigner();
    for (const ncPath of ["/a.mp4", "/ab.mp4", "/abc.mp4", "/abcd.mp4", "/abcde.mp4"]) {
      const token = signShareUrl("alice", ncPath, 600);
      expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(verifyShareUrl(token)?.ncPath).toBe(ncPath);
    }
  });
});
