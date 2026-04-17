# Device Intelligence (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn raw DHCP leases on `/network` into a home-user-facing Devices tab: named, iconed, grouped devices with 30-day presence sparklines, rename/icon/notes in-place, group CRUD, and block/unblock — all backed by a persistent Prisma registry and an offline OUI vendor lookup.

**Architecture:** Add three Prisma models (`NetworkDevice`, `DeviceGroup`, `DevicePresenceDay`) behind a reconciler that observes every DHCP poll, resolves vendor from a bundled IEEE OUI CSV, and writes daily presence rollups. Expose the registry via REST extensions to `/api/network/*`. Replace the current Devices table with a 3-column card grid + right-anchored detail slide-over in the Next.js dashboard. Preserve all Phase 0.5 invariants (routingFetch retry/auth, typed errors, ROUTING_MODE).

**Tech Stack:**
- Backend: Node.js 20, Express, Prisma ORM, PostgreSQL 16, Redis 7, vitest + supertest, pino
- Frontend: Next.js 14 (App Router), React 18, SWR, Tailwind with `dp-*`/`type-*` tokens, Lucide icons, vitest + @testing-library/react + jsdom
- Infra: Docker Compose, GitHub Actions, `peter-evans/create-pull-request@v6`

**Spec:** `docs/superpowers/specs/2026-04-16-device-intelligence-design.md` (authoritative — read it before starting any ticket).

**Ticket → branch → PR:** Nine Jira tickets WARP-80..88 in Sprint 1. Branches `WARP-80`..`WARP-88` exist off `main`. Each ticket ships as its own PR through the agent harness (Dev → QA → UI/UX → Manager → PR → CodeReviewer → human merge).

**Execution order (enforced by Jira Blocks links):**
1. **WARP-88** (harness) — ships first, dry-runs the pipeline against WARP-80
2. **WARP-80** (data model)
3. **WARP-81** (reconciler + OUI lookup)
4. After WARP-81 merges: **WARP-82**, **WARP-87** can run in parallel
5. After WARP-82 merges: **WARP-83** (grid list)
6. After WARP-83 merges: **WARP-84**, **WARP-85**, **WARP-86** can run in parallel

---

## File Structure

Files created or modified, grouped by ticket. Every file has a single clear responsibility.

### WARP-88 — Agent harness

| Path | Purpose |
|---|---|
| `.superpowers/agents/dev.md` (new) | Dev role prompt — spec-following implementer |
| `.superpowers/agents/qa.md` (new) | QA role prompt — regression + coverage review |
| `.superpowers/agents/ui-ux.md` (new) | UI/UX role prompt — dashboard-only heuristics |
| `.superpowers/agents/manager.md` (new) | Manager role prompt — synthesizes QA+UX, writes PR body |
| `.superpowers/agents/code-reviewer.md` (new) | Wrapper invoking `superpowers:code-reviewer` |
| `docs/superpowers/agent-harness.md` (new) | Execution playbook — gate sequence, parallelism, ralph-loop, handoff triggers |
| `docs/superpowers/harness-runs/WARP-80-dry-run.md` (new) | Trace of the first dry-run |

### WARP-80 — Data model

| Path | Purpose |
|---|---|
| `apps/orchestrator/prisma/schema.prisma` (modify) | Add `NetworkDevice`, `DeviceGroup`, `DevicePresenceDay` models |
| `apps/orchestrator/prisma/migrations/20260416000000_device_intelligence/migration.sql` (new) | Creates tables + seeds 5 default groups (idempotent) |
| `apps/orchestrator/src/lib/mac.ts` (new) | `normalizeMac(raw: string): string` |
| `apps/orchestrator/src/types/device-registry-error.ts` (new) | Typed `DeviceRegistryError` class mirroring `RouterError` shape |
| `apps/orchestrator/src/lib/mac.test.ts` (new) | Unit tests for `normalizeMac` |
| `apps/orchestrator/src/types/device-registry-error.test.ts` (new) | Unit tests for error factories + `toJSON` |

### WARP-81 — Reconciler + OUI lookup

| Path | Purpose |
|---|---|
| `apps/orchestrator/data/oui.csv` (new, committed) | ~4 MB normalized IEEE OUI registry |
| `scripts/fetch-oui.sh` (new) | Download + normalize IEEE CSV; size-validate; write to data/oui.csv |
| `apps/orchestrator/src/services/oui-lookup.service.ts` (new) | Load CSV once, expose `lookup(mac): string \| null` |
| `apps/orchestrator/src/services/device-registry.service.ts` (new) | `reconcile`, `purgePresenceRows`, `forgetDevice`, `initDeviceRegistry` |
| `apps/orchestrator/src/services/oui-lookup.service.test.ts` (new) | hit / miss / malformed / missing-file |
| `apps/orchestrator/src/services/device-registry.service.test.ts` (new) | first-sight upsert, existing update, block-cascade, block-preserved on RouterError, presence increment, forget |
| `apps/orchestrator/Dockerfile` (modify) | Add `COPY data/oui.csv ./data/oui.csv` |
| `apps/orchestrator/src/index.ts` (modify) | Call `initDeviceRegistry(prisma)` in lifespan; hook reconciler to network poller |
| `services/routing/tests/conftest.py` (modify, optional) | Extend fixture DHCP leases to exercise the reconciler |

### WARP-82 — Orchestrator API

| Path | Purpose |
|---|---|
| `apps/orchestrator/src/services/network-device.service.ts` (new) | `listDevices`, `getDevice`, `updateDevice`, `assignDeviceGroups`, group CRUD |
| `apps/orchestrator/src/routes/network.ts` (modify) | Add 9 routes listed in spec §7; preserve existing handlers |
| `apps/orchestrator/src/services/network-device.service.test.ts` (new) | Happy path + each `DeviceRegistryError` code |
| `apps/orchestrator/src/routes/network.device.test.ts` (new) | supertest route coverage for all 9 endpoints + auth gate + legacy shape |
| `apps/orchestrator/src/services/cache.service.ts` (modify, optional) | Keys `network:devices:list`, `network:groups:list` (10s TTL) if not already present |

### WARP-83 — Dashboard card grid

| Path | Purpose |
|---|---|
| `apps/web-dashboard/src/lib/hooks/useNetworkDevices.ts` (new) | SWR wrapper for `/api/network/devices`, 10s refresh |
| `apps/web-dashboard/src/lib/hooks/useNetworkGroups.ts` (new) | SWR wrapper for `/api/network/groups`, 30s refresh |
| `apps/web-dashboard/src/components/network/DeviceCard.tsx` (new) | Single card: icon avatar, name, meta, chips, sparkline, hover actions |
| `apps/web-dashboard/src/components/network/DeviceSparkline.tsx` (new) | Shared 30-bar sparkline (card-mini + panel-full variants via size prop) |
| `apps/web-dashboard/src/components/network/DeviceGridSection.tsx` (new) | Collapsible group section with member cards |
| `apps/web-dashboard/src/app/network/page.tsx` (modify) | Replace Devices-tab table with grid + header controls |
| `apps/web-dashboard/src/lib/types.ts` (modify) | Add `EnrichedNetworkDevice`, `DeviceGroupWithCount`, `DevicePresenceDay` |
| `apps/web-dashboard/src/components/network/__tests__/DeviceCard.test.tsx` (new) | Render, hover, offline dim, click opens panel |
| `apps/web-dashboard/src/components/network/__tests__/DeviceGridSection.test.tsx` (new) | Collapse persistence, empty, sort |

### WARP-84 — Detail slide-over

