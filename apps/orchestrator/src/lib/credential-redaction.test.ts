/**
 * WARP-3282 — credential redaction for tool results entering the model
 * context. `redactCredentials()` scrubs free business text (a retrieved
 * document, an email body), so it matches VALUE SHAPES only and must leave
 * ordinary business prose, paths, UUIDs and hashes alone.
 */
import { describe, it, expect } from "vitest";
import {
  redactCredentials,
  redactSecrets,
  CREDENTIAL_PLACEHOLDER,
} from "./log-redaction.js";

const P = CREDENTIAL_PLACEHOLDER;

describe("redactCredentials — positives", () => {
  const cases: Array<[string, string, string]> = [
    // [name, input, secret that must not survive]
    [
      "AWS secret after AWS_SECRET_ACCESS_KEY= (the adv-019 shape)",
      "Legacy integration credential (do not share): AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    ],
    [
      "lowercase aws_secret_access_key in a credentials file",
      "[default]\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n",
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    ],
    ["AWS access key id", "key id AKIAIOSFODNN7EXAMPLE for prod", "AKIAIOSFODNN7EXAMPLE"],
    ["AWS temporary key id", "ASIAY34FZKBOKMUTVV7A", "ASIAY34FZKBOKMUTVV7A"],
    ["OpenAI sk- key", "use sk-proj-abc123DEF456ghi789JKL012mno", "sk-proj-abc123DEF456ghi789JKL012mno"],
    ["Stripe sk_live_", "stripe: sk_live_51H8xYzAbCdEfGhIjKlMn", "sk_live_51H8xYzAbCdEfGhIjKlMn"],
    ["Stripe rk_live_", "rk_live_51H8xYzAbCdEfGhIjKlMn", "rk_live_51H8xYzAbCdEfGhIjKlMn"],
    [
      "GitHub classic PAT",
      "token ghp_16C7e42F292c6912E7710c838347Ae178B4a in the wiki",
      "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
    ],
    [
      "GitHub fine-grained PAT",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
    ],
    ["Slack bot token", "xoxb-123456789012-1234567890123-AbCdEfGhIjKl", "xoxb-123456789012-1234567890123-AbCdEfGhIjKl"],
    [
      "JWT",
      "session eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U end",
      "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ],
    ["opaque bearer token", "curl -H 'Authorization: Bearer 9f8e7d6c5b4a39281706abcd' x", "9f8e7d6c5b4a39281706abcd"],
    ["password= assignment", "db login: password=Hunter2!", "Hunter2!"],
    ["passwd: with a non-word value", "passwd: S3cret-Pass", "S3cret-Pass"],
    ["quoted JSON password", '{"password": "correct horse battery"}', "correct horse battery"],
    ["env *_PASSWORD even letters-only", "DB_PASSWORD=correcthorsebattery", "correcthorsebattery"],
    ["env *_API_KEY", "STRIPE_API_KEY=abcdef123456", "abcdef123456"],
    ["URI userinfo", "postgres://app:s3cr3tpw@db.internal:5432/erp", "s3cr3tpw"],
  ];

  for (const [name, input, secret] of cases) {
    it(`redacts ${name}`, () => {
      const { text, count } = redactCredentials(input);
      expect(text).not.toContain(secret);
      expect(text).toContain(P);
      expect(count).toBeGreaterThanOrEqual(1);
    });
  }

  it("collapses a PEM private-key block entirely", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo\n4lgOEePzNm0tRgeLezV6ffAt0gunVTLw\n-----END RSA PRIVATE KEY-----";
    const { text, count } = redactCredentials(`server key:\n${pem}\nthanks`);
    expect(text).not.toContain("MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo");
    expect(text).toContain("server key:");
    expect(text).toContain("thanks");
    expect(count).toBe(1);
  });

  it("keeps the key name so the answer can say a credential exists", () => {
    const { text } = redactCredentials("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(text).toBe(`AWS_SECRET_ACCESS_KEY=${P}`);
  });

  it("counts every redaction", () => {
    const { count } = redactCredentials(
      "AKIAIOSFODNN7EXAMPLE and AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY and password=x9",
    );
    expect(count).toBe(3);
  });

  it("is idempotent", () => {
    const once = redactCredentials(
      "password: S3cret! AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    );
    const twice = redactCredentials(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.count).toBe(0);
  });

  it("scrubs inside a JSON tool-result string without breaking the JSON", () => {
    const wire = JSON.stringify({
      results: [{ path: "/Shared/IT/legacy.md", snippet: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" }],
    });
    const { text } = redactCredentials(wire);
    const parsed = JSON.parse(text);
    expect(parsed.results[0].path).toBe("/Shared/IT/legacy.md");
    expect(parsed.results[0].snippet).toBe(`AWS_SECRET_ACCESS_KEY=${P}`);
  });
});

describe("redactCredentials — negatives (normal business text survives)", () => {
  const untouched = [
    "Invoice 550e8400-e29b-41d4-a716-446655440000 paid on 2026-09-01.",
    "sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "Fixed in commit 129016f27a4c1b2d3e4f5a6b7c8d9e0f1a2b3c4d.",
    "See /Shared/IT/passwords/aws_secret_access_key.txt for the rotation runbook.",
    "Password policy: minimum 12 characters, rotated quarterly.",
    "Password: required.",
    "Reset your password: click the link we emailed.",
    '{"passwordProtected": true, "expiresAt": "2026-10-01"}',
    '{"confirmationToken":"4f9a0c1e2b3d4f5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c"}',
    "The token count was 512 and TOKEN_LIMIT=4096 in the config.",
    "Our task-manager-integration-2026-roadmap is in review.",
    "Bearer bonds and bearer instruments were discussed at the board meeting.",
    "Base64 logo: iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "Your secret access key is shown only once when you create it in the AWS console.",
    "TOP SECRET: the Q4 launch plan.",
  ];
  for (const input of untouched) {
    it(`leaves alone: ${input.slice(0, 50)}`, () => {
      expect(redactCredentials(input)).toEqual({ text: input, count: 0 });
    });
  }

  it("handles empty input", () => {
    expect(redactCredentials("")).toEqual({ text: "", count: 0 });
  });
});

describe("one shared pattern list", () => {
  it("the log-bundle scrub also catches the value shapes (no second list)", () => {
    for (const secret of [
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
      "xoxb-123456789012-1234567890123-AbCdEfGhIjKl",
    ]) {
      expect(redactSecrets(`found ${secret} in a log`)).not.toContain(secret);
    }
  });
});
