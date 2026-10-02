/**
 * WARP-2954 / ADR-058 — the pairing link carries the served certificate's
 * key fingerprint so a client can pair to THIS box with no CA and no HQ.
 *
 * The pin must be byte-identical to what every other side computes (the
 * openssl recipe, the Windows app's `spki_sha256_b64`), it must follow a
 * cert swap, and a box without a readable leaf must mint exactly the link
 * it minted before.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  spkiSha256Base64FromPem,
  servedCertPin,
  buildPairUrl,
  _resetServedCertPinCacheForTests,
} from "./served-cert-pin.js";

/** The house unit's actual self-signed bootstrap leaf (public data — any TLS
 *  client on the LAN sees it). Inlined: the orchestrator compiles to CommonJS,
 *  so `import.meta.url` fixture paths are not available here. */
const LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIDbjCCAlagAwIBAgIUAlSK5TGY8EIKhYF9BpBMUtmUHIYwDQYJKoZIhvcNAQEL
BQAwHjEcMBoGA1UEAwwTRHJvcGxldCBFZGdlIERldmljZTAeFw0yNjA4MjQwMDE2
NTlaFw0zNjA4MjEwMDE2NTlaMB4xHDAaBgNVBAMME0Ryb3BsZXQgRWRnZSBEZXZp
Y2UwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDJTowoqlgJIqh2BWAU
oeF7tWViDbPvgWkQb/GjiiDfy+3mhaYGlME1AUliZ2RFKcfUaZUWl/Hx/m0IB76U
V4sprx+RBOMGkIUQcX+7XlKuLaUsMFfoKtanTgz3QUu6DL5DZmHseODcSckF5alB
Di8JsbQ3XORbs4/k+st+rZ7ixcXq8Ew8YMBWyzRSAOTNyuBIRyubpE2ICXTev9Vt
Cgte5Gfya2XSDyQMe13zCtHQeRTENZrfiMaD6nv7jmP0MemtDUV3MGYS4MT3jONs
GkHINdp/bxCsNS1/xaw+Zsjf2k62HVnUQU6iSFYv4D2GWZ+grCcckzClS3UbbF8C
bpNPAgMBAAGjgaMwgaAwfwYDVR0RBHgwdoIJbG9jYWxob3N0ggdkcm9wbGV0gg1k
cm9wbGV0LmxvY2Fsggtkcm9wbGV0LmxhboIKZHJvcGxldC1haYIQZHJvcGxldC1h
aS5sb2NhbIIOZHJvcGxldC1haS5sYW6HBMCoCcOHBKwRAAGHBH8AAAGHBKwSAAEw
HQYDVR0OBBYEFMcORZ7r953P5iWdsn+jxt8IVQXSMA0GCSqGSIb3DQEBCwUAA4IB
AQAfOcbb8KAdhx0nQ0LAIqjr+dvJGA+aQ7iE0PGS/foH9stCNb0BYUl9u3hw8DeG
iDuqL9xslTLj59q1CXakQp9Nwcabmuz4g0ecvt/bAlp/hr1wufdwMC4sGfQFd5Mm
mdhemY5mWxsJ9qK5T0g8RUrsWVQLvA54arkBrlu1B76U94D4mD4PuqvQgjd94oSh
oBSExYAPhKI1v2xIYyMiyInzx7XLzYJai0lZA2jvzI00Lgl53Gm7OiTZtd3mXTqA
LShUlCL6TPB4psnOIT1WLAi0VRlAmMiPh9O9guVJ+Uk9NoMXFC+3ANSNebfb1KBF
uSd9DJAIdEt6/CNInKDHBh7j
-----END CERTIFICATE-----
`;
/**
 * Derived independently of this code:
 *   openssl x509 -in droplet-bootstrap-leaf.pem -pubkey -noout \
 *     | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | base64
 * If this ever disagrees, the pin is NOT the standard SPKI pin and no client
 * could match it.
 */
const LEAF_PIN = "8BevqGrXi+1KveZGkPBbe42742sm6cj0EOU2ph498lw=";

/** A different, throwaway self-signed certificate (EC P-256), standing in
 *  for an issuer in a fullchain. Its pin is NOT the leaf's. */
const OTHER_PEM = `-----BEGIN CERTIFICATE-----
MIIBiTCCAS+gAwIBAgIUU2bfFP3pEX0xzT8TuDlM6SY50mMwCgYIKoZIzj0EAwIw
GjEYMBYGA1UEAwwPTm90IFRoZSBEcm9wbGV0MB4XDTI2MDkyMDA0MjczNVoXDTM2
MDkxNzA0MjczNVowGjEYMBYGA1UEAwwPTm90IFRoZSBEcm9wbGV0MFkwEwYHKoZI
zj0CAQYIKoZIzj0DAQcDQgAEC7KbsUD7ya3bQxkU6gbtNWbkRNFXCNcbSZoW+AJD
xZGugugxo5p/vTlvfgQdQTClu3nKR3njaIBWQNSuLTmRy6NTMFEwHQYDVR0OBBYE
FNexwk2B4shUh1btXSncgJC3WixLMB8GA1UdIwQYMBaAFNexwk2B4shUh1btXSnc
gJC3WixLMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIhAIDXzui/
2nvwIP5vgcS0OlemlgI/qcl4Iq7jqAyrOGOrAiB5+lhyszwl7mwHg0QfO6E0zJyc
f86/TAq3n+pvbs2X9A==
-----END CERTIFICATE-----
`;
const OTHER_PIN = "1YbIMDdce/GDFyqYHC6oIhEX9Bn4t8qGt7bm6uNkdMc=";

describe("spkiSha256Base64FromPem", () => {
  it("is the standard SPKI-SHA256 pin of the first certificate", () => {
    expect(spkiSha256Base64FromPem(LEAF_PEM)).toBe(LEAF_PIN);
  });

  it("pins the LEAF of a fullchain, not the issuer", () => {
    // An LE install writes leaf first, then intermediates; the pin the
    // client checks is the key it handshakes with — the leaf's. Guarded by
    // the two pins actually differing, so a last-block implementation fails.
    expect(spkiSha256Base64FromPem(OTHER_PEM)).toBe(OTHER_PIN);
    expect(OTHER_PIN).not.toBe(LEAF_PIN);
    expect(spkiSha256Base64FromPem(LEAF_PEM + OTHER_PEM)).toBe(LEAF_PIN);
  });

  it("throws on a PEM with no certificate rather than pinning garbage", () => {
    expect(() => spkiSha256Base64FromPem("not a pem")).toThrow();
    expect(() =>
      spkiSha256Base64FromPem("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"),
    ).toThrow();
  });
});

describe("servedCertPin", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "served-cert-pin-"));
    _resetServedCertPinCacheForTests();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads docker/certs/droplet.crt and caches by mtime", () => {
    writeFileSync(join(dir, "droplet.crt"), LEAF_PEM);
    utimesSync(join(dir, "droplet.crt"), 1_700_000_000, 1_700_000_000);
    expect(servedCertPin(dir)).toBe(LEAF_PIN);
    // Same mtime → cached: even an unreadable body is not re-parsed.
    writeFileSync(join(dir, "droplet.crt"), "garbage");
    utimesSync(join(dir, "droplet.crt"), 1_700_000_000, 1_700_000_000);
    expect(servedCertPin(dir)).toBe(LEAF_PIN);
  });

  it("follows a certificate swap (new mtime → new pin, or none)", () => {
    writeFileSync(join(dir, "droplet.crt"), LEAF_PEM);
    utimesSync(join(dir, "droplet.crt"), 1_700_000_000, 1_700_000_000);
    expect(servedCertPin(dir)).toBe(LEAF_PIN);
    // A swap to something unreadable must NOT keep minting the old pin — a
    // client holding it would be told "identity changed", which is right.
    writeFileSync(join(dir, "droplet.crt"), "garbage");
    utimesSync(join(dir, "droplet.crt"), 1_800_000_000, 1_800_000_000);
    expect(servedCertPin(dir)).toBeNull();
  });

  it("is null, never a throw, when the leaf is missing", () => {
    expect(servedCertPin(dir)).toBeNull();
    expect(servedCertPin(join(dir, "does-not-exist"))).toBeNull();
  });
});

describe("buildPairUrl", () => {
  it("appends spki= only when a pin is known, keeping the pre-existing shape otherwise", () => {
    expect(buildPairUrl("https://192.168.9.195", "ABCD23", null)).toBe(
      "droplet://pair?server=https%3A%2F%2F192.168.9.195&code=ABCD23",
    );
    expect(buildPairUrl("https://192.168.9.195", "ABCD23", LEAF_PIN)).toBe(
      "droplet://pair?server=https%3A%2F%2F192.168.9.195&code=ABCD23&spki=8BevqGrXi%2B1KveZGkPBbe42742sm6cj0EOU2ph498lw%3D",
    );
  });

  it("round-trips through URLSearchParams the way the clients parse it", () => {
    const url = new URL(buildPairUrl("https://droplet.local", "ABCD23", LEAF_PIN));
    expect(url.host).toBe("pair");
    expect(url.searchParams.get("server")).toBe("https://droplet.local");
    expect(url.searchParams.get("code")).toBe("ABCD23");
    expect(url.searchParams.get("spki")).toBe(LEAF_PIN);
  });
});