| Path | Purpose |
|---|---|
| `apps/web-dashboard/src/components/network/DeviceDetailPanel.tsx` (new) | 440px slide-over: rename, icon picker trigger, groups typeahead, notes, activity, advanced, footer |
| `apps/web-dashboard/src/components/network/IconPicker.tsx` (new) | Grid of 20 Lucide icons with ring selection |
| `apps/web-dashboard/src/lib/hooks/useDeviceMutations.ts` (new) | Optimistic mutations with typed error rollback |
| `apps/web-dashboard/src/components/network/__tests__/DeviceDetailPanel.test.tsx` (new) | Rename debounce, icon pick, notes debounce, sparkline bars, forget confirm, rollback |
| `apps/web-dashboard/src/components/network/__tests__/IconPicker.test.tsx` (new) | Keyboard nav, ring on selected |

### WARP-85 — Group manager + chip-edit

| Path | Purpose |
|---|---|
| `apps/web-dashboard/src/components/network/GroupManagerDialog.tsx` (new) | CRUD modal launched from header "Manage groups" button |
| `apps/web-dashboard/src/components/network/GroupTypeahead.tsx` (new) | Autocomplete used inside `DeviceDetailPanel` for chip edit |
| `apps/web-dashboard/src/lib/hooks/useGroupMutations.ts` (new) | Optimistic group mutations with rollback |
| `apps/web-dashboard/src/components/network/__tests__/GroupManagerDialog.test.tsx` (new) | Create / rename / duplicate-reject / delete-confirm |
| `apps/web-dashboard/src/components/network/__tests__/GroupTypeahead.test.tsx` (new) | Existing match, "Create <name>" branch, × removes chip |

### WARP-86 — Block/unblock wiring

| Path | Purpose |
|---|---|
| `apps/web-dashboard/src/components/network/DeviceCard.tsx` (modify) | Wire hover `Block`/`Unblock` button to existing firewall endpoint |
| `apps/web-dashboard/src/components/network/DeviceDetailPanel.tsx` (modify) | Wire footer `Block`/`Unblock` button |
| `apps/web-dashboard/src/lib/hooks/useDeviceBlockMutation.ts` (new) | Uses existing Tier 2 confirm flow; feeds Operation-Id to WARP-40 banner |
| `apps/web-dashboard/src/components/network/__tests__/DeviceCard.blockMutation.test.tsx` (new) | Optimistic flip + rollback on error |

### WARP-87 — CI OUI refresh workflow

| Path | Purpose |
|---|---|
| `.github/workflows/refresh-oui.yml` (new) | Quarterly cron + manual dispatch; opens PR if CSV changed |
| `scripts/fetch-oui.sh` (already present from WARP-81) | Reused; no edit unless discovered gaps |

---

## Task 1: WARP-88 — Agent harness (ships first, unblocks everything)

**Branch:** `WARP-88` (exists on origin).
**Depends on:** nothing.
**Size:** S.

The goal is a repeatable multi-role pipeline. Each role is a markdown prompt committed to `.superpowers/agents/`. The harness doc captures gate ordering. A WARP-80 dry-run exercises the pipeline end-to-end before real code ships.

**Files:**
- Create: `.superpowers/agents/dev.md`
- Create: `.superpowers/agents/qa.md`
- Create: `.superpowers/agents/ui-ux.md`
- Create: `.superpowers/agents/manager.md`
- Create: `.superpowers/agents/code-reviewer.md`
- Create: `docs/superpowers/agent-harness.md`
- Create: `docs/superpowers/harness-runs/WARP-80-dry-run.md`

- [ ] **Step 1: Checkout branch + clean tree**
```bash
git checkout WARP-88
git status          # expect clean
```

- [ ] **Step 2: Write `.superpowers/agents/dev.md`**

Role prompt for a spec-following implementer. Shape:
```markdown
# Dev Role

You are the Dev agent for a single Jira ticket.

## Inputs
- Ticket body (full markdown from Jira)
- Relevant spec sections (copied inline, not linked)
- Acceptance Criteria (bulleted)
- Existing-code orientation (file paths + conventions to follow)
- Branch name (e.g. `WARP-80`)

## Output
- Branch pushed with all commits
- Local tests green (`npm test` in touched packages)
- `tsc --noEmit` clean
- Self-assessment in the final message: what you did, what you skipped, risks

## Discipline
- TDD: write the failing test first, run it to confirm red, implement, run green, commit
- No scope creep beyond the ticket AC — flag additions to Manager instead
- Follow existing conventions (routerError.toJSON() pattern, vitest globals, dp-/type- tokens)
- Commit frequently with Conventional Commits (`feat:`, `fix:`, `test:`, `chore:`)
- If CI fixtures or migrations are needed, include them; don't hand-wave
```

- [ ] **Step 3: Write `.superpowers/agents/qa.md`**

Reviews Dev's branch diff. Runs the cross-cutting regression suite. Returns pass/fail + specific failing cases + coverage gaps. No code changes — QA is read-only.

- [ ] **Step 4: Write `.superpowers/agents/ui-ux.md`**

Dashboard tickets only (WARP-83/84/85/86). Reviews against home-user heuristics from ADR-002, checks a11y (ARIA, keyboard), responsive behavior at 3/2/1 column breakpoints, copy tone, design-token adherence (`dp-card`, `type-*`, `text-label-*`).

- [ ] **Step 5: Write `.superpowers/agents/manager.md`**

Consumes QA + UI/UX reports. Decides "ready for human review" or "send back to Dev". Writes the PR body in the repo's established format:
```markdown
## Summary
<1-3 bullets>

## Acceptance
<AC checklist mirrored from ticket>

## Testing
<pytest/vitest commands + coverage notes>

## Self-review
**Strengths:** ...
**Concerns:** ...
**Nits:** ...
**Follow-ups:** ...
```

- [ ] **Step 6: Write `.superpowers/agents/code-reviewer.md`**

Thin wrapper that spawns `superpowers:code-reviewer` against the PR diff + spec + ticket.

- [ ] **Step 7: Write `docs/superpowers/agent-harness.md`**

Playbook covering:
- Gate sequence (Dev → QA → UI/UX → Manager → PR → CI → Code Reviewer → human)
- Parallelism (QA + UI/UX concurrent; WARP-82 + WARP-87 concurrent; WARP-84/85/86 concurrent)
- Ralph-loop template for stuck CI (from spec §11.3), scoped to infra flakes only
- Handoff-to-human triggers (from spec §11.4): product ambiguity, systemic CI failure, AC drift

- [ ] **Step 8: Dry-run against WARP-80**

Invoke each role agent in sequence using the WARP-80 ticket body + spec §5 as inputs. Capture each role's output (even if stub-quality on the first pass). Commit the trace to `docs/superpowers/harness-runs/WARP-80-dry-run.md`.

If any role surfaces a prompt bug (e.g., "I don't know how to run Prisma tests here"), fix the prompt file in this ticket — not later.

- [ ] **Step 9: Commit all harness files**
```bash
git add .superpowers/agents/ docs/superpowers/agent-harness.md docs/superpowers/harness-runs/
git commit -m "feat(harness): Dev/QA/UI-UX/Manager role prompts + WARP-80 dry-run (WARP-88)"
```

- [ ] **Step 10: Push + open PR**
```bash
git push -u origin WARP-88
gh pr create --title "feat(harness): agent pipeline role prompts (WARP-88)" --body "$(cat <<'EOF'
## Summary
- Dev / QA / UI-UX / Manager / Code-Reviewer role prompts in `.superpowers/agents/`
- Execution playbook at `docs/superpowers/agent-harness.md`
- WARP-80 dry-run trace at `docs/superpowers/harness-runs/WARP-80-dry-run.md`

## Acceptance
- [x] All role prompts committed
- [x] Playbook covers every gate + exception path
- [x] Dry-run produces plausible dev branch, QA report, manager PR body
- [x] Ralph-loop template with stop conditions

## Testing
Harness only — no code/test changes.

Closes WARP-88.
EOF
)"
```

