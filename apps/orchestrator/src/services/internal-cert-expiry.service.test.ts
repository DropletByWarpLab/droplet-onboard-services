import { describe, it, expect } from "vitest";
import { X509Certificate } from "node:crypto";
import { daysLeftFromPem } from "./internal-cert-expiry.service.js";

// A throwaway self-signed leaf (no private key kept), used only for its dates.
const PEM = `-----BEGIN CERTIFICATE-----
MIIBfDCCASKgAwIBAgIUJdi6VqqCJBEaD0cWClpbvsLZS2IwCgYIKoZIzj0EAwIw
JDEQMA4GA1UECgwHRHJvcGxldDEQMA4GA1UEAwwHZml4dHVyZTAeFw0yNjEwMDQw
NzA4MTNaFw0yNzAxMDIwNzA4MTNaMCQxEDAOBgNVBAoMB0Ryb3BsZXQxEDAOBgNV
BAMMB2ZpeHR1cmUwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASSEUtCOnqd/RFj
lDTb1kPkxveQWNYRWt2/CigK9r6gulaSOULqQUgOTzY2X1Tzk7e+aWon8pvecJkk
neg5VPdJozIwMDAdBgNVHQ4EFgQUOMNb2MPgKzR532DkR5hHqvqD5vEwDwYDVR0T
AQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiBPDvb9arJkfo2hAOathMhSvCWH
RxJu+QkTwaZyM7G1GQIhAKT0SHC6kTex3FKo5XCJcwwwPDnp6Pf9yOmMao37jTYy
-----END CERTIFICATE-----
`;

describe("daysLeftFromPem (WARP-3653)", () => {
  const notAfter = new Date(new X509Certificate(PEM).validTo);
  it("counts whole days to notAfter", () => {
    expect(daysLeftFromPem(PEM, new Date(notAfter.getTime() - 10.5 * 86_400_000))).toBe(10);
  });
  it("goes negative once expired", () => {
    expect(daysLeftFromPem(PEM, new Date(notAfter.getTime() + 2 * 86_400_000))).toBe(-2);
  });
  it("is null for something that is not a certificate, never 0", () => {
    expect(daysLeftFromPem("not a pem")).toBeNull();
  });
});
