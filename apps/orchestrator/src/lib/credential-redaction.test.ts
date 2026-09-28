/**
 * WARP-3282 — credential redaction for tool results entering the model
 * context. `redactCredentials()` scrubs free business text (a retrieved
 * document, an email body), so it matches VALUE SHAPES only and must leave
 * ordinary business prose, paths, UUIDs and hashes alone.
 */
import { describe, it, expect } from "vitest";
import {
  redactCredentials,
  redactCredentialValues,
  redactToolResult,
  redactSecrets,
  CREDENTIAL_PLACEHOLDER,
} from "./log-redaction.js";

const P = CREDENTIAL_PLACEHOLDER;
const HUBSPOT_FAKE = ["pat", "na1", "EXAMPLE-FIXTURE-NOT-A-REAL-TOKEN"].join("-");
const GOOGLE_FAKE = "AI" + "za" + "EXAMPLExFIXTUREx".repeat(2) + "NOTAKEY";

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
    // Review round 1 (Stefan, #2469) — shapes the first cut let through.
    ["lowercase snake_case db_password=", "db_password=hunter2hunter", "hunter2hunter"],
    ["YAML UPPER_SNAKE KEY: value", "  DB_PASSWORD: s3cr3tValue9\n", "s3cr3tValue9"],
    ["backtick-quoted env value", "set SECRET_KEY=`abcdef123456` first", "abcdef123456"],
    ["double-quoted env value (raw)", 'export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG"', "wJalrXUtnFEMI/K7MDENG"],
    ["markdown-bold password label", "**Password:** Hunter2!", "Hunter2!"],
    ["markdown-bold label, colon outside", "**Password**: Hunter2!", "Hunter2!"],
    ["Stripe publishable pk_live_", "pk_live_51H8xYzAbCdEfGhIjKlMn", "pk_live_51H8xYzAbCdEfGhIjKlMn"],
    // Assembled at runtime so push protection does not read a fixture as a
    // live key; the shapes are what the rules see.
    ["HubSpot private-app token", `token ${HUBSPOT_FAKE}`, HUBSPOT_FAKE],
    ["Google API key", `key=${GOOGLE_FAKE}`, GOOGLE_FAKE],
    ["Google OAuth access token", "ya29.a0AfH6SMBx7Yk2Lq9Zp3Rt5Uv8Wx1", "ya29.a0AfH6SMBx7Yk2Lq9Zp3Rt5Uv8Wx1"],
    ["Anthropic sk-ant- key", "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"],
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

  it("a PEM block cut off before its END line (a 280-char search snippet) still loses its body", () => {
    const cut = "deploy notes\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW";
    const { text, count } = redactCredentials(cut);
    expect(text).not.toContain("b3BlbnNzaC1rZXktdjEAAAAABG5vbmU");
    expect(text).not.toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(text).toContain("deploy notes");
    expect(count).toBe(1);
  });

  it("a quoted password keeps its quotes, so JSON text stays JSON", () => {
    const { text } = redactCredentials('{"password": "correct horse battery"}');
    expect(JSON.parse(text)).toEqual({ password: P });
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
    // Review round 1 (Stefan, #2469).
    "Password: 12 characters minimum, one symbol.",
    "Password: 8+ characters.",
    "Opened /Shared/sk-projects-2026-budget-final-v2.xlsx for the Q4 review.",
    "sk-learn-2026-workshop-notes-final-version.docx",
    "Citation: /Shared/Archive/sk-Q3ForecastModelWorkbook2026.xlsx",
    '{"subject":"see http://host:8080","from":"bob@x.io"}',
    "TOP SECRET: launch plan approved.",
    "max_tokens=4096 and TOKEN_LIMIT=4096",
    "Contract signed; pat-a-cake-recipe-for-the-party attached.",
  ];
  for (const input of untouched) {
    it(`leaves alone: ${input.slice(0, 50)}`, () => {
      expect(redactCredentials(input)).toEqual({ text: input, count: 0 });
    });
  }

  it("stays linear on a long unbroken run (a base64 blob in a 200k page)", () => {
    // The uri-userinfo scheme class was unbounded, so every letter started a
    // scan to the end of the run: ~20 s for 200k chars. Bounded to 32 chars
    // (no real scheme is longer), it is a few ms.
    const t = Date.now();
    expect(redactCredentials("a".repeat(200_000)).count).toBe(0);
    expect(Date.now() - t).toBeLessThan(1_000);
  });

  it("handles empty input", () => {
    expect(redactCredentials("")).toEqual({ text: "", count: 0 });
  });
});

/**
 * Review round 1 (Stefan, #2469) — the loop hands `redactToolResult` the JSON
 * WIRE text, where a quoted value is escaped (`KEY=\\"value\\"`). Every case
 * here builds the wire with JSON.stringify, exactly as mcp-server does, and
 * asserts the output still parses.
 */