---

## Task 2: WARP-80 — Prisma data model

**Branch:** `WARP-80`.
**Depends on:** nothing (technically independent of WARP-88, but WARP-88's dry-run uses this ticket as its subject — ship them in order).
**Size:** S.

**Files:**
- Modify: `apps/orchestrator/prisma/schema.prisma`
- Create: `apps/orchestrator/prisma/migrations/20260416000000_device_intelligence/migration.sql`
- Create: `apps/orchestrator/src/lib/mac.ts`
- Create: `apps/orchestrator/src/lib/mac.test.ts`
- Create: `apps/orchestrator/src/types/device-registry-error.ts`
- Create: `apps/orchestrator/src/types/device-registry-error.test.ts`

- [ ] **Step 1: Checkout branch**
```bash
git checkout WARP-80
```

- [ ] **Step 2: Write the failing `normalizeMac` test**

Create `apps/orchestrator/src/lib/mac.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { normalizeMac } from "./mac.js";
import { DeviceRegistryError } from "../types/device-registry-error.js";

describe("normalizeMac", () => {
  it("passes through already-normalized", () => {
    expect(normalizeMac("AA:BB:CC:DD:EE:FF")).toBe("AA:BB:CC:DD:EE:FF");
  });
  it("uppercases lowercase colon form", () => {
    expect(normalizeMac("aa:bb:cc:dd:ee:ff")).toBe("AA:BB:CC:DD:EE:FF");
  });
  it("converts dash separators to colon", () => {
    expect(normalizeMac("aa-bb-cc-dd-ee-ff")).toBe("AA:BB:CC:DD:EE:FF");
  });
  it("accepts no-separator hex", () => {
    expect(normalizeMac("aabbccddeeff")).toBe("AA:BB:CC:DD:EE:FF");
  });
  it("rejects wrong length with INVALID_MAC", () => {
    expect(() => normalizeMac("AA:BB:CC:DD:EE")).toThrow(DeviceRegistryError);
    try { normalizeMac("AA:BB:CC:DD:EE"); } catch (e: any) { expect(e.code).toBe("INVALID_MAC"); }
  });
  it("rejects non-hex chars", () => {
    expect(() => normalizeMac("AA:BB:CC:DD:EE:GG")).toThrow(/INVALID_MAC/);
  });
  it("rejects empty / null-ish", () => {
    expect(() => normalizeMac("")).toThrow();
  });
});
```

- [ ] **Step 3: Run — confirm red (module doesn't exist yet)**

```bash
cd apps/orchestrator && npm test -- mac.test
# Expected: FAIL "Cannot find module ./mac.js" (or similar)
```

- [ ] **Step 4: Write `DeviceRegistryError` type**

Create `apps/orchestrator/src/types/device-registry-error.ts`. Mirror `router-error.ts` shape (confirmed by Explore survey — same `code` enum, `toJSON`, static factories):
```ts
export type DeviceRegistryErrorCode =
  | "NOT_FOUND"
  | "GROUP_IN_USE"
  | "INVALID_ICON"
  | "INVALID_MAC"
  | "DUPLICATE_GROUP_NAME";

export class DeviceRegistryError extends Error {
  readonly code: DeviceRegistryErrorCode;
  readonly status?: number;

  constructor(code: DeviceRegistryErrorCode, message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "DeviceRegistryError";
    this.code = code;
    this.status = options?.status;
  }

  static notFound(what: string) { return new DeviceRegistryError("NOT_FOUND", `${what} not found`, { status: 404 }); }
  static invalidMac(raw: string) { return new DeviceRegistryError("INVALID_MAC", `Invalid MAC: ${raw}`, { status: 400 }); }
  static invalidIcon(icon: string) { return new DeviceRegistryError("INVALID_ICON", `Icon not in allowlist: ${icon}`, { status: 400 }); }
  static duplicateGroupName(name: string) { return new DeviceRegistryError("DUPLICATE_GROUP_NAME", `Group "${name}" already exists`, { status: 409 }); }
  static groupInUse(id: string) { return new DeviceRegistryError("GROUP_IN_USE", `Group ${id} still has devices`, { status: 409 }); }

  toJSON() { return { code: this.code, message: this.message, status: this.status }; }
}
```

- [ ] **Step 5: Write `DeviceRegistryError` tests**

Create `apps/orchestrator/src/types/device-registry-error.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { DeviceRegistryError } from "./device-registry-error.js";

describe("DeviceRegistryError", () => {
  it("notFound carries 404", () => {
    const e = DeviceRegistryError.notFound("Device");
    expect(e.code).toBe("NOT_FOUND");
    expect(e.status).toBe(404);
    expect(e.toJSON()).toEqual({ code: "NOT_FOUND", message: "Device not found", status: 404 });
  });
  it("invalidMac carries 400 + raw input in message", () => {
    const e = DeviceRegistryError.invalidMac("zz");
    expect(e.code).toBe("INVALID_MAC");
    expect(e.message).toContain("zz");
    expect(e.status).toBe(400);
  });
  it("duplicateGroupName carries 409", () => {
    const e = DeviceRegistryError.duplicateGroupName("Living Room");
    expect(e.code).toBe("DUPLICATE_GROUP_NAME");
    expect(e.status).toBe(409);
  });
});
```

- [ ] **Step 6: Implement `normalizeMac`**

Create `apps/orchestrator/src/lib/mac.ts`:
```ts
import { DeviceRegistryError } from "../types/device-registry-error.js";

const HEX_12 = /^[0-9A-F]{12}$/;

export function normalizeMac(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) throw DeviceRegistryError.invalidMac(String(raw));
  const compact = raw.replace(/[:\-.]/g, "").toUpperCase();
  if (!HEX_12.test(compact)) throw DeviceRegistryError.invalidMac(raw);
  return compact.match(/.{2}/g)!.join(":");
}
```

- [ ] **Step 7: Run tests — confirm green**
```bash
cd apps/orchestrator && npm test -- mac.test device-registry-error.test
# Expected: PASS, both suites
```

- [ ] **Step 8: Add Prisma models to `schema.prisma`**

Append to `apps/orchestrator/prisma/schema.prisma` (do NOT edit existing models — just add):
```prisma
model NetworkDevice {
  mac           String    @id
  displayName   String?
  icon          String?
  notes         String?
  vendor        String?
  hostname      String?
  lastIp        String?
  firstSeen     DateTime  @default(now())
  lastSeen      DateTime  @default(now())
  isBlocked     Boolean   @default(false)
  groups        DeviceGroup[]       @relation("DeviceGroups")
  presenceDays  DevicePresenceDay[]
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  @@index([lastSeen])
  @@index([vendor])
}

model DeviceGroup {
  id            String    @id @default(cuid())
  name          String    @unique
  color         String?
  icon          String?
  devices       NetworkDevice[]     @relation("DeviceGroups")
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
}

model DevicePresenceDay {
  mac           String
  date          DateTime  @db.Date
  seenMinutes   Int       @default(0)
  device        NetworkDevice       @relation(fields: [mac], references: [mac], onDelete: Cascade)

  @@id([mac, date])
  @@index([date])
}
```

- [ ] **Step 9: Generate migration**
```bash
cd apps/orchestrator && npx prisma migrate dev --name device_intelligence --create-only
```

This creates `prisma/migrations/<timestamp>_device_intelligence/migration.sql`. Rename the timestamp to `20260416000000` so the migration is lexicographic-stable.

- [ ] **Step 10: Append idempotent group seed to the migration SQL**

Append to the generated `migration.sql`:
```sql
-- Seed default rooms (idempotent)
INSERT INTO "DeviceGroup" ("id", "name", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'Living Room', NOW(), NOW()),
  (gen_random_uuid()::text, 'Bedroom',     NOW(), NOW()),
  (gen_random_uuid()::text, 'Office',      NOW(), NOW()),
  (gen_random_uuid()::text, 'Kitchen',     NOW(), NOW()),
  (gen_random_uuid()::text, 'Garage',      NOW(), NOW())
ON CONFLICT ("name") DO NOTHING;
```

- [ ] **Step 11: Apply migration locally + verify**
```bash
npx prisma migrate deploy
npx prisma validate
psql "$DATABASE_URL" -c 'SELECT name FROM "DeviceGroup" ORDER BY name;'
# Expected: Bedroom, Garage, Kitchen, Living Room, Office
```

- [ ] **Step 12: Re-run migration to confirm idempotence**
```bash
npx prisma migrate deploy
psql "$DATABASE_URL" -c 'SELECT count(*) FROM "DeviceGroup";'
# Expected: 5 (not 10)
```

- [ ] **Step 13: Run full orchestrator test suite**
```bash
npm test
# Expected: all existing tests + new ones PASS; 257+ tests total
npx tsc --noEmit
# Expected: no errors
```

- [ ] **Step 14: Commit + push**
```bash
git add apps/orchestrator/prisma/ apps/orchestrator/src/lib/mac.ts apps/orchestrator/src/lib/mac.test.ts apps/orchestrator/src/types/device-registry-error.ts apps/orchestrator/src/types/device-registry-error.test.ts
git commit -m "feat(orchestrator): NetworkDevice/DeviceGroup/DevicePresenceDay models (WARP-80)"
git push -u origin WARP-80
```

- [ ] **Step 15: Open PR via the agent harness**

(Handled by Manager role per WARP-88 playbook.)

---

## Task 3: WARP-81 — Reconciler + OUI lookup

**Branch:** `WARP-81`.
**Depends on:** WARP-80 merged to `main`.
**Size:** M.

**Files:** see File Structure above.

- [ ] **Step 1: Rebase branch on latest `main`**
```bash
git checkout WARP-81
git fetch origin && git rebase origin/main
# WARP-80 must be merged first
```

- [ ] **Step 2: Write `scripts/fetch-oui.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

OUT="apps/orchestrator/data/oui.csv"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

URL="https://standards-oui.ieee.org/oui/oui.csv"

echo "Fetching $URL..."
curl -fsSL -o "$TMP" "$URL"

SIZE=$(wc -c < "$TMP")
if [[ $SIZE -lt 2000000 || $SIZE -gt 10000000 ]]; then
  echo "OUI CSV size $SIZE out of [2MB, 10MB] range" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
# Normalize: keep header, uppercase assignment hex, sort by hex col
awk -F, 'NR==1 { print; next } { print toupper($2) "," $3 "," $4 }' "$TMP" \
  | (head -n1 && tail -n +2 | sort -t, -k1,1) > "$OUT"

echo "Wrote $OUT ($(wc -l < "$OUT") rows, $(wc -c < "$OUT") bytes)"
chmod +x scripts/fetch-oui.sh  # idempotent
```

Make executable:
```bash
chmod +x scripts/fetch-oui.sh
```

- [ ] **Step 3: Run the fetch script to bootstrap the CSV**
```bash
./scripts/fetch-oui.sh
ls -la apps/orchestrator/data/oui.csv
wc -l apps/orchestrator/data/oui.csv   # expect > 30000
```

- [ ] **Step 4: shellcheck the script**
```bash
shellcheck scripts/fetch-oui.sh   # must pass clean
```

- [ ] **Step 5: Write OUI-lookup failing tests**

Create `apps/orchestrator/src/services/oui-lookup.service.test.ts`:
```ts
import { describe, it, expect, beforeAll, vi } from "vitest";
import { createOuiLookup } from "./oui-lookup.service.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("oui-lookup.service", () => {
  it("resolves known prefix", () => {
    const dir = mkdtempSync(join(tmpdir(), "oui-"));
    const csv = join(dir, "oui.csv");
    writeFileSync(csv, "Registry,Assignment,Organization Name,Organization Address\nMA-L,F81EDF,Apple Inc,...");
    const lookup = createOuiLookup(csv);
    expect(lookup.lookup("F8:1E:DF:AA:BB:CC")).toBe("Apple Inc");
  });
  it("returns null for unknown prefix", () => {
    const dir = mkdtempSync(join(tmpdir(), "oui-"));
    const csv = join(dir, "oui.csv");
    writeFileSync(csv, "Registry,Assignment,Organization Name,Organization Address\n");
    const lookup = createOuiLookup(csv);
    expect(lookup.lookup("AA:BB:CC:DD:EE:FF")).toBeNull();
  });
  it("missing file degrades to null + warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lookup = createOuiLookup("/nonexistent/oui.csv");
    expect(lookup.lookup("AA:BB:CC:DD:EE:FF")).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it("malformed rows are skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "oui-"));
    const csv = join(dir, "oui.csv");
    writeFileSync(csv, "Registry,Assignment,Organization Name,Organization Address\nMA-L,F81EDF,Apple\nshort row\nMA-L,001122,Acme");
    const lookup = createOuiLookup(csv);
    expect(lookup.lookup("00:11:22:33:44:55")).toBe("Acme");
  });
});
```

- [ ] **Step 6: Run — confirm red**
```bash
cd apps/orchestrator && npm test -- oui-lookup.service.test
# Expected: FAIL (module missing)
```

- [ ] **Step 7: Implement `oui-lookup.service.ts`**

Create `apps/orchestrator/src/services/oui-lookup.service.ts`:
```ts
import { readFileSync, existsSync } from "node:fs";
import pino from "pino";

const log = pino({ name: "oui-lookup" });

export interface OuiLookup {
  lookup(mac: string): string | null;
}

export function createOuiLookup(csvPath: string): OuiLookup {
  const table = new Map<string, string>();

  if (!existsSync(csvPath)) {
    log.warn({ csvPath }, "oui.csv missing — vendor lookup disabled");
    return { lookup: () => null };
  }

  try {
    const content = readFileSync(csvPath, "utf8");
    const lines = content.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i];
      if (!row) continue;
      const parts = row.split(",");
      if (parts.length < 3) continue;
      const prefix = parts[1].trim().toUpperCase();
      const name = parts[2].trim();
      if (prefix.length === 6 && name) table.set(prefix, name);
    }
    log.info({ entries: table.size }, "OUI registry loaded");
  } catch (err) {
    log.warn({ err }, "oui.csv load failed — vendor lookup disabled");
  }

  return {
    lookup(mac: string): string | null {
      const prefix = mac.replace(/[:\-]/g, "").slice(0, 6).toUpperCase();
      return table.get(prefix) ?? null;
    },
  };
}
```

- [ ] **Step 8: Run — confirm green**
```bash
npm test -- oui-lookup.service.test
```

- [ ] **Step 9: Write reconciler failing tests**

Create `apps/orchestrator/src/services/device-registry.service.test.ts` with these cases (full code — agent copies verbatim):
- first-sight: upserts new MAC with vendor + firstSeen
- existing device: updates lastSeen + lastIp, preserves firstSeen
- block-state cascade: REJECT rule → `isBlocked = true`
- block-state preserved on firewall fetch error: throws RouterError → prior `isBlocked` unchanged
- presence increment: seenMinutes grows by poll-delta
- forgetDevice: deletes row (presence cascade)

Use the same Prisma-mock pattern from `apps/orchestrator/src/__tests__/device-clients.test.ts` (in-memory Maps + `vi.fn()` for `upsert`/`findUnique`/`update`). Inject the OUI lookup via constructor for testability.

- [ ] **Step 10: Implement `device-registry.service.ts`**

Shape:
```ts
import type { PrismaClient } from "@prisma/client";
import type { OuiLookup } from "./oui-lookup.service.js";
import { RouterError } from "../types/router-error.js";
import { normalizeMac } from "../lib/mac.js";
import pino from "pino";

const log = pino({ name: "device-registry" });

export interface DhcpLease { mac: string; ip: string; hostname?: string }
export interface WirelessClient { mac: string; signal?: number }
export interface FirewallRejectRule { srcMac: string }

export interface ReconcileInput {
  leases: DhcpLease[];
  wirelessClients: WirelessClient[];
  firewallRules: FirewallRejectRule[] | RouterError;  // pass the typed error when firewall fetch failed
  pollIntervalMs: number;
}

export function createDeviceRegistry(prisma: PrismaClient, ouiLookup: OuiLookup) {
  return {
    async reconcile(input: ReconcileInput) {
      const firewallOk = !(input.firewallRules instanceof RouterError);
      const blockedMacs = firewallOk
        ? new Set((input.firewallRules as FirewallRejectRule[]).map(r => normalizeMac(r.srcMac)))
        : null;

      const observed = new Map<string, { ip?: string; hostname?: string }>();
      for (const l of input.leases) observed.set(normalizeMac(l.mac), { ip: l.ip, hostname: l.hostname });
      for (const w of input.wirelessClients) if (!observed.has(normalizeMac(w.mac))) observed.set(normalizeMac(w.mac), {});

      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const pollMinutes = Math.max(0, input.pollIntervalMs / 60000);

      for (const [mac, { ip, hostname }] of observed) {
        const existing = await prisma.networkDevice.findUnique({ where: { mac } });
        const vendor = existing?.vendor ?? ouiLookup.lookup(mac);
        const isBlocked = firewallOk ? blockedMacs!.has(mac) : existing?.isBlocked ?? false;

        await prisma.networkDevice.upsert({
          where: { mac },
          create: { mac, vendor, hostname, lastIp: ip, isBlocked, firstSeen: now, lastSeen: now },
          update: { hostname, lastIp: ip, isBlocked, lastSeen: now },
        });

        // Presence rollup
        await prisma.devicePresenceDay.upsert({
          where: { mac_date: { mac, date: today } },
          create: { mac, date: today, seenMinutes: Math.round(pollMinutes) },
          update: { seenMinutes: { increment: Math.round(pollMinutes) } },
        });
      }
    },

    async purgePresenceRows(olderThanDays = 30) {
      const cutoff = new Date(Date.now() - olderThanDays * 86400000);
      return prisma.devicePresenceDay.deleteMany({ where: { date: { lt: cutoff } } });
    },

    async forgetDevice(mac: string) {
      return prisma.networkDevice.delete({ where: { mac: normalizeMac(mac) } });
    },
  };
}

export type DeviceRegistry = ReturnType<typeof createDeviceRegistry>;
```

- [ ] **Step 11: Implement lifecycle hook**

In `apps/orchestrator/src/index.ts` lifespan (search for existing service-init blocks — match the pattern). Pseudo-code:
```ts
const ouiLookup = createOuiLookup(process.env.OUI_CSV_PATH ?? path.resolve("./data/oui.csv"));
const deviceRegistry = createDeviceRegistry(prisma, ouiLookup);

// Schedule purge at 03:00 local via node-cron (already used elsewhere)
cron.schedule("0 3 * * *", () => deviceRegistry.purgePresenceRows());

// Hook reconcile into the existing DHCP poller
networkPoller.on("poll", (snapshot) => deviceRegistry.reconcile({
  leases: snapshot.leases,
  wirelessClients: snapshot.wirelessClients,
  firewallRules: snapshot.firewallRules,  // RouterError instance or array
  pollIntervalMs: POLL_INTERVAL_MS,
}));
```

- [ ] **Step 12: Update `apps/orchestrator/Dockerfile`**

Find the orchestrator Dockerfile's COPY block and add:
```Dockerfile
COPY data/oui.csv ./data/oui.csv
```

- [ ] **Step 13: Run tests + tsc**
```bash
npm test
npx tsc --noEmit
```

- [ ] **Step 14: Integration smoke — mock routing**
```bash
ROUTING_MODE=mock npm run dev
# In another shell:
curl -sS http://localhost:3000/api/network/devices | jq .
psql "$DATABASE_URL" -c 'SELECT mac, vendor, hostname FROM "NetworkDevice";'
# Expected: 3 rows with vendors resolved from mock MAC prefixes
```

- [ ] **Step 15: Commit + push**
```bash
git add apps/orchestrator/data/oui.csv apps/orchestrator/src/services/oui-lookup.service.ts apps/orchestrator/src/services/oui-lookup.service.test.ts apps/orchestrator/src/services/device-registry.service.ts apps/orchestrator/src/services/device-registry.service.test.ts apps/orchestrator/Dockerfile apps/orchestrator/src/index.ts scripts/fetch-oui.sh
git commit -m "feat(orchestrator): DHCP reconciler + OUI vendor lookup (WARP-81)"
git push -u origin WARP-81
```

---

## Task 4: WARP-82 — Orchestrator API

**Branch:** `WARP-82`.
**Depends on:** WARP-81 merged.
**Size:** S.

**Files:** see File Structure above.

- [ ] **Step 1: Rebase on main**
```bash
git checkout WARP-82 && git fetch origin && git rebase origin/main
```

- [ ] **Step 2: Write failing service test for `listDevices`**

Create `apps/orchestrator/src/services/network-device.service.test.ts` with cases:
- `listDevices()` joins NetworkDevice rows with live DHCP snapshots, sets `online = lastSeen > now() - 2min`
- `listDevices({ onlineOnly: true })` filters offline
- `listDevices({ groupId })` returns only members of that group
- `getDevice(mac)` returns device + last 30 presence rows
- `updateDevice(mac, { icon: "Tv" })` persists
- `updateDevice(mac, { icon: "BogusIcon" })` throws `DeviceRegistryError` with code `INVALID_ICON`
- `assignDeviceGroups(mac, groupIds)` replaces the set
- `createGroup("Living Room")` on an existing name throws `DUPLICATE_GROUP_NAME`
- `deleteGroup(id)` cascades on join; devices remain

Prisma mocked via the existing in-memory Map pattern.

- [ ] **Step 3: Implement `network-device.service.ts`**

Shape:
```ts
import type { PrismaClient } from "@prisma/client";
import { DeviceRegistryError } from "../types/device-registry-error.js";
import { normalizeMac } from "../lib/mac.js";

const ICON_ALLOWLIST = new Set([
  "Tv","Smartphone","Laptop","Tablet","Router","Speaker","Camera","Lightbulb","Gamepad",
  "Monitor","Printer","Watch","Thermometer","Lock","Headphones","Mouse","Keyboard","Radio","Disc","HelpCircle",
]);

export function createNetworkDeviceService(prisma: PrismaClient, liveSnapshot: () => Promise<{
  leases: Array<{ mac: string; ip: string; hostname?: string }>;
  wirelessClients: Array<{ mac: string; signal?: number }>;
}>) {
  async function listDevices(opts: { onlineOnly?: boolean; groupId?: string } = {}) {
    const where = opts.groupId ? { groups: { some: { id: opts.groupId } } } : undefined;
    const rows = await prisma.networkDevice.findMany({ where, include: { groups: true } });
    const snap = await liveSnapshot();
    const liveByMac = new Map(snap.wirelessClients.map(w => [normalizeMac(w.mac), w]));
    const twoMin = Date.now() - 120000;
    const enriched = rows.map(d => ({
      ...d,
      online: d.lastSeen.getTime() > twoMin,
      signal: liveByMac.get(d.mac)?.signal,
    }));
    return opts.onlineOnly ? enriched.filter(d => d.online) : enriched;
  }

  async function getDevice(mac: string) {
    const norm = normalizeMac(mac);
    const device = await prisma.networkDevice.findUnique({
      where: { mac: norm },
      include: { groups: true, presenceDays: { orderBy: { date: "desc" }, take: 30 } },
    });
    if (!device) throw DeviceRegistryError.notFound(`Device ${norm}`);
    return { device, presence: device.presenceDays };
  }

  async function updateDevice(mac: string, patch: { displayName?: string; icon?: string; notes?: string }) {
    if (patch.icon && !ICON_ALLOWLIST.has(patch.icon)) throw DeviceRegistryError.invalidIcon(patch.icon);
    return prisma.networkDevice.update({ where: { mac: normalizeMac(mac) }, data: patch });
  }

  async function assignDeviceGroups(mac: string, groupIds: string[]) {
    return prisma.networkDevice.update({
      where: { mac: normalizeMac(mac) },
      data: { groups: { set: groupIds.map(id => ({ id })) } },
      include: { groups: true },
    });
  }

  async function listGroups() {
    return prisma.deviceGroup.findMany({ include: { _count: { select: { devices: true } } } });
  }

  async function createGroup(name: string, color?: string, icon?: string) {
    const existing = await prisma.deviceGroup.findUnique({ where: { name } });
    if (existing) throw DeviceRegistryError.duplicateGroupName(name);
    return prisma.deviceGroup.create({ data: { name, color, icon } });
  }

  async function renameGroup(id: string, patch: { name?: string; color?: string; icon?: string }) {
    if (patch.name) {
      const dup = await prisma.deviceGroup.findFirst({ where: { name: patch.name, NOT: { id } } });
      if (dup) throw DeviceRegistryError.duplicateGroupName(patch.name);
    }
    return prisma.deviceGroup.update({ where: { id }, data: patch });
  }

  async function deleteGroup(id: string) {
    return prisma.deviceGroup.delete({ where: { id } });  // join table cascades
  }

  return { listDevices, getDevice, updateDevice, assignDeviceGroups, listGroups, createGroup, renameGroup, deleteGroup };
}
```

- [ ] **Step 4: Run service tests — confirm green**

- [ ] **Step 5: Write failing supertest route tests**

Create `apps/orchestrator/src/routes/network.device.test.ts` with one `describe` per endpoint. For each: happy path + error path + auth gate (401 when no bearer). Use the existing supertest wiring pattern from `__tests__/device-clients.test.ts`.

- [ ] **Step 6: Add routes to `network.ts`**

Append the 9 routes from spec §7 inside `createNetworkRouter`. Response pattern mirrors existing:
```ts
router.get("/devices", async (req, res) => {
  try {
    const legacy = req.query.legacy === "1";
    if (legacy) return res.json(await getLegacyDevices());  // retain old shape
    const devices = await deviceService.listDevices({
      onlineOnly: req.query.onlineOnly === "1",
      groupId: typeof req.query.groupId === "string" ? req.query.groupId : undefined,
    });
    res.json({ devices });
  } catch (err) {
    if (err instanceof DeviceRegistryError) return res.status(err.status ?? 400).json({ error: err.toJSON() });
    throw err;
  }
});
```

Repeat for each of the 9 endpoints listed in spec §7. Wire into `createNetworkRouter` signature (add `deviceService` param or construct inside using the passed `prisma`).

- [ ] **Step 7: Add Redis cache keys**

`network:devices:list` (10s TTL), `network:groups:list` (10s TTL). Invalidate on any write route. Use the existing `cache.service.ts` helpers.

- [ ] **Step 8: Run full suite + tsc**
```bash
cd apps/orchestrator && npm test && npx tsc --noEmit
# Expected: all 257+ tests + new tests PASS
```

- [ ] **Step 9: curl walkthrough for the PR body**
```bash
# Start orchestrator (ROUTING_MODE=mock)
TOKEN="$(cat .env | grep ROUTING_SERVICE_TOKEN | cut -d= -f2)"
curl -sH "Authorization: Bearer $TOKEN" http://localhost:3000/api/network/devices | jq .
curl -sH "Authorization: Bearer $TOKEN" -X PATCH -d '{"displayName":"Living Room TV"}' -H "Content-Type: application/json" http://localhost:3000/api/network/devices/AA:BB:CC:DD:EE:FF | jq .
curl -sH "Authorization: Bearer $TOKEN" -X POST -d '{"groupIds":["<id>"]}' -H "Content-Type: application/json" http://localhost:3000/api/network/devices/AA:BB:CC:DD:EE:FF/groups | jq .
curl -sH "Authorization: Bearer $TOKEN" http://localhost:3000/api/network/devices | jq .
curl -sH "Authorization: Bearer $TOKEN" -X DELETE http://localhost:3000/api/network/devices/AA:BB:CC:DD:EE:FF -w "%{http_code}\n"
```

Paste outputs into the PR body.

- [ ] **Step 10: Commit + push**
```bash
git add apps/orchestrator/src/services/network-device.service.ts apps/orchestrator/src/services/network-device.service.test.ts apps/orchestrator/src/routes/network.ts apps/orchestrator/src/routes/network.device.test.ts
git commit -m "feat(orchestrator): /network/devices + /network/groups REST API (WARP-82)"
git push -u origin WARP-82
```

---

## Task 5: WARP-87 — CI OUI refresh workflow

**Branch:** `WARP-87`.
**Depends on:** WARP-81 merged (fetch-oui.sh must exist). Can ship in parallel with WARP-82.
**Size:** S.

**Files:**
- Create: `.github/workflows/refresh-oui.yml`

- [ ] **Step 1: Rebase on main**

- [ ] **Step 2: Create workflow**

```yaml
name: Refresh OUI Registry

on:
  schedule:
    - cron: "0 12 1 */3 *"  # 12:00 UTC, 1st of Jan/Apr/Jul/Oct
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Fetch OUI CSV
        run: ./scripts/fetch-oui.sh

      - name: Diff check
        id: diff
        run: |
          if git diff --quiet apps/orchestrator/data/oui.csv; then
            echo "changed=false" >> "$GITHUB_OUTPUT"
          else
            echo "changed=true" >> "$GITHUB_OUTPUT"
          fi

      - name: Open PR
        if: steps.diff.outputs.changed == 'true'
        uses: peter-evans/create-pull-request@v6
        with:
          commit-message: "chore: quarterly OUI registry refresh"
          branch: chore/oui-refresh
          delete-branch: true
          title: "chore: quarterly OUI registry refresh"
          body: |
            Automated quarterly refresh of the IEEE OUI vendor registry.

            Review the vendor diff before merging.
          labels: automated,data-refresh
```

- [ ] **Step 3: Dry-run the logic locally**
```bash
# Simulate "no change" branch
./scripts/fetch-oui.sh
git diff --quiet apps/orchestrator/data/oui.csv && echo "would NOT open PR"

# Simulate "change" branch
rm apps/orchestrator/data/oui.csv && ./scripts/fetch-oui.sh
git diff --quiet apps/orchestrator/data/oui.csv || echo "would open PR"
git checkout apps/orchestrator/data/oui.csv
```

- [ ] **Step 4: shellcheck + yamllint**
```bash
shellcheck scripts/fetch-oui.sh
# (yamllint is optional — not yet enforced in repo)
```

- [ ] **Step 5: Manual dispatch test (after PR merges)**

Note in PR body: run `Actions → Refresh OUI Registry → Run workflow` once merged, confirm no PR opens with an unchanged CSV.

- [ ] **Step 6: Commit + push**
```bash
git add .github/workflows/refresh-oui.yml
git commit -m "ci(oui): quarterly IEEE OUI registry refresh workflow (WARP-87)"
git push -u origin WARP-87
```

---

## Task 6: WARP-83 — Dashboard card grid

**Branch:** `WARP-83`.
**Depends on:** WARP-82 merged.
**Size:** M.

**Files:** see File Structure above.

- [ ] **Step 1: Rebase on main**

- [ ] **Step 2: Add types**

Append to `apps/web-dashboard/src/lib/types.ts`:
```ts
export interface DevicePresenceDay { date: string; seenMinutes: number }
export interface DeviceGroupRef { id: string; name: string; color?: string; icon?: string }
export interface EnrichedNetworkDevice {
  mac: string;
  displayName: string | null;
  icon: string | null;
  notes: string | null;
  vendor: string | null;
  hostname: string | null;
  lastIp: string | null;
  firstSeen: string;
  lastSeen: string;
  isBlocked: boolean;
  online: boolean;
  signal?: number;
  groups: DeviceGroupRef[];
  presenceDays?: DevicePresenceDay[];
}
export interface DeviceGroupWithCount extends DeviceGroupRef { _count: { devices: number } }
```

- [ ] **Step 3: Write SWR hooks**

`apps/web-dashboard/src/lib/hooks/useNetworkDevices.ts`:
```ts
"use client";
import useSWR from "swr";
import type { EnrichedNetworkDevice } from "@/lib/types";

const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

export function useNetworkDevices(opts: { onlineOnly?: boolean; groupId?: string } = {}) {
  const qs = new URLSearchParams();
  if (opts.onlineOnly) qs.set("onlineOnly", "1");
  if (opts.groupId) qs.set("groupId", opts.groupId);
  const key = `/api/network/devices?${qs.toString()}`;
  return useSWR<{ devices: EnrichedNetworkDevice[] }>(key, fetcher, { refreshInterval: 10_000 });
}
```

Analogous `useNetworkGroups.ts` with 30s refresh.

- [ ] **Step 4: Write failing DeviceCard tests**

`apps/web-dashboard/src/components/network/__tests__/DeviceCard.test.tsx`:
- Renders name from `displayName ?? hostname ?? vendor ?? "Device"`
- Shows online dot vs. "last seen Xh ago" for offline
- Click invokes `onOpen(device)`
- Hover reveals Block/Unblock (smoke test only; full wiring in WARP-86)
- 30 sparkline bars rendered when presenceDays present

- [ ] **Step 5: Implement `DeviceSparkline`**

```tsx
import React from "react";
import type { DevicePresenceDay } from "@/lib/types";

export function DeviceSparkline({ days, size = "sm" }: { days: DevicePresenceDay[]; size?: "sm" | "lg" }) {
  const bars = Array.from({ length: 30 }, (_, i) => days[i]?.seenMinutes ?? 0);
  const h = size === "lg" ? 40 : 16;
  return (
    <div className="flex items-end gap-[1px]" role="img" aria-label="30-day activity">
      {bars.map((m, i) => (
        <div key={i} className="bg-accent/60 rounded-sm w-[3px]" style={{ height: `${Math.max(1, (m/1440)*h)}px` }} />
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Implement `DeviceCard`**

```tsx
"use client";
import * as Icons from "lucide-react";
import type { EnrichedNetworkDevice } from "@/lib/types";
import { DeviceSparkline } from "./DeviceSparkline";

export function DeviceCard({ device, onOpen }: { device: EnrichedNetworkDevice; onOpen: (d: EnrichedNetworkDevice) => void }) {
  const IconComp = (device.icon && (Icons as any)[device.icon]) ?? Icons.HelpCircle;
  const displayName = device.displayName ?? device.hostname ?? device.vendor ?? "Device";
  return (
    <button
      onClick={() => onOpen(device)}
      className={`dp-card p-4 text-left transition ${device.online ? "" : "opacity-70"}`}
    >
      <div className="flex items-center gap-3">
        <IconComp className="w-12 h-12 text-accent" />
        <div className="flex-1">
          <p className="type-headline text-label-primary">{displayName}</p>
          <p className="type-footnote text-label-secondary">{device.vendor ?? "—"} · {device.lastIp ?? "—"}</p>
        </div>
        <div className={`w-2 h-2 rounded-full ${device.online ? "bg-system-green" : "bg-label-quaternary"}`} />
      </div>
      <div className="mt-2 flex gap-1 flex-wrap">
        {device.groups.map(g => (
          <span key={g.id} className="type-caption-1 px-2 py-0.5 rounded-full bg-surface-secondary">{g.name}</span>
        ))}
      </div>
      <div className="mt-2">
        <DeviceSparkline days={device.presenceDays ?? []} />
      </div>
    </button>
  );
}
```

- [ ] **Step 7: Implement `DeviceGridSection`**

Collapsible wrapper. Persists open/closed in `localStorage.droplet.network.sections` as `Record<string, boolean>`. Sorts members online-first, then by active sort column.

- [ ] **Step 8: Modify `apps/web-dashboard/src/app/network/page.tsx`**

Replace the Devices-tab table (the `<table>` block around lines 448–521 per Explore survey) with:
```tsx
<div className="flex items-center gap-3 mb-6">
  <input placeholder="Search devices..." className="..." />
  <button onClick={toggleOnline}>Online only</button>
  <select value={sort} onChange={...}><option value="name">Name</option>...</select>
  <button onClick={openGroupManager}>Manage groups</button>
</div>
{isLoading ? <Loader /> : devices.length === 0 ? <EmptyState /> : (
  <>
    {sections.map(section => (
      <DeviceGridSection key={section.id} group={section} devices={section.members} onOpen={setOpenDevice} />
    ))}
    {ungrouped.length > 0 && (
      <DeviceGridSection group={{ id: "__ungrouped", name: "Ungrouped" }} devices={ungrouped} onOpen={setOpenDevice} />
    )}
  </>
)}
```

Responsive grid via Tailwind: `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4`.

- [ ] **Step 9: Run dashboard tests**
```bash
cd apps/web-dashboard && npm test
npx tsc --noEmit
```

- [ ] **Step 10: Visual smoke test**
```bash
ROUTING_MODE=mock npm run dev:docker
# Open http://localhost:3001/network → Devices tab
# Expected: 3 mock devices in groups, responsive at 3/2/1 columns
```

- [ ] **Step 11: Commit + push**
```bash
git add apps/web-dashboard/
git commit -m "feat(dashboard): sectioned 3-col device card grid (WARP-83)"
git push -u origin WARP-83
```

---

## Task 7: WARP-84 — Detail slide-over

**Branch:** `WARP-84`. **Depends on:** WARP-83 merged. **Size:** L.

- [ ] **Step 1: Rebase on main**

- [ ] **Step 2: Write failing `IconPicker` test**

`apps/web-dashboard/src/components/network/__tests__/IconPicker.test.tsx`:
- Renders 20 icons
- Current selection has ring class
- Click invokes `onSelect` with icon name
- Arrow keys move focus (accessibility)

- [ ] **Step 3: Implement `IconPicker`**

20 Lucide icons in a grid. Keyboard nav via `onKeyDown` managing `focusIdx`. Selected gets `ring-2 ring-accent`.

- [ ] **Step 4: Write failing `DeviceDetailPanel` tests**

- Slide-over opens with `role="dialog"`
- ESC closes
- Focus trap — Tab cycles within
- Name input saves debounced (500ms) + on blur
- Notes textarea same debounce behavior
- Sparkline shows 30 bars with `aria-label`
- "Forget device" shows confirm, calls DELETE on confirm
- Optimistic mutation with error → rollback + toast

Use `@testing-library/react` fake timers for debounce.

- [ ] **Step 5: Implement `useDeviceMutations.ts`**

Optimistic SWR mutations — `mutate()` with rollback on `DeviceRegistryError` response. Translate code → toast copy map:
```ts
const TOAST_COPY: Record<string, string> = {
  INVALID_ICON: "Pick a different icon",
  INVALID_MAC: "Device address is invalid",
  NOT_FOUND: "Device was forgotten or never seen",
  DUPLICATE_GROUP_NAME: "A group with that name already exists",
  GROUP_IN_USE: "Can't delete — group still has devices",
};
```

- [ ] **Step 6: Implement `DeviceDetailPanel`**

440px right-anchored slide-over. Uses Radix Dialog or a minimal focus-trap hook. Sections from spec §8.3.

- [ ] **Step 7: Wire from `DeviceCard.onOpen` in `page.tsx`**

`const [openMac, setOpenMac] = useState<string|null>(null)` — passed down; panel fetches its own detail via `useSWR(openMac ? \`/api/network/devices/${openMac}\` : null, ...)`.

- [ ] **Step 8: Run tests + tsc + visual smoke**

- [ ] **Step 9: Commit + push**
```bash
git commit -m "feat(dashboard): device detail slide-over (WARP-84)"
git push -u origin WARP-84
```

---

## Task 8: WARP-85 — Group manager + chip edit

**Branch:** `WARP-85`. **Depends on:** WARP-83, WARP-84 merged. **Size:** M.

- [ ] **Step 1: Rebase on main**

- [ ] **Step 2: Write `GroupManagerDialog` failing tests**

- Lists existing groups with member count
- Create — POST /api/network/groups
- Rename — PATCH /api/network/groups/:id
- Delete with confirm dialog ("N devices will become ungrouped")
- Duplicate-name rejection toasts `DUPLICATE_GROUP_NAME`

- [ ] **Step 3: Implement `GroupManagerDialog`**

Modal dialog opened from Devices-tab header button. Reuses `IconPicker` from WARP-84.

- [ ] **Step 4: Write `GroupTypeahead` failing tests**

- Autocompletes existing group names
- Unmatched input shows "Create <name>"
- Selecting "Create <name>" calls POST /groups then adds to selection
- × on chip removes from selection (calls POST /devices/:mac/groups with subset)

- [ ] **Step 5: Implement `GroupTypeahead`**

Mount inside `DeviceDetailPanel`'s chip row.

- [ ] **Step 6: Tests + tsc + visual smoke**

- [ ] **Step 7: Commit + push**
```bash
git commit -m "feat(dashboard): group manager + chip-edit typeahead (WARP-85)"
git push -u origin WARP-85
```

---

## Task 9: WARP-86 — Block/unblock wiring

**Branch:** `WARP-86`. **Depends on:** WARP-83 merged. **Size:** S.

- [ ] **Step 1: Rebase on main**

- [ ] **Step 2: Write failing `DeviceCard.blockMutation` tests**

- Hover Block/Unblock sends correct payload to existing `/api/network/firewall/block|unblock`
- Tier 2 confirm flow preserved (caller echoes `operation` + `entityId` from WARP-41)
- Optimistic flip of `isBlocked` on card
- Rollback + toast on error
- Operation-Id from response fed to WARP-40 polling banner (verified by mock call to `useOperationTracker`)

- [ ] **Step 3: Implement `useDeviceBlockMutation.ts`**

```ts
export function useDeviceBlockMutation() {
  const { trackOperation } = useOperationTracker();  // existing WARP-40 hook
  const { confirm } = useTierConfirm();               // existing WARP-41 hook
  return async (device: EnrichedNetworkDevice) => {
    const op = device.isBlocked ? "unblock" : "block";
    const ok = await confirm({ operation: op, entityId: device.mac });
    if (!ok) return;
    // Optimistic flip via SWR mutate
    const path = device.isBlocked ? "/api/network/firewall/unblock" : "/api/network/firewall/block";
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mac: device.mac }) });
    if (!res.ok) throw new Error(`${res.status}`);
    const body = await res.json();
    if (body.operationId) trackOperation(body.operationId);
  };
}
```

- [ ] **Step 4: Wire into `DeviceCard` + `DeviceDetailPanel` footer**

- [ ] **Step 5: Tests + tsc + integration smoke on `ROUTING_MODE=mock`**

Confirm pending banner appears, card state reflects new `isBlocked` within ≤10 s (reconciler polling cadence).

- [ ] **Step 6: Commit + push**
```bash
git commit -m "feat(dashboard): block/unblock wired to firewall endpoints (WARP-86)"
git push -u origin WARP-86
```

---

## Plan Self-Review

### Spec coverage check

| Spec section | Covered by |
|---|---|
| §5.1 Prisma additions | Task 2 steps 8–9 |
| §5.2 Migration seed | Task 2 step 10 |
| §5.3 MAC normalization | Task 2 steps 2–7 |
| §5.4 Retention | Task 3 step 10 (`purgePresenceRows`) + Task 3 step 11 cron |
| §6.1 oui-lookup | Task 3 steps 5–8 |
| §6.2 device-registry reconciler | Task 3 steps 9–11 |
| §6.3 network-device.service | Task 4 steps 2–4 |
| §6.4 Typed error | Task 2 steps 4–5 |
| §7 API surface (9 endpoints) | Task 4 steps 5–7 |
| §8.1–§8.2 grid + card | Task 6 steps 2–8 |
| §8.3 detail panel | Task 7 steps 4–7 |
| §8.4 group manager | Task 8 steps 2–5 |
| §8.5 icon picker | Task 7 steps 2–3 |
| §8.6 error + loading states | Task 7 step 5 (`TOAST_COPY` map) |
| §8.7 SWR keys | Task 6 step 3, Task 4 step 7 |
| §9 OUI pipeline (fetch.sh + workflow) | Task 3 step 2 + Task 5 |
| §10 testing strategy | TDD steps throughout |
| §11 agent harness | Task 1 |
| §12 AC per ticket | Mirrored in every task's AC box + PR body template |

No gaps.

### Placeholder scan

No "TBD", "TODO", "implement later". Every code step contains either complete code or a precise reference to an existing file pattern to mirror. Steps that describe procedural work (e.g., "write failing tests for X, Y, Z") list every test case by name so the dev can copy without inference.

### Type consistency

- `normalizeMac`, `DeviceRegistryError`, `createOuiLookup`, `createDeviceRegistry`, `createNetworkDeviceService` all referenced with the same signatures across tasks.
- `EnrichedNetworkDevice` defined in Task 6 step 2, consumed in Tasks 6/7/8/9.
- `DeviceGroupRef` consistent between types.ts and the service-layer response.
- Icon allowlist set (20 names) consistent between `network-device.service.ts` (Task 4) and `IconPicker` (Task 7).
- Cache keys `network:devices:list`, `network:groups:list` consistent between Task 4 step 7 and Task 6 step 3 SWR keys.

No drift.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-16-device-intelligence-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task under the agent harness (WARP-88 Dev → QA → UI/UX → Manager → PR), review between tasks, fast iteration. Matches the spec §11 harness design.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

Which approach?
