# Email-as-identity Auth Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align setup, invite-accept, and admin add-user onto the email-as-identity model already used by sign-in (ADR-013): drop username from every UI (derive a Nextcloud-safe userid server-side), surface email + password rules with a live checklist, and raise the password policy to 12–128 chars + 3-of-4 character classes.

**Architecture:** A new `@droplet/auth-policy` workspace package is the single source of truth for the password rules, email normalization, and username derivation. The orchestrator's Zod schemas and the dashboard's live checklist both consume it, so the validation can never drift. The dashboard consumes it via Next `transpilePackages` (it ships runtime code, not just types).

**Tech Stack:** TypeScript, Zod, Express + Prisma (orchestrator), Next.js 14 + React + Tailwind (dashboard), Vitest + Supertest + Testing Library (tests).

**Spec:** `docs/superpowers/specs/2026-06-01-email-identity-auth-consistency-design.md`

---

## File structure

**New (`@droplet/auth-policy`):**
- `packages/auth-policy/package.json` — workspace package manifest (mirrors `packages/shared-types`)
- `packages/auth-policy/tsconfig.json`
- `packages/auth-policy/src/index.ts` — barrel
- `packages/auth-policy/src/password.ts` — rules + `validatePassword`
- `packages/auth-policy/src/password.zod.ts` — `passwordZod`
- `packages/auth-policy/src/userid.ts` — `normalizeEmail`, `isValidEmail`, `baseUserIdFromEmail`, `nthUserIdCandidate`, `isReservedUserId`, `deriveUserId`
- `packages/auth-policy/src/__tests__/password.test.ts`
- `packages/auth-policy/src/__tests__/userid.test.ts`

**Modified (orchestrator):**
- `apps/orchestrator/package.json` — add dep
- `apps/orchestrator/src/routes/auth.ts` — schemas, route validation, userid derivation
- `apps/orchestrator/src/routes/auth.directory-setup.test.ts` — drop username, assert derivation
- `apps/orchestrator/src/__tests__/auth.invites.test.ts` — invite email-required
- `apps/orchestrator/src/routes/auth.directory-invite-accept.test.ts` — new password policy
- New: `apps/orchestrator/src/routes/auth.userid-derivation.test.ts`

**Modified (dashboard):**
- `apps/web-dashboard/package.json` — add dep
- `apps/web-dashboard/next.config.js` — `transpilePackages`
- `apps/web-dashboard/src/lib/api.ts` — send `email`
- `apps/web-dashboard/src/lib/friendly-errors.ts` — new codes
- `apps/web-dashboard/src/components/auth/PasswordRulesChecklist.tsx` — new shared component
- `apps/web-dashboard/src/components/setup/steps/AccountStep.tsx` — email + checklist
- `apps/web-dashboard/src/app/invite/[token]/page.tsx` — checklist + policy
- `apps/web-dashboard/src/app/settings/page.tsx` — checklist + policy
- `apps/web-dashboard/src/app/users/page.tsx` — email + checklist
- `apps/web-dashboard/src/components/setup/steps/TeamStep.tsx` — email invite
- Test updates: `setup.flow`, `login.aurora`, `users.invite`, `setup.e2e` + new `PasswordRulesChecklist.test.tsx`

---

## Phase 1 — Shared policy package

### Task 1: Scaffold `@droplet/auth-policy` and wire it into both apps

**Files:**
- Create: `packages/auth-policy/package.json`
- Create: `packages/auth-policy/tsconfig.json`
- Create: `packages/auth-policy/src/index.ts`
- Modify: `apps/orchestrator/package.json` (dependencies)
- Modify: `apps/web-dashboard/package.json` (dependencies)
- Modify: `apps/web-dashboard/next.config.js`

- [ ] **Step 1: Create the package manifest** (mirrors `packages/shared-types/package.json` — source-first exports so `tsx` and vitest resolve the `.ts`, `dist` for prod `require`)

`packages/auth-policy/package.json`:
```json
{
  "name": "@droplet/auth-policy",
  "version": "0.1.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts",
      "require": "./dist/index.js",
      "default": "./src/index.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src/"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.12.12",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create the tsconfig** (copy of `packages/shared-types/tsconfig.json` shape; NodeNext to match orchestrator)

`packages/auth-policy/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "__tests__"]
}
```

- [ ] **Step 3: Create a placeholder barrel so the package resolves**

`packages/auth-policy/src/index.ts`:
```ts
export * from "./password.js";
export * from "./password.zod.js";
export * from "./userid.js";
```

- [ ] **Step 4: Add the dependency to both apps**

In `apps/orchestrator/package.json`, add to `dependencies` (alphabetical, after `@droplet/tools-core`):
```json
    "@droplet/auth-policy": "0.1.0",
```

In `apps/web-dashboard/package.json`, add to `dependencies` (alphabetical, before `@droplet/shared-types`):
```json
    "@droplet/auth-policy": "0.1.0",