describe("redactToolResult — the JSON wire form", () => {
  const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const wireCases: Array<[string, unknown, string]> = [
    [
      "a double-quoted env assignment in a snippet",
      { results: [{ path: "/Shared/IT/.env", snippet: `export AWS_SECRET_ACCESS_KEY="${SECRET}"` }] },
      SECRET,
    ],
    [
      "a JSON document's password inside a read_file page",
      { path: "/Shared/IT/config.json", content: '{\n  "user": "svc",\n  "password": "correct horse battery"\n}' },
      "correct horse battery",
    ],
    [
      "a compose list item with a quoted env pair",
      { path: "/Shared/IT/docker-compose.yml", content: `environment:\n  - "AWS_SECRET_ACCESS_KEY=${SECRET}"\n` },
      SECRET,
    ],
    [
      "a password-named field in the payload itself",
      { account: "svc", password: "hunter2hunter" },
      "hunter2hunter",
    ],
    [
      "an UPPER_SNAKE secret-named field",
      { vars: { STRIPE_API_KEY: "abcdef123456", REGION: "us-east-1" } },
      "abcdef123456",
    ],
    [
      "a PEM block truncated at a snippet boundary, next to a citation",
      { results: [{ path: "/Shared/IT/keys.md", snippet: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEeP" }, { path: "/b.md", snippet: "fine" }] },
      "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEeP",
    ],
  ];

  for (const [name, payload, secret] of wireCases) {
    it(`redacts ${name}; the output is valid JSON`, () => {
      const wire = JSON.stringify(payload);
      const { text, count } = redactToolResult(wire);
      expect(text).not.toContain(secret);
      expect(text).toContain(P);
      expect(count).toBeGreaterThanOrEqual(1);
      expect(() => JSON.parse(text)).not.toThrow();
    });
  }

  it("keeps every sibling field and the citation path", () => {
    const wire = JSON.stringify({
      results: [
        { path: "/Shared/IT/.env", snippet: `export AWS_SECRET_ACCESS_KEY="${SECRET}"` },
        { path: "/Shared/IT/keys.md", snippet: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1" },
      ],
      total: 2,
    });
    const parsed = JSON.parse(redactToolResult(wire).text);
    expect(parsed.total).toBe(2);
    expect(parsed.results.map((r: { path: string }) => r.path)).toEqual(["/Shared/IT/.env", "/Shared/IT/keys.md"]);
    expect(parsed.results[0].snippet).toBe(`export AWS_SECRET_ACCESS_KEY="${P}"`);
  });

  it("a URI next to an email in compact JSON eats no neighbouring field", () => {
    const wire = JSON.stringify({ subject: "see http://host:8080", from: "bob@x.io" });
    expect(redactToolResult(wire)).toEqual({ text: wire, count: 0 });
  });

  it("a clean payload comes back byte-identical", () => {
    const wire = '{ "results": [ {"path":"/a.md","snippet":"Q3 revenue grew 12%."} ] }';
    expect(redactToolResult(wire)).toEqual({ text: wire, count: 0 });
  });

  it("a confirmation envelope is left byte-identical (the approval path reads its token)", () => {
    const wire = JSON.stringify({
      status: "confirmation_required",
      error: { code: "CONFIRMATION_REQUIRED", details: { confirmationToken: "4f9a0c1e2b3d4f5a6b7c8d9e0f1a2b3c4d5e6f70" } },
    });
    expect(redactToolResult(wire)).toEqual({ text: wire, count: 0 });
  });

  it("non-JSON text falls back to the raw scrub", () => {
    const { text, count } = redactToolResult(`plain text AWS_SECRET_ACCESS_KEY=${SECRET}`);
    expect(text).toBe(`plain text AWS_SECRET_ACCESS_KEY=${P}`);
    expect(count).toBe(1);
  });

  it("a __proto__ key survives re-serialisation", () => {
    const wire = '{"__proto__":{"x":1},"snippet":"password=Hunter2!"}';
    expect(JSON.parse(redactToolResult(wire).text)).toEqual(JSON.parse(`{"__proto__":{"x":1},"snippet":"password=${P}"}`));
  });

  it("is idempotent", () => {
    const once = redactToolResult(JSON.stringify({ snippet: `AWS_SECRET_ACCESS_KEY="${SECRET}"`, password: "hunter2hunter" }));
    expect(redactToolResult(once.text)).toEqual({ text: once.text, count: 0 });
  });
});

describe("redactCredentialValues — a parsed tool result", () => {
  it("scrubs string leaves and secret-named fields, never mutating the input", () => {
    const input = { rows: [{ note: "password=Hunter2!" }], password: "hunter2hunter", passwordProtected: true, n: 3 };
    const { value, count } = redactCredentialValues(input);
    expect(value).toEqual({ rows: [{ note: `password=${P}` }], password: P, passwordProtected: true, n: 3 });
    expect(count).toBe(2);
    expect(input.password).toBe("hunter2hunter");
  });

  it("returns the same reference when nothing matched", () => {
    const input = { a: ["x", { b: "y" }] };
    expect(redactCredentialValues(input)).toEqual({ value: input, count: 0 });
    expect(redactCredentialValues(input).value).toBe(input);
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