```

- [ ] **Step 5: Enable Next transpilation of the package** (it ships runtime code; without this Next won't compile the `.ts` from node_modules)

In `apps/web-dashboard/next.config.js`, add `transpilePackages` to `nextConfig`:
```js
const nextConfig = {
  output: "standalone",
  transpilePackages: ["@droplet/auth-policy"],
  experimental: {
    outputFileTracingRoot: path.join(__dirname, "../../"),
  },
```

- [ ] **Step 6: Install workspaces so the symlinks exist**

Run: `cd /Users/rjouffret/Projects/Droplet/droplet-onboard-services/.claude/worktrees/distracted-proskuriakova-d39fbe && npm install`
Expected: completes; `node_modules/@droplet/auth-policy` symlink created. (Tasks 2–3 create the real source; the barrel imports will resolve once those files exist — that's fine, this step only wires the workspace.)

- [ ] **Step 7: Commit**
```bash
git add packages/auth-policy apps/orchestrator/package.json apps/web-dashboard/package.json apps/web-dashboard/next.config.js package-lock.json
git commit -m "chore(auth-policy): scaffold @droplet/auth-policy workspace package"
```

---

### Task 2: Password rules + `validatePassword` (TDD)

**Files:**
- Test: `packages/auth-policy/src/__tests__/password.test.ts`
- Create: `packages/auth-policy/src/password.ts`

- [ ] **Step 1: Write the failing test**

`packages/auth-policy/src/__tests__/password.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { validatePassword, PASSWORD_RULES, PASSWORD_MIN, PASSWORD_MAX } from "../password.js";

describe("validatePassword", () => {
  it("rejects an 11-char password (below the 12 minimum)", () => {
    // 'Aa1!Aa1!Aa1' = 11 chars, 4 classes — fails ONLY on length.
    const r = validatePassword("Aa1!Aa1!Aa1");
    expect(r.ok).toBe(false);
    expect(r.failed).toContain("length");
    expect(r.failed).not.toContain("classes");
  });

  it("accepts a 12-char password with 3 classes", () => {
    // 'Abcdefghijk1' = 12 chars: lower+upper+digit = 3 classes.
    const r = validatePassword("Abcdefghijk1");
    expect(r.ok).toBe(true);
    expect(r.failed).toEqual([]);
  });

  it("rejects a long password with only 2 classes", () => {
    // 'abcdefghijklmnop1' = 17 chars: lower+digit = 2 classes.
    const r = validatePassword("abcdefghijklmnop1");
    expect(r.ok).toBe(false);
    expect(r.failed).toContain("classes");
    expect(r.failed).not.toContain("length");
  });

  it("rejects a password over the 128 maximum", () => {
    const r = validatePassword("Aa1!".repeat(33)); // 132 chars
    expect(r.failed).toContain("length");
  });

  it("exposes rules for UI rendering with stable ids", () => {
    expect(PASSWORD_RULES.map((x) => x.id)).toEqual(["length", "classes"]);
    expect(PASSWORD_MIN).toBe(12);
    expect(PASSWORD_MAX).toBe(128);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/auth-policy && npx vitest run`
Expected: FAIL — `Cannot find module '../password.js'`.

- [ ] **Step 3: Write the implementation**

`packages/auth-policy/src/password.ts`:
```ts
export type PasswordRuleId = "length" | "classes";

export interface PasswordRule {
  id: PasswordRuleId;
  label: string;
  test: (pw: string) => boolean;
}

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
export const PASSWORD_REQUIRED_CLASSES = 3;

/** Count distinct character classes present: lower, upper, digit, symbol. */
function classCount(pw: string): number {
  let n = 0;
  if (/[a-z]/.test(pw)) n += 1;
  if (/[A-Z]/.test(pw)) n += 1;
  if (/[0-9]/.test(pw)) n += 1;
  if (/[^a-zA-Z0-9]/.test(pw)) n += 1;
  return n;
}

export const PASSWORD_RULES: PasswordRule[] = [
  {
    id: "length",
    label: `Between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters`,
    test: (pw) => pw.length >= PASSWORD_MIN && pw.length <= PASSWORD_MAX,
  },
  {
    id: "classes",
    label: `At least ${PASSWORD_REQUIRED_CLASSES} of: lowercase, uppercase, number, symbol`,
    test: (pw) => classCount(pw) >= PASSWORD_REQUIRED_CLASSES,
  },
];

export function validatePassword(pw: string): {
  ok: boolean;
  failed: PasswordRuleId[];
} {
  const failed = PASSWORD_RULES.filter((r) => !r.test(pw)).map((r) => r.id);
  return { ok: failed.length === 0, failed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/auth-policy && npx vitest run`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**
```bash
git add packages/auth-policy/src/password.ts packages/auth-policy/src/__tests__/password.test.ts
git commit -m "feat(auth-policy): password policy (12-128 chars, 3-of-4 classes)"
```

---

### Task 3: Username derivation + email helpers (TDD)

**Files:**
- Test: `packages/auth-policy/src/__tests__/userid.test.ts`
- Create: `packages/auth-policy/src/userid.ts`
- Create: `packages/auth-policy/src/password.zod.ts`

- [ ] **Step 1: Write the failing test**

`packages/auth-policy/src/__tests__/userid.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  normalizeEmail,
  isValidEmail,
  baseUserIdFromEmail,
  nthUserIdCandidate,
  isReservedUserId,
  deriveUserId,
  RESERVED_USERNAMES,
} from "../userid.js";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Foo@Bar.COM ")).toBe("foo@bar.com");
  });
});

describe("isValidEmail", () => {
  it("accepts a normal address and rejects junk", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
  });
});

describe("baseUserIdFromEmail", () => {
  it("uses the slugified local-part", () => {
    expect(baseUserIdFromEmail("Robin.Banks@warp.test")).toBe("robin.banks");
  });
  it("strips characters Nextcloud forbids and collapses separators", () => {
    expect(baseUserIdFromEmail("a+b!!c@x.com")).toBe("a-b-c");
  });
  it("falls back to 'user' when the local-part is empty after stripping", () => {
    expect(baseUserIdFromEmail("+++@x.com")).toBe("user");
  });
});

describe("deriveUserId (pure, Set-backed isTaken)", () => {
  it("returns the base when free", () => {
    expect(deriveUserId("robin@x.com", () => false)).toBe("robin");
  });
  it("suffixes on collision", () => {
    const taken = new Set(["robin", "robin-2"]);
    expect(deriveUserId("robin@x.com", (c) => taken.has(c))).toBe("robin-3");
  });
  it("never returns a reserved id", () => {
    expect(deriveUserId("admin@x.com", () => false)).toBe("admin-2");
    expect(RESERVED_USERNAMES).toContain("admin");
  });
});

describe("nthUserIdCandidate / isReservedUserId", () => {
  it("n<=1 is the base; n>1 suffixes", () => {
    expect(nthUserIdCandidate("bob", 1)).toBe("bob");
    expect(nthUserIdCandidate("bob", 4)).toBe("bob-4");
  });
  it("flags reserved ids case-insensitively", () => {
    expect(isReservedUserId("ROOT")).toBe(true);
    expect(isReservedUserId("robin")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/auth-policy && npx vitest run userid`
Expected: FAIL — `Cannot find module '../userid.js'`.

- [ ] **Step 3: Write the implementation**

`packages/auth-policy/src/userid.ts`:
```ts
export const RESERVED_USERNAMES = ["admin", "root"];
export const USERID_MIN = 2;
export const USERID_MAX = 64;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Pragmatic client-side check; the orchestrator's Zod `.email()` is the
// authority. Mirrors the shape the backend accepts closely enough to drive
// the live checklist without false greens.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(normalizeEmail(email));
}

/** Slugify the email local-part into the conservative Nextcloud-safe charset. */
export function baseUserIdFromEmail(email: string): string {
  const local = normalizeEmail(email).split("@")[0] ?? "";
  let s = local
    .replace(/[^a-z0-9._-]+/g, "-") // drop @, +, unicode, etc.
    .replace(/[-_.]{2,}/g, "-") // collapse runs of separators
    .replace(/^[-_.]+|[-_.]+$/g, ""); // trim leading/trailing separators
  if (s.length < USERID_MIN) s = "user";
  if (s.length > USERID_MAX) s = s.slice(0, USERID_MAX);
  return s;
}

export function nthUserIdCandidate(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = `-${n}`;
  return base.slice(0, USERID_MAX - suffix.length) + suffix;
}

export function isReservedUserId(candidate: string): boolean {
  return RESERVED_USERNAMES.includes(candidate.toLowerCase());
}

/**
 * Pure derivation with a synchronous `isTaken` predicate — used in unit
 * tests and any in-memory caller. The orchestrator uses the building
 * blocks above with an async DB-backed loop (see auth.ts deriveUniqueUserId).
 */
export function deriveUserId(
  email: string,
  isTaken: (candidate: string) => boolean,
): string {
  const base = baseUserIdFromEmail(email);
  for (let n = 1; n < 100000; n += 1) {
    const candidate = nthUserIdCandidate(base, n);
    if (isReservedUserId(candidate)) continue;
    if (!isTaken(candidate)) return candidate;
  }
  // Unreachable in practice; satisfies the type checker.
  throw new Error("deriveUserId: exhausted candidate space");
}
```

- [ ] **Step 4: Write `password.zod.ts`** (so the barrel from Task 1 resolves)

`packages/auth-policy/src/password.zod.ts`:
```ts
import { z } from "zod";
import { validatePassword } from "./password.js";

/**
 * Zod schema enforcing the shared password policy. On failure it raises a
 * single issue with the literal message "WEAK_PASSWORD" and the failing rule
 * ids in `params.failed`, so a route can map the field error to a typed code.
 */
export const passwordZod = z.string().superRefine((pw, ctx) => {
  const { failed } = validatePassword(pw);
  if (failed.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "WEAK_PASSWORD",
      params: { failed },
    });
  }
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/auth-policy && npx vitest run`
Expected: PASS (all password + userid tests).

- [ ] **Step 6: Build the package** (prod `require` path needs `dist`)

Run: `cd packages/auth-policy && npx tsc`
Expected: exits 0; `dist/index.js` + `.d.ts` produced.

- [ ] **Step 7: Commit**
```bash
git add packages/auth-policy/src/userid.ts packages/auth-policy/src/password.zod.ts packages/auth-policy/src/__tests__/userid.test.ts
git commit -m "feat(auth-policy): email normalization + Nextcloud-safe userid derivation"
```

---

## Phase 2 — Backend (orchestrator)

### Task 4: Setup route — drop username, new password policy, derive userid, typed codes

**Files:**
- Modify: `apps/orchestrator/src/routes/auth.ts` (schema defs ~80–127; setup route ~318–428)
- Modify: `apps/orchestrator/src/routes/auth.directory-setup.test.ts`

- [ ] **Step 1: Update the existing setup tests first (they currently send `username`)**

In `apps/orchestrator/src/routes/auth.directory-setup.test.ts`, remove `username:` from every `.send({...})` payload (the route no longer accepts it) and update the Nextcloud-call assertion to expect the **derived** id. Specifically:

Replace the body in the "still provisions the Nextcloud admin downstream" test (currently lines ~231–242):
```ts
    const res = await request(app)
      .post("/api/auth/setup")
      .send({ password: "third-secret", email: "owner3@warp.test" });

    expect(res.status).toBe(200);
    // Username is derived from the email local-part ("owner3").
    expect(nc.ncInstallAndCreateAdmin).toHaveBeenCalledWith(
      "owner3",
      "third-secret",
      undefined,
    );
    expect(prisma._callOrder).toEqual(["user.upsert", "ncInstallAndCreateAdmin"]);
```

In every other `.send(...)` in this file, delete the `username: "..."` line and bump any weak password to a policy-compliant one: replace `"super-secret-pw"` → `"Super-secret-pw1"`, `"another-secret"` → `"Another-secret1"`, `"third-secret"` → `"Third-secret123"`, `"first-secret"` → `"First-secret123"`, `"takeover-attempt"` → `"Takeover-attempt1"`, `"no-email-secret"` → `"No-email-secret1"`. Update the matching `hashPassword` / `toHaveBeenCalledWith` assertions to the new plaintext where they appear (lines ~189, 195, 233, 236). Add this new test to the N2 describe block:
```ts
  it("rejects a setup whose password is below the policy with WEAK_PASSWORD", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/setup")
      .send({ email: "weak@warp.test", password: "short1A" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("WEAK_PASSWORD");
    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  it("derives a unique userid when the base is already taken", async () => {
    const prisma = createPrismaMock([
      { id: "u1", username: "owner", nextcloudUsername: "owner", email: "x@y.z", role: "family" },
    ]);
    // findUnique is used by deriveUniqueUserId via findFirst; extend the mock:
    prisma.user.findFirst = async ({ where }: any) => {
      const c = where.OR?.[0]?.username;
      return prisma._users.find((u: any) => u.username === c || u.nextcloudUsername === c) ?? null;
    };
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/setup")
      .send({ email: "owner@warp.test", password: "Owner-secret123" });
    expect(res.status).toBe(200);
    const created = prisma._users.find((u: any) => u.email === "owner@warp.test");
    expect(created.username).toBe("owner-2");
    expect(created.nextcloudUsername).toBe("owner-2");
  });
```
Also add `findFirst: vi.fn(async () => null),` to the `self.user = {...}` object in `createPrismaMock` (after `findUnique`) so the derivation loop has a default.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/orchestrator && npx vitest run src/routes/auth.directory-setup.test.ts`
Expected: FAIL — setup still requires `username`; `WEAK_PASSWORD` / derivation not implemented.

- [ ] **Step 3: Update imports + schemas in `auth.ts`**

Add the package import near the other `@droplet/*` imports at the top of `apps/orchestrator/src/routes/auth.ts`:
```ts
import {
  passwordZod,
  normalizeEmail,
  baseUserIdFromEmail,
  nthUserIdCandidate,
  isReservedUserId,
} from "@droplet/auth-policy";
```

Replace the `setupSchema` definition (currently lines ~115–127) with:
```ts
const setupSchema = z.object({
  password: passwordZod,
  displayName: z.string().min(1).max(128).optional(),
  // ADR-013: email is the directory login key and the sole user-facing
  // identifier. Username is derived server-side (deriveUniqueUserId).
  email: emailField,
});
```

- [ ] **Step 4: Add the async derivation helper** (place it just above `createPublicAuthRouter`, ~line 300)
```ts
/**
 * Derive a unique, Nextcloud-safe userid from an email. Walks suffix
 * candidates (base, base-2, base-3, …), skipping reserved ids and any value
 * already used as `username` OR `nextcloudUsername` (both are @unique).
 */
async function deriveUniqueUserId(
  prisma: import("@prisma/client").PrismaClient,
  email: string,
): Promise<string> {
  const base = baseUserIdFromEmail(email);
  for (let n = 1; n < 100000; n += 1) {
    const candidate = nthUserIdCandidate(base, n);
    if (isReservedUserId(candidate)) continue;
    const taken = await prisma.user.findFirst({
      where: { OR: [{ username: candidate }, { nextcloudUsername: candidate }] },
    });
    if (!taken) return candidate;
  }
  throw new Error("deriveUniqueUserId: exhausted candidate space");
}
```

- [ ] **Step 5: Update the setup route body** (currently ~319–428)

Replace the parse block + the `const { username, password, ... }` destructure (lines ~319–326) with:
```ts
      const parsed = setupSchema.safeParse(req.body);
      if (!parsed.success) {
        const fields = parsed.error.flatten().fieldErrors;
        if (fields.email) {
          res.status(400).json({ error: "Enter a valid email address.", code: "INVALID_EMAIL" });
          return;
        }
        if (fields.password) {
          res.status(400).json({
            error: "That password doesn't meet the requirements.",
            code: "WEAK_PASSWORD",
          });
          return;
        }
        res.status(400).json({ error: "Invalid request", code: "INVALID_REQUEST" });
        return;
      }

      const { password, displayName, email } = parsed.data;
```
Then keep the existing `if (!prisma) { ... }` guard and the N1 owner-count guard exactly as they are. **After** both guards (so `prisma` is known non-null and a duplicate owner has been rejected), and **just before** the `const passwordHash = await hashPassword(password);` line, insert:
```ts
      const username = await deriveUniqueUserId(prisma, email);
```
The existing `prisma.user.upsert({ where: { nextcloudUsername: username }, ... })` and `ncInstallAndCreateAdmin(username, password, displayName)` calls then use the derived `username` unchanged. (Ordering matters: deriving after the `!prisma` guard avoids a null-deref, and after the N1 guard avoids a wasted DB scan on a rejected re-setup.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/orchestrator && npx vitest run src/routes/auth.directory-setup.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**
```bash
git add apps/orchestrator/src/routes/auth.ts apps/orchestrator/src/routes/auth.directory-setup.test.ts
git commit -m "feat(orchestrator): setup derives userid from email, enforces password policy, typed 400s"
```

---

### Task 5: Admin add-user route — email-required, derive userid, policy

**Files:**
- Modify: `apps/orchestrator/src/routes/auth.ts` (`createUserSchema` ~159–163; the `POST /auth/users` handler — find via `grep -n "createUserSchema" apps/orchestrator/src/routes/auth.ts`)
- Modify: `apps/orchestrator/src/__tests__/auth.invites.test.ts` (only if it exercises add-user; otherwise add a focused test file)

- [ ] **Step 1: Write a failing test**

Create `apps/orchestrator/src/routes/auth.directory-adduser.test.ts` using the same harness as `auth.directory-setup.test.ts` (copy the `vi.mock` block, `createPrismaMock` with `findFirst`, and `buildApp`, but build the **authenticated** users router — find its factory with `grep -n "createAuthRouter\|/auth/users\b" apps/orchestrator/src/routes/auth.ts` and wire it the way `auth.invites.test.ts` does). Assert:
```ts
it("creates a user from email, derives the userid, enforces the password policy", async () => {
  // ...authenticated as owner...
  const weak = await request(app).post("/api/auth/users").send({ email: "kid@warp.test", password: "weak" });
  expect(weak.status).toBe(400);
  expect(weak.body.code).toBe("WEAK_PASSWORD");

  const ok = await request(app).post("/api/auth/users").send({ email: "kid@warp.test", password: "Kid-secret123" });
  expect(ok.status).toBe(200);
  expect(nc.ncCreateUser).toHaveBeenCalledWith(expect.anything(), "kid", "Kid-secret123", undefined, expect.anything());
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/orchestrator && npx vitest run src/routes/auth.directory-adduser.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update `createUserSchema` and the handler**

First read the current `createUserSchema` (`sed -n '159,166p' apps/orchestrator/src/routes/auth.ts`) to see its exact `role` field. Then replace it, **dropping `username`, making `email` required, swapping `password` for `passwordZod`, and preserving its existing `role` field verbatim** (do not invent one). For example, if it currently has `role: inviteRoleField.optional()`, keep that line as-is:
```ts
const createUserSchema = z.object({
  password: passwordZod,
  displayName: z.string().min(1).max(128).optional(),
  email: emailField,
  // <-- keep the EXISTING role field from the current schema, unchanged
});
```
In the `POST /auth/users` handler: apply the same parse→typed-code block as Task 4 Step 5, then — after any `!prisma`/auth guards and before the `ncCreateUser(...)` / local-row write — `const username = await deriveUniqueUserId(prisma, email);`. Keep the role/groups logic intact.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/orchestrator && npx vitest run src/routes/auth.directory-adduser.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/orchestrator/src/routes/auth.ts apps/orchestrator/src/routes/auth.directory-adduser.test.ts
git commit -m "feat(orchestrator): admin add-user creates from email with derived userid + password policy"
```

---

### Task 6: Invite create/accept — email-required, derive userid, policy

**Files:**
- Modify: `apps/orchestrator/src/routes/auth.ts` (`createInviteSchema` ~190–201; `acceptInviteSchema` ~203–205; create-invite handler; accept handler ~1024+)
- Modify: `apps/orchestrator/src/__tests__/auth.invites.test.ts`
- Modify: `apps/orchestrator/src/routes/auth.directory-invite-accept.test.ts`

- [ ] **Step 1: Update tests to the new contract**

In `auth.invites.test.ts`: the create-invite payloads must send `email` (now required) and **not** `username`; assert that the stored invite's `username` equals the derived value (e.g. invite for `email: "sam@warp.test"` → `username: "sam"`). In `auth.directory-invite-accept.test.ts`: bump accept passwords to policy-compliant (`"Accept-secret123"`) and add a case asserting a weak password → 400 `WEAK_PASSWORD`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/orchestrator && npx vitest run src/__tests__/auth.invites.test.ts src/routes/auth.directory-invite-accept.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update the schemas**

Replace `createInviteSchema` (lines ~190–201) with (drop `username`, make `email` required):
```ts
const createInviteSchema = z.object({
  displayName: z.string().min(1).max(128).optional(),
  // ADR-013: the invite email is the invitee's directory login key on
  // accept and the basis for the derived userid. Required.
  email: emailField,
  role: inviteRoleField.default("family"),
  ttlHours: z.number().int().min(1).max(720).optional(),
});
```
Replace `acceptInviteSchema` (lines ~203–205) with:
```ts
const acceptInviteSchema = z.object({
  password: passwordZod,
});
```

- [ ] **Step 4: Derive the username at invite-create time**

In the create-invite handler (find with `grep -n "createInviteSchema.safeParse" apps/orchestrator/src/routes/auth.ts`), after a successful parse and before persisting the invite row, add:
```ts
      const username = await deriveUniqueUserId(prisma, parsed.data.email);
```
and write `username` (+ `email`) onto the invite row where it currently expected `parsed.data.username`. Apply the Task 4 typed-code 400 block for the email/password fields.

- [ ] **Step 5: Update the accept handler's 400 copy**

In the accept handler (line ~1031), the manual 400 message is now policy-driven — replace:
```ts
      if (!parsed.success) {
        res.status(400).json({
          error: "That password doesn't meet the requirements.",
          code: "WEAK_PASSWORD",
        });
        return;
      }
```
Leave the rest of the accept handler (invite lookup, `usernameField` re-check on `invite.username`, `ncCreateUser(...)`) unchanged — `invite.username` is now the derived value.

- [ ] **Step 6: Run to verify they pass**

Run: `cd apps/orchestrator && npx vitest run src/__tests__/auth.invites.test.ts src/routes/auth.directory-invite-accept.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**
```bash
git add apps/orchestrator/src/routes/auth.ts apps/orchestrator/src/__tests__/auth.invites.test.ts apps/orchestrator/src/routes/auth.directory-invite-accept.test.ts
git commit -m "feat(orchestrator): invites require email, derive userid, enforce password policy on accept"
```

---

### Task 7: Login route — accept `email` as canonical field

**Files:**
- Modify: `apps/orchestrator/src/routes/auth.ts` (`loginSchema` ~131–159; login route already resolves by email)

The login route already resolves identity by email and already tolerates a legacy `username` field carrying the email value (line ~450). No behavior change is required — this task only confirms it.

- [ ] **Step 1: Add a regression test** to `apps/orchestrator/src/routes/auth.directory-login.test.ts`:
```ts
it("authenticates when the identifier is sent in the `email` field", async () => {
  // seed a user with email "owner@warp.test" + known hash (verifyPassword mocked true)
  // POST /api/auth/login { email: "owner@warp.test", password: "whatever" } → 200
});
```
(Model the seed/mocks on the existing tests in this file.)

- [ ] **Step 2: Run**

Run: `cd apps/orchestrator && npx vitest run src/routes/auth.directory-login.test.ts`
Expected: PASS (no code change needed; if it fails, the login route regressed and must be fixed).

- [ ] **Step 3: Commit**
```bash
git add apps/orchestrator/src/routes/auth.directory-login.test.ts
git commit -m "test(orchestrator): login resolves identity from the email field"
```

---

## Phase 3 — Frontend shared pieces

### Task 8: API client sends `email`

**Files:**
- Modify: `apps/web-dashboard/src/lib/api.ts` (`setupAdmin` ~132–146; `loginUser` ~373–387; `createUser` ~401–415)

- [ ] **Step 1: Update `setupAdmin`**

Replace (lines ~132–146):
```ts
export async function setupAdmin(
  email: string,
  password: string,
  displayName?: string
): Promise<void> {
  const res = await authFetch(`${BASE}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, displayName }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || "Setup failed") as Error & { code?: string };
    err.code = data.code;
    throw err;
  }
}
```

- [ ] **Step 2: Update `loginUser`** (param + body to `email`; keep the same return shape):
```ts
export async function loginUser(
  email: string,
  password: string
): Promise<{ user: AuthUser }> {
  const res = await authFetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Login failed");
  }
  return res.json();
}
```

- [ ] **Step 3: Update `createUser`** (param + body to `email`):
```ts
export async function createUser(
  email: string,
  password: string,
  displayName?: string
): Promise<void> {
  const res = await authFetch(`${BASE}/api/auth/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, displayName }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || "Failed to create user") as Error & { code?: string };
    err.code = data.code;
    throw err;
  }
}
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/web-dashboard && npx tsc --noEmit`
Expected: errors ONLY at the call sites of these functions (fixed in Phase 4). Note them; they are expected.

- [ ] **Step 5: Commit**
```bash
git add apps/web-dashboard/src/lib/api.ts
git commit -m "refactor(dashboard): setup/login/createUser send email as the identifier"
```

---

### Task 9: Friendly-error copy for the new codes

**Files:**
- Modify: `apps/web-dashboard/src/lib/friendly-errors.ts` (`auth` codes ~75–82; `invite` codes ~110–117)

- [ ] **Step 1: Add codes to the `auth` domain** (inside the `auth: { ... }` object):
```ts
    WEAK_PASSWORD:
      "That password doesn't meet the requirements. Use at least 12 characters with a mix of letters, numbers, and symbols.",
    INVALID_EMAIL:
      "That email address doesn't look right. Check it and try again.",
    INVALID_REQUEST:
      "Some of those details weren't valid. Check the form and try again.",
```

- [ ] **Step 2: Add `WEAK_PASSWORD` to the `invite` domain** (replace the existing `INVALID_PASSWORD` copy text to match the new policy and add the alias):
```ts
    INVALID_PASSWORD:
      "That password didn't meet the requirements. Use at least 12 characters with a mix of letters, numbers, and symbols.",
    WEAK_PASSWORD:
      "That password didn't meet the requirements. Use at least 12 characters with a mix of letters, numbers, and symbols.",
```

- [ ] **Step 3: Commit**
```bash
git add apps/web-dashboard/src/lib/friendly-errors.ts
git commit -m "feat(dashboard): friendly copy for WEAK_PASSWORD / INVALID_EMAIL"
```

---

### Task 10: `PasswordRulesChecklist` shared component (TDD)

**Files:**
- Create: `apps/web-dashboard/src/components/auth/PasswordRulesChecklist.tsx`
- Test: `apps/web-dashboard/src/__tests__/PasswordRulesChecklist.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/web-dashboard/src/__tests__/PasswordRulesChecklist.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PasswordRulesChecklist } from "@/components/auth/PasswordRulesChecklist";

describe("PasswordRulesChecklist", () => {
  it("marks length + classes satisfied for a strong password", () => {
    render(<PasswordRulesChecklist password="Abcdefghijk1" />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(screen.getByText(/Between 12 and 128/)).toBeInTheDocument();
  });

  it("shows a 'passwords match' row when confirm is provided", () => {
    render(<PasswordRulesChecklist password="Abcdefghijk1" confirm="Abcdefghijk1" />);
    expect(screen.getByText(/Passwords match/)).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("flags an unmet rule via aria text", () => {
    render(<PasswordRulesChecklist password="short" />);
    // "not satisfied" sr-only marker present for the failing length rule
    expect(screen.getAllByText(/not satisfied/i).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web-dashboard && npx vitest run src/__tests__/PasswordRulesChecklist.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Write the component**

`apps/web-dashboard/src/components/auth/PasswordRulesChecklist.tsx`:
```tsx
"use client";

import { Check, Circle } from "lucide-react";
import { PASSWORD_RULES } from "@droplet/auth-policy";

/**
 * Live password-requirements checklist. Each rule ticks green the moment
 * `validatePassword` would pass it. Pass `confirm` to add a "passwords
 * match" row. Rules come from @droplet/auth-policy — the same definitions
 * the orchestrator enforces, so the checklist can never drift from the API.
 */
export function PasswordRulesChecklist({
  password,
  confirm,
}: {
  password: string;
  confirm?: string;
}) {
  const rows = PASSWORD_RULES.map((r) => ({ label: r.label, ok: r.test(password) }));
  if (confirm !== undefined) {
    rows.push({
      label: "Passwords match",
      ok: password.length > 0 && password === confirm,
    });
  }
  return (
    <ul className="mt-2 space-y-1" aria-label="Password requirements">
      {rows.map((row) => (
        <li
          key={row.label}
          className={`flex items-center gap-2 type-caption-1 ${
            row.ok ? "text-system-green" : "text-label-quaternary"
          }`}
        >
          {row.ok ? (
            <Check size={13} aria-hidden="true" />
          ) : (
            <Circle size={13} aria-hidden="true" />
          )}
          <span>{row.label}</span>
          <span className="sr-only">{row.ok ? "satisfied" : "not satisfied"}</span>
        </li>
      ))}
    </ul>
  );
}
```
(If `text-system-green` is not a defined token, use `text-[color:var(--system-green,#34c759)]` or the project's success token — check `apps/web-dashboard/src/app/globals.css` / tailwind config for the exact name.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web-dashboard && npx vitest run src/__tests__/PasswordRulesChecklist.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/web-dashboard/src/components/auth/PasswordRulesChecklist.tsx apps/web-dashboard/src/__tests__/PasswordRulesChecklist.test.tsx
git commit -m "feat(dashboard): shared PasswordRulesChecklist driven by @droplet/auth-policy"
```

---

## Phase 4 — Frontend surfaces

### Task 11: AccountStep — email field + checklist, drop username

**Files:**
- Modify: `apps/web-dashboard/src/components/setup/steps/AccountStep.tsx`
- Modify: `apps/web-dashboard/src/__tests__/setup.flow.test.tsx` (and any setup test asserting `your-username` / `Min. 8 characters`)

- [ ] **Step 1: Update the failing setup tests first**

Run `grep -rln "your-username\|Min. 8 characters\|Username" apps/web-dashboard/src/__tests__` to find every assertion on the old copy. In each (notably `setup.flow.test.tsx`, `setup.e2e.test.tsx`), replace username interactions with an email field: query by label `Work email` / placeholder `you@company.com`, type a valid email, and use a policy-compliant password (`Abcdefghijk1`). Remove assertions on `your-username`. Add an assertion that `setupAdmin` is called with the email as the first arg.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web-dashboard && npx vitest run src/__tests__/setup.flow.test.tsx`
Expected: FAIL — AccountStep still renders username.

- [ ] **Step 3: Rewrite `AccountStep.tsx`**

Replace the whole file with (username state/validation removed; email + checklist added; CTA gated):
```tsx
"use client";

import { useState } from "react";
import { Eye, EyeOff, Lock, Mail } from "lucide-react";
import { setupAdmin, loginUser } from "@/lib/api";
import { StepShell } from "@/components/setup/StepShell";
import { PasswordRulesChecklist } from "@/components/auth/PasswordRulesChecklist";
import { translateError } from "@/lib/friendly-errors";
import { validatePassword, isValidEmail } from "@droplet/auth-policy";

/**
 * Create-owner step. ADR-013: the directory login key is the work email;
 * the username is derived server-side, so this form collects email +
 * display name + password only. A live PasswordRulesChecklist mirrors the
 * orchestrator's policy, and the CTA stays disabled until every rule passes.
 */
export function AccountStep({
  onComplete,
}: {
  onComplete: (displayName: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const emailOk = isValidEmail(email);
  const pwOk = validatePassword(password).ok;
  const matchOk = password.length > 0 && password === confirmPassword;
  const canSubmit = emailOk && pwOk && matchOk && !isSubmitting;

  async function handleCreateAccount() {
    setError(null);
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
      await setupAdmin(email, password, displayName || undefined);
      await loginUser(email, password); // auto-login for authed discovery steps
      onComplete(displayName);
    } catch (err: unknown) {
      setError(translateError(err, "auth"));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <StepShell
      current="account"
      title="Create your account"
      subtitle="This will be the administrator account for your Droplet."
      primary={{
        label: "Create Account",
        loadingLabel: "Creating account...",
        onClick: handleCreateAccount,
        isLoading: isSubmitting,
        disabled: !canSubmit,
      }}
    >
      <div className="space-y-4">
        <div>
          <label className="type-subheadline text-label-secondary block mb-1.5">
            Work email
          </label>
          <div className="relative">
            <Mail
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
            />
            <input
              type="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoComplete="username"
              className="dp-input pl-10"
              autoFocus
            />
          </div>
        </div>

        <div>
          <label className="type-subheadline text-label-secondary block mb-1.5">
            Display Name
          </label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your name (optional)"
            className="dp-input"
          />
        </div>

        <div>
          <label className="type-subheadline text-label-secondary block mb-1.5">
            Password
          </label>
          <div className="relative">
            <Lock
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
            />
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Create a password"
              autoComplete="new-password"
              className="dp-input pl-10 pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-label-tertiary hover:text-label-secondary"
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <div>
          <label className="type-subheadline text-label-secondary block mb-1.5">
            Confirm Password
          </label>
          <div className="relative">
            <Lock
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
            />
            <input
              type={showPassword ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repeat password"
              autoComplete="new-password"
              className="dp-input pl-10"
              onKeyDown={(e) => e.key === "Enter" && handleCreateAccount()}
            />
          </div>
        </div>

        <PasswordRulesChecklist password={password} confirm={confirmPassword} />

        {error && (
          <p className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
            {error}
          </p>
        )}
      </div>
    </StepShell>
  );
}
```
(If `StepShell`'s `primary` prop has no `disabled` field, add `disabled?: boolean` to its type and forward it to the button — check `apps/web-dashboard/src/components/setup/StepShell.tsx`.)

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/web-dashboard && npx vitest run src/__tests__/setup.flow.test.tsx src/__tests__/PasswordRulesChecklist.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/web-dashboard/src/components/setup/steps/AccountStep.tsx apps/web-dashboard/src/__tests__/setup.flow.test.tsx
git commit -m "feat(dashboard): setup AccountStep uses work email + live password checklist"
```

---

### Task 12: Invite-accept page — checklist + policy

**Files:**
- Modify: `apps/web-dashboard/src/app/invite/[token]/page.tsx`

- [ ] **Step 1: Read the file** to find the password/confirm inputs and the client-side `password.length < 8` guard.

Run: `grep -n "length < 8\|confirm\|password\|setError" apps/web-dashboard/src/app/invite/[token]/page.tsx`

- [ ] **Step 2: Replace the client guard + add the checklist**

- Add imports:
```tsx
import { PasswordRulesChecklist } from "@/components/auth/PasswordRulesChecklist";
import { validatePassword } from "@droplet/auth-policy";
```
- Replace the `if (password.length < 8) { setError("Password must be at least 8 characters."); return; }` guard with:
```tsx
    if (!validatePassword(password).ok) {
      setError("Password doesn't meet the requirements yet.");
      return;
    }
```
- Render `<PasswordRulesChecklist password={password} confirm={confirmPassword} />` directly below the confirm-password input (use the page's existing confirm state variable name).

- [ ] **Step 3: Typecheck + run any invite tests**

Run: `cd apps/web-dashboard && npx tsc --noEmit && npx vitest run src/__tests__/users.invite.test.tsx`
Expected: PASS (update the test if it asserts the old 8-char copy).

- [ ] **Step 4: Commit**
```bash
git add "apps/web-dashboard/src/app/invite/[token]/page.tsx"
git commit -m "feat(dashboard): invite-accept shows the live password checklist + new policy"
```

---

### Task 13: Settings password-change — checklist + policy

**Files:**
- Modify: `apps/web-dashboard/src/app/settings/page.tsx`

- [ ] **Step 1: Locate the password-change form**

Run: `grep -n "length < 8\|password\|setError\|Confirm" apps/web-dashboard/src/app/settings/page.tsx`

- [ ] **Step 2: Apply the same pattern as Task 12** — import `PasswordRulesChecklist` + `validatePassword`, replace the `length < 8` guard with `!validatePassword(password).ok`, and render `<PasswordRulesChecklist password={password} confirm={confirmPassword} />` under the confirm field (use the file's actual state names).

- [ ] **Step 3: Typecheck**

Run: `cd apps/web-dashboard && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**
```bash
git add apps/web-dashboard/src/app/settings/page.tsx
git commit -m "feat(dashboard): settings password change uses the shared policy + checklist"
```

---

### Task 14: Admin add-user + setup TeamStep — email-based invites

**Files:**
- Modify: `apps/web-dashboard/src/app/users/page.tsx`
- Modify: `apps/web-dashboard/src/components/setup/steps/TeamStep.tsx`
- Modify: `apps/web-dashboard/src/__tests__/users.invite.test.tsx`

- [ ] **Step 1: Update the add-user test** (`users.invite.test.tsx`) to enter an **email** (not username) and a policy-compliant password, and to assert the API is called with the email. Run `grep -n "username\|Username\|length < 8" apps/web-dashboard/src/__tests__/users.invite.test.tsx` to find what to change.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web-dashboard && npx vitest run src/__tests__/users.invite.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Update `users/page.tsx`** — in the add-user modal: remove the username input, replace it with an email input (label "Work email", `type=email`, placeholder `you@company.com`), replace the client `length < 8` guard with `!validatePassword(password).ok`, render `<PasswordRulesChecklist password={password} confirm={confirmPassword} />`, and call `createUser(email, password, displayName)`. Add imports for `PasswordRulesChecklist` and `validatePassword`. For the invite-create call (if present here), send `{ email, role }` (no username).

- [ ] **Step 4: Update `TeamStep.tsx`** — the setup-wizard invite form collects an **email** (required) per invitee instead of a username; send `email` to the create-invite API. Run `grep -n "username\|email\|invite" apps/web-dashboard/src/components/setup/steps/TeamStep.tsx` to find the fields, then swap username → email.

- [ ] **Step 5: Run to verify they pass**

Run: `cd apps/web-dashboard && npx vitest run src/__tests__/users.invite.test.tsx src/__tests__/setup.team.test.tsx`
Expected: PASS (update `setup.team.test.tsx` similarly if it asserts username copy).

- [ ] **Step 6: Commit**
```bash
git add apps/web-dashboard/src/app/users/page.tsx apps/web-dashboard/src/components/setup/steps/TeamStep.tsx apps/web-dashboard/src/__tests__/users.invite.test.tsx apps/web-dashboard/src/__tests__/setup.team.test.tsx
git commit -m "feat(dashboard): add-user + team invites are email-based with the shared checklist"
```

---

## Phase 5 — Full verification & e2e

### Task 15: Whole-repo verification + optional live e2e

- [ ] **Step 1: Build the shared package + typecheck both apps**

Run:
```bash
cd /Users/rjouffret/Projects/Droplet/droplet-onboard-services/.claude/worktrees/distracted-proskuriakova-d39fbe
(cd packages/auth-policy && npx tsc)
(cd apps/orchestrator && npx tsc --noEmit)
(cd apps/web-dashboard && npx tsc --noEmit)
```
Expected: all exit 0.

- [ ] **Step 2: Run all three test suites**

Run:
```bash
npm run test:orchestrator
npm run test:dashboard
(cd packages/auth-policy && npx vitest run)
```
Expected: all green. Fix any test that still references old username copy or the 8-char rule.

- [ ] **Step 3: Security lint** (this repo gates secrets/policy via a script)

Run: `npm run test:security`
Expected: PASS.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: PASS (fix any unused-import warnings from removed username code).

- [ ] **Step 5: Live e2e smoke (OPTIONAL — destructive; requires explicit approval)**

The appliance at `192.168.1.87` already has an owner row, so setup now correctly 409s there. A full clean-wizard run requires a factory reset. ONLY with the user's go-ahead:
```bash
# On the appliance (ssh droplet@192.168.1.87):
./scripts/factory-reset.sh
# then deploy this branch's build and walk the wizard in a browser:
#   - Setup: enter a work email + a 12+ char password (e.g. TestPass123!) → expect success
#   - Sign out, sign in with the SAME email + password → expect success
#   - Confirm the derived Nextcloud account exists
```
Expected: setup completes; sign-in with the email succeeds; no 400/500.

- [ ] **Step 6: Final commit (if any test fixes landed)**
```bash
git add -A
git commit -m "test(auth): align suites with email-identity + 12-char/3-class password policy"
```

---

## Notes for the implementer

- **Romain's test password `TestPass11!` (11 chars) now fails the min-12 rule.** Use `TestPass123!` (12 chars, 4 classes) for any manual/live testing.
- The orchestrator imports use `.js` extensions (NodeNext). Bare package specifiers (`@droplet/auth-policy`) need no extension; internal package imports (`./password.js`) do.
- Do **not** add any `MATTER_*` env var (unrelated, but a repo-wide footgun — see CLAUDE.md).
- If the Next `transpilePackages` route causes a dashboard build issue, the spec's Approach B fallback applies: keep `@droplet/auth-policy` for the orchestrator, re-declare `PASSWORD_RULES` locally in the dashboard, and add a test asserting the two arrays match. Behavior is identical.
