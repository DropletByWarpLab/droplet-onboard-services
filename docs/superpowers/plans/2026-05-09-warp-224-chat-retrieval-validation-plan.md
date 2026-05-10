# WARP-224 Chat Retrieval Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock the upload → index → chat → cite chain with 6 new retrieval flows (audio, video subs, video frame OCR, email, archive, deferred ASR) plus a negative test, and ship a runbook future agents can follow to revalidate the full surface.

**Architecture:** Refactor existing inline helpers from `tests/rag-end-to-end.integration.test.ts` into a sibling `tests/helpers/rag-retrieval.ts` so the test file stays readable as flows multiply. Each new flow follows the same pattern as the existing PDF flow: upload, poll-until-ready, ask the agent a sentinel question, assert `search_content` was called and produced a hit on the right file with non-empty snippet text. Sanity-gate `./scripts/test-rag.sh` against `main` before any extension lands.

**Tech Stack:** TypeScript + vitest, Docker Compose test override, Postgres + Prisma (read-only via `psql -t -A -c`), `linuxserver/ffmpeg` Docker image for the new fixture, `python:3.12-slim` Docker image with PIL for slide generation.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `tests/helpers/rag-retrieval.ts` | new | Compose + DB + chat + upload helpers, extracted from the existing test file |
| `tests/rag-end-to-end.integration.test.ts` | refactor + extend | Import from helpers; add 6 new flows + 1 negative test |
| `services/file-indexer/tests/fixtures/with-frame-text.mp4` | new (~30-50 KB) | 5-second clip, frame-OCR-only content, 3 slides with sentinels |
| `scripts/generate-frame-text-fixture.sh` | new | Reproducible Docker-based regenerator for `with-frame-text.mp4` |
| `docs/RAG_TESTING.md` | extend | New "Chat retrieval validation" section (functionality-first, no "phase") |

Other fixtures already exist in `services/file-indexer/tests/fixtures/`: `sample.pdf`, `sample.png`, `sample.wav`, `with-srt.mp4`, `with-pdf-attachment.eml`, `simple.zip`.

---

## Sentinel inventory

Each fixture must have a unique sentinel that the agent's retrieval can match on. We audit at fixture-creation time (Task 1) and assert in tests so a misrouted retrieval can't accidentally pass.

| Fixture | Sentinel(s) | Origin |
|---|---|---|
| `sample.pdf` | `alphahotel` | already in fixture; cited in existing test |
| `sample.png` | `echofoxtrot` | already in fixture; cited in existing test |
| `sample.wav` | `one hundred thousand` (spoken) | content of WARP-197 fixture; loose-match: chunk text contains "hundred thousand" |
| `with-srt.mp4` | `budget meeting kickoff`, `projecting q4 revenue at one hundred thousand` | embedded subtitle stream; from WARP-198 spec |
| `with-frame-text.mp4` | `BUDGET KICKOFF`, `Q4 REVENUE TARGET`, `ONE HUNDRED THOUSAND` | three on-screen PIL slides, generated in Task 1 |
| `with-pdf-attachment.eml` | email body sentinel + `--- Attachment: proposal.pdf ---` separator | from WARP-199 fixture |
| `simple.zip` | text member sentinel + `--- Member: note.txt ---` separator | from WARP-200 fixture |

For audio (WAV transcript) and video subs, transcript-string assertions are loose (substring match on a unique phrase) because faster-whisper output isn't byte-stable. Frame-OCR sentinels are exact-string because Tesseract on the same fixture is stable.

---

## Task 0: Sanity gate — establish baseline before extending

**Files:** none modified.

- [ ] **Step 1: Confirm Docker is running**

```bash
docker info >/dev/null 2>&1 && echo "Docker OK" || echo "Docker NOT RUNNING"
```

Expected: `Docker OK`. If not, start Docker Desktop and re-run.

- [ ] **Step 2: Run the existing RAG suite from main**

```bash
git checkout main && git pull --ff-only
./scripts/test-rag.sh
```

Expected: 6 vitest files (`rag-extractors`, `rag-search`, `rag-brain-upload`, `rag-knowledge`, `rag-brain-export`, `rag-end-to-end`) all pass. Wall-clock 10-25 min. Total assertions ≥ 30.

- [ ] **Step 3: If all 6 pass — proceed**

Move to Task 1.

- [ ] **Step 4: If `rag-extractors` (text/PDF/PNG) fails — STOP and triage**

Per the spec, this is a hard gate. Capture logs:

```bash
mkdir -p /tmp/warp224-baseline-logs
for svc in file-indexer orchestrator ai-gateway nextcloud db mcp-server; do
  docker compose -f docker/docker-compose.yml \
    -f docker/docker-compose.test.override.yml \
    logs --no-color "$svc" > "/tmp/warp224-baseline-logs/${svc}.log"
done
```

Then file a separate fix ticket with the failing assertion + the captured logs. Only resume Task 1 once `rag-extractors` is green again.

- [ ] **Step 5: If a non-WARP-201 test fails — note and proceed**

If `rag-search`, `rag-brain-upload`, `rag-knowledge`, `rag-brain-export`, or `rag-end-to-end` regresses (but text/image is healthy), file a fix ticket and proceed with WARP-224 — these don't gate the extension. Add a note to the PR description that the relevant flow inherits the regression.

- [ ] **Step 6: Tear down**

```bash
docker compose -f docker/docker-compose.yml \
  -f docker/docker-compose.test.override.yml down -v
```

No commit (this is gate-keeping, not code).

---

## Task 1: Generator script + new fixture

**Files:**
- Create: `scripts/generate-frame-text-fixture.sh`
- Create: `services/file-indexer/tests/fixtures/with-frame-text.mp4`

- [ ] **Step 1: Create the generator script**

Write to `scripts/generate-frame-text-fixture.sh`:

```bash
#!/usr/bin/env bash
# Regenerate services/file-indexer/tests/fixtures/with-frame-text.mp4.
# Uses Docker so the build is reproducible regardless of host ffmpeg.
#
# Three on-screen slides; each is exact-string assertable by the
# WARP-224 e2e flow:
#   slide 1: BUDGET KICKOFF
#   slide 2: Q4 REVENUE TARGET
#   slide 3: ONE HUNDRED THOUSAND
#
# Output: ~30-50 KB MP4, 5 seconds, no audio, no subtitle stream.
# Frame-OCR is the only retrievable channel.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
FIXTURE_DIR="${REPO_ROOT}/services/file-indexer/tests/fixtures"
OUT="${FIXTURE_DIR}/with-frame-text.mp4"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Step 1 — render three PNG slides with PIL.
docker run --rm -v "${TMP}:/work" -w /work python:3.12-slim \
  bash -c '
    pip install --quiet --no-cache-dir Pillow &&
    python - <<PY
from PIL import Image, ImageDraw, ImageFont
slides = ["BUDGET KICKOFF", "Q4 REVENUE TARGET", "ONE HUNDRED THOUSAND"]
for i, line in enumerate(slides, start=1):
    im = Image.new("RGB", (1280, 720), "black")
    d = ImageDraw.Draw(im)
    f = ImageFont.load_default(size=80)
    bbox = d.textbbox((0, 0), line, font=f)
    x = (1280 - bbox[2]) / 2
    y = (720 - bbox[3]) / 2
    d.text((x, y), line, fill="white", font=f)
    im.save(f"/work/slide_{i}.png")
print("rendered", len(slides), "slides")
PY
'

# Step 2 — concat slides into an MP4 at 0.6 fps (≈1.66s per slide, 5s total).
docker run --rm -v "${TMP}:/work" -w /work jrottenberg/ffmpeg:7-alpine \
  -y -framerate 0.6 -i slide_%d.png \
  -c:v libx264 -t 5 -pix_fmt yuv420p -an \
  /work/out.mp4

mkdir -p "${FIXTURE_DIR}"
cp "${TMP}/out.mp4" "${OUT}"
ls -lh "${OUT}"
echo "OK: ${OUT}"
```

```bash
chmod +x scripts/generate-frame-text-fixture.sh
```

- [ ] **Step 2: Run the generator**

```bash
./scripts/generate-frame-text-fixture.sh
```

Expected output: a line like `OK: .../with-frame-text.mp4` with a file 20-100 KB in size.

- [ ] **Step 3: Verify the fixture has on-screen text but no audio/subs**

```bash
docker run --rm -v "$(pwd):/work" -w /work jrottenberg/ffmpeg:7-alpine \
  -i services/file-indexer/tests/fixtures/with-frame-text.mp4 -hide_banner 2>&1 | head -20
```

Expected: shows a single video stream (`Stream #0:0: Video: h264`), NO audio stream, NO subtitle stream. Duration ~5 seconds.

- [ ] **Step 4: Spot-check OCR runs on the fixture**

Run the existing image extractor on a single frame to confirm the slides are readable:

```bash
cd services/file-indexer
docker run --rm -v "$(pwd):/work" -w /work jrottenberg/ffmpeg:7-alpine \
  -y -i tests/fixtures/with-frame-text.mp4 -vf "select=eq(n\,1)" -vframes 1 /work/spotcheck.png
```

Then run `tesseract /tmp/spotcheck.png -` (locally) or skip — we'll see real OCR results in Task 5's e2e flow. The point of this step is to fail fast if PIL's default font rendered something Tesseract can't read.

If you don't have tesseract locally, skip this and trust Task 5 to surface OCR-quality issues.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-frame-text-fixture.sh \
        services/file-indexer/tests/fixtures/with-frame-text.mp4
git commit -m "tests(warp-224): frame-OCR-only video fixture + generator

5-second mute video with three sentinel slides (BUDGET KICKOFF,
Q4 REVENUE TARGET, ONE HUNDRED THOUSAND). No audio stream, no
subtitle stream — frame OCR is the only retrievable channel,
isolating the WARP-208 code path for the e2e retrieval flow.

Generator runs via Docker so anyone can regenerate without a
host ffmpeg/PIL build."
```

---

## Task 2: Refactor inline helpers into `tests/helpers/rag-retrieval.ts`

**Files:**
- Create: `tests/helpers/rag-retrieval.ts`
- Modify: `tests/rag-end-to-end.integration.test.ts`

- [ ] **Step 1: Create the helpers module**

Write to `tests/helpers/rag-retrieval.ts`:

```typescript
/**
 * Shared helpers for the RAG end-to-end retrieval flows.
 *
 * Extracted from rag-end-to-end.integration.test.ts when WARP-224
 * added 6 new flows; keeping the test file readable as flows
 * multiply.
 *
 * Skip-gated by RUN_RAG_INTEGRATION=1 like the rest of the suite.
 */
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

export const REPO_ROOT = resolve(__dirname, "..", "..");
export const COMPOSE_BASE = `-f ${REPO_ROOT}/docker/docker-compose.yml`;
export const COMPOSE_OVERRIDE = `-f ${REPO_ROOT}/docker/docker-compose.test.override.yml`;
export const COMPOSE = `docker compose ${COMPOSE_BASE} ${COMPOSE_OVERRIDE}`;
export const NC_DATA_DIR = "/var/www/html/data/admin/files";
export const SHOULD_RUN = process.env.RUN_RAG_INTEGRATION === "1";
export const API_URL = process.env.API_URL ?? "http://localhost:3000";

export function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

export function shSilent(cmd: string): string {
  return execSync(cmd, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function dbQuery(sql: string): string {
  return shSilent(
    `${COMPOSE} exec -T db psql -U droplet -d droplet -t -A -c ${JSON.stringify(sql)}`,
  );
}

export interface ChatResponse {
  message: { role: string; content: string };
  trace: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: unknown;
  }>;
  iterations: number;
  stop_reason: string;
  error?: string;
}

export interface SearchToolHit {
  path: string;
  score: number;
  text: string;
}

export function citationsFrom(resp: ChatResponse): SearchToolHit[] {
  const hits: SearchToolHit[] = [];
  for (const entry of resp.trace) {
    if (entry.tool !== "search_content") continue;
    const result = entry.result as
      | { ok?: boolean; data?: { results?: SearchToolHit[] }; results?: SearchToolHit[] }
      | undefined;
    const list = result?.data?.results ?? result?.results ?? [];
    for (const r of list) {
      if (r && typeof r.path === "string") {
        hits.push({
          path: r.path,
          score: typeof r.score === "number" ? r.score : 0,
          text: typeof r.text === "string" ? r.text : "",
        });
      }
    }
  }
  return hits;
}

export async function chat(question: string): Promise<ChatResponse> {
  const res = await fetch(`${API_URL}/api/llm/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.RAG_E2E_MODEL ?? "llama3.1",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant. When the user asks about a document, you MUST call search_content to retrieve from the user's indexed files before answering. Never answer from memory.",
        },
        { role: "user", content: question },
      ],
      max_iter: 4,
      temperature: 0,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    throw new Error(`/api/llm/chat returned ${res.status}: ${body}`);
  }
  return (await res.json()) as ChatResponse;
}

/**
 * Upload a file via POST /api/files/brain/upload. Returns the
 * BrainMemoryItem id and the synchronous response status string
 * ("indexing", "queued_for_transcription", etc.).
 */
export async function uploadBrainFile(
  filePath: string,
  uploadName: string,
  mimeType: string,
): Promise<{ itemId: string; status: string }> {
  const bytes = readFileSync(filePath);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), uploadName);
  const res = await fetch(`${API_URL}/api/files/brain/upload`, {
    method: "POST",
    body: form,
  });
  if (res.status !== 202) {
    const body = await res.text().catch(() => "<no body>");
    throw new Error(`brain/upload returned ${res.status}: ${body}`);
  }
  return (await res.json()) as { itemId: string; status: string };
}

/**
 * Drop a file into Nextcloud's admin user-files dir + run files:scan.
 * Returns once `occ files:scan` exits successfully — that is when the
 * file is queued for the file-indexer's filecache watcher.
 */
export async function uploadNextcloudFile(
  filePath: string,
  ncSubdir: string,
): Promise<void> {
  sh(`${COMPOSE} exec -T nextcloud mkdir -p ${NC_DATA_DIR}/${ncSubdir}`);
  sh(`${COMPOSE} exec -T nextcloud chown www-data:www-data ${NC_DATA_DIR}/${ncSubdir}`);
  sh(`${COMPOSE} cp ${filePath} nextcloud:${NC_DATA_DIR}/${ncSubdir}/`);
  sh(`${COMPOSE} exec -T nextcloud chown -R www-data:www-data ${NC_DATA_DIR}/${ncSubdir}`);
  sh(
    `${COMPOSE} exec -T -u www-data nextcloud php /var/www/html/occ files:scan --path=admin/files/${ncSubdir} --quiet`,
  );
}

/**
 * Poll until at least one FileContentChunk row exists for the given
 * brain item (source='brain'). Generous default timeout — cold-boot
 * Tesseract / faster-whisper / pgvector embeds can take 30-60s.
 */
export async function pollUntilBrainIndexed(
  itemId: string,
  timeoutMs = 180_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = dbQuery(
      `SELECT "indexedAt" FROM "BrainMemoryItem" WHERE "id" = '${itemId}'`,
    );
    if (out && out.length > 0) {
      const chunks = dbQuery(
        `SELECT count(*) FROM "FileContentChunk" WHERE "brainItemId" = '${itemId}' AND "source" = 'brain'`,
      );
      if (Number.parseInt(chunks, 10) > 0) return true;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/**
 * Poll until at least one FileContentChunk row exists for a
 * Nextcloud-scanned path. `pathLike` is a SQL LIKE pattern (escape
 * percent signs yourself if you need a literal one).
 */
export async function pollNcChunkCount(
  pathLike: string,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = dbQuery(
      `SELECT count(*) FROM "FileContentChunk" WHERE "path" LIKE '${pathLike}' AND "source" = 'nextcloud'`,
    );
    const n = Number.parseInt(out, 10);
    if (Number.isFinite(n) && n > 0) return n;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return 0;
}

/**
 * Read the BrainMemoryItem.status enum value for an item.
 * Returns null if the row doesn't exist.
 */
export function getBrainStatus(itemId: string): string | null {
  const out = dbQuery(
    `SELECT "status" FROM "BrainMemoryItem" WHERE "id" = '${itemId}'`,
  );
  return out.length > 0 ? out : null;
}

/**
 * Poll until BrainMemoryItem.status equals expected.
 * Used by the deferred-ASR flow.
 */
export async function pollUntilBrainStatus(
  itemId: string,
  expected: string,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    last = getBrainStatus(itemId);
    if (last === expected) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}

/**
 * POST /api/files/brain/:itemId/transcribe-now. Returns the response
 * status code so the caller can distinguish 202 (accepted) from 429
 * (retry-cap) / 409 (already indexing).
 */
export async function transcribeNow(itemId: string): Promise<number> {
  const res = await fetch(
    `${API_URL}/api/files/brain/${itemId}/transcribe-now`,
    { method: "POST" },
  );
  return res.status;
}

/**
 * Wait for orchestrator's API health endpoint to become reachable.
 * Used by the test's beforeAll.
 */
export async function waitForOrchestrator(timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${API_URL}/api/orchestrator/health`);
      if (r.ok) return;
    } catch {
      /* connection refused while booting */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("orchestrator never came up within timeout");
}
```

- [ ] **Step 2: Refactor `tests/rag-end-to-end.integration.test.ts` to import the helpers**

Replace the entire helpers block (lines ~61-221 of the existing file: `import` statements through the `chat` function definition) with:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

import {
  REPO_ROOT,
  COMPOSE,
  NC_DATA_DIR,
  SHOULD_RUN,
  API_URL,
  sh,
  dbQuery,
  citationsFrom,
  chat,
  uploadBrainFile,
  uploadNextcloudFile,
  pollUntilBrainIndexed,
  pollNcChunkCount,
  waitForOrchestrator,
} from "./helpers/rag-retrieval";
```

The fixture-path constants and sentinels stay in the test file (they are flow-specific):

```typescript
const PDF_FIXTURE = resolve(REPO_ROOT, "services/file-indexer/tests/fixtures/sample.pdf");
const PNG_FIXTURE = resolve(REPO_ROOT, "services/file-indexer/tests/fixtures/sample.png");
const PDF_SENTINEL = "alphahotel";
const PNG_SENTINEL = "echofoxtrot";
const NC_SUBDIR = "test-rag-end-to-end";
```

In `beforeAll`, replace the manual fetch + FormData PNG upload with:

```typescript
const upJson = await uploadBrainFile(PNG_FIXTURE, "warp206-image.png", "image/png");
brainItemId = upJson.itemId;
```

And the manual Nextcloud cp+chown+scan block with:

```typescript
await uploadNextcloudFile(PDF_FIXTURE, NC_SUBDIR);
```

The DB-wait, NC-bootstrap-wait, and orchestrator-health-wait blocks stay as-is for now — they are Compose-up concerns specific to this test's beforeAll. The existing PDF and PNG `it` blocks stay unchanged (they use `citationsFrom`, `chat`, `pollNcChunkCount`, `pollBrainIndexed` — all now imported).

- [ ] **Step 3: Run the existing flows to confirm no regression**

```bash
./scripts/test-rag.sh --only end-to-end
```

Expected: PDF flow + PNG flow + 5-loop determinism flow all pass exactly as before. Wall-clock ≤ 10 min on warm caches.

If any existing flow now fails, the refactor was lossy — diff against the original `tests/rag-end-to-end.integration.test.ts` to find the missed line.

- [ ] **Step 4: Commit**

```bash
git add tests/helpers/rag-retrieval.ts tests/rag-end-to-end.integration.test.ts
git commit -m "tests(warp-224): extract rag-retrieval helpers into tests/helpers/

Refactors helpers (sh, dbQuery, chat, citationsFrom, brain-upload,
nextcloud-scan, polling) out of the e2e test file into a sibling
module. New helpers added for upcoming flows: getBrainStatus,
pollUntilBrainStatus, transcribeNow, uploadBrainFile,
uploadNextcloudFile, waitForOrchestrator.

Existing PDF + PNG + 5-loop determinism flows are unchanged in
behavior; the refactor lifts duplicated lines, no new assertions."
```

---

## Task 3: Audio retrieval flow

**Files:**
- Modify: `tests/rag-end-to-end.integration.test.ts`

- [ ] **Step 1: Add the fixture path + sentinel constant**

Above the `describe(...)` block, append:

```typescript
const WAV_FIXTURE = resolve(REPO_ROOT, "services/file-indexer/tests/fixtures/sample.wav");
// sample.wav speaks "the budget for q4 is one hundred thousand" in the
// existing WARP-197 fixture. We assert on the substring "hundred thousand"
// because faster-whisper output isn't byte-stable across model versions.
const WAV_SENTINEL = "hundred thousand";
```

- [ ] **Step 2: Add a brain-item id for the audio upload to `beforeAll`**

After the existing PNG upload block in `beforeAll`, append:

```typescript
// ─── Audio brain-upload (sync chat-attachment path, not deferred) ───
const wavUp = await uploadBrainFile(WAV_FIXTURE, "warp224-audio.wav", "audio/wav");
audioItemId = wavUp.itemId;
const audioOk = await pollUntilBrainIndexed(audioItemId, 240_000);
if (!audioOk) {
  throw new Error(`Audio brain item ${audioItemId} never indexed — check file-indexer + ai-gateway logs`);
}
```

And declare the variable alongside the existing `brainItemId`:

```typescript
let audioItemId: string | null = null;
```

Note: the WAV's chat-attachment path goes through the SYNC indexing branch (faster-whisper inline). The deferred path is exercised separately in Task 8 with a different audio item.

- [ ] **Step 3: Write the failing audio flow assertion**

Inside the `describe`, after the existing PNG flow, add:

```typescript
it("agent retrieval reaches the brain-uploaded audio (faster-whisper transcript)", async () => {
  const resp = await chat(
    `Search my recordings for "${WAV_SENTINEL}". What does the audio file say?`,
  );

  expect(resp.error).toBeUndefined();
  const hits = citationsFrom(resp);
  expect(hits.length, "agent did not call search_content or got no hits").toBeGreaterThan(0);

  const wavHit = hits.find((h) => h.path.toLowerCase().includes("warp224-audio"));
  expect(wavHit, "no citation for warp224-audio.wav").toBeDefined();
  expect(wavHit!.text.length).toBeGreaterThan(0);
  expect(wavHit!.text.toLowerCase()).toContain(WAV_SENTINEL);
}, 120_000);
```

- [ ] **Step 4: Run the audio flow to verify it fails the right way first**

If the helper plumbing is wrong, the failure surfaces here:

```bash
./scripts/test-rag.sh --only end-to-end
```

Expected on first run: PDF + PNG pass; audio test passes IF the WAV was indexed during beforeAll AND the model called `search_content`. If LLM is offline (Jetson unreachable), the agent may iteration-limit with no `search_content` call — that's the same caveat as the existing PDF flow's 5-loop determinism. The retry that the existing harness does (5 loops on PDF) catches this; for new flows, accept that single-shot tests may flake on a fully off-line model. We add the determinism loop in Task 9.

If the failure is "no citation for warp224-audio.wav" but `search_content` WAS called and returned hits for OTHER files — that's a real bug: the indexer didn't write chunks for the WAV. Capture file-indexer logs and triage faster-whisper.

- [ ] **Step 5: Add audio to the 5-loop determinism harness**

At the very bottom of the existing `it.each([1..5])` block (currently asserting on PDF), add a sibling `it.each` block for audio:

```typescript
it.each([1, 2, 3, 4, 5])(
  "retrieval stays deterministic across run #%i (audio citation)",
  async (run) => {
    const resp = await chat(
      `Tell me about "${WAV_SENTINEL}" from my audio recordings.`,
    );
    const hits = citationsFrom(resp);
    expect(
      hits.length,
      `run #${run}: agent did not call search_content or got no hits`,
    ).toBeGreaterThan(0);
    const wavHit = hits.find((h) => h.path.toLowerCase().includes("warp224-audio"));
    expect(
      wavHit,
      `run #${run}: audio citation missing — retrieval is flaky`,
    ).toBeDefined();
    expect(wavHit!.text.toLowerCase()).toContain(WAV_SENTINEL);
  },
  120_000,
);
```

- [ ] **Step 6: Run the full e2e flow to verify all flows still pass**

```bash
./scripts/test-rag.sh --only end-to-end
```

Expected: PDF + PNG + audio + 5-loop PDF + 5-loop audio all pass. Wall-clock ~12-18 min on warm caches.

- [ ] **Step 7: Commit**

```bash
git add tests/rag-end-to-end.integration.test.ts
git commit -m "tests(warp-224): audio retrieval flow + 5-loop determinism

Adds e2e coverage for the WARP-197 audio extractor: brain-upload
sample.wav, poll until faster-whisper writes chunks, ask the agent
about the spoken content, assert search_content cited the audio
file with a chunk containing 'hundred thousand'.

Loose-match assertion on the substring because faster-whisper
output isn't byte-stable across model versions / hardware."
```

---

## Task 4: Video-with-subtitles retrieval flow

**Files:**
- Modify: `tests/rag-end-to-end.integration.test.ts`

- [ ] **Step 1: Add the fixture path + sentinel constants**

```typescript
const SUBS_VIDEO_FIXTURE = resolve(REPO_ROOT, "services/file-indexer/tests/fixtures/with-srt.mp4");
// with-srt.mp4 muxes the WARP-197 sample.wav with a mov_text subtitle
// stream containing "budget meeting kickoff" / "projecting q4 revenue
// at one hundred thousand". The video extractor takes the subtitle
// path (no ASR fallback). The unique 4-word phrase isolates THIS file
// from the audio file's transcript.
const SUBS_VIDEO_SENTINEL = "budget meeting kickoff";
```

- [ ] **Step 2: Upload the video in `beforeAll`**

After the audio block:

```typescript
// ─── Video w/ subtitles brain-upload ───
const subsVidUp = await uploadBrainFile(
  SUBS_VIDEO_FIXTURE,
  "warp224-video-subs.mp4",
  "video/mp4",
);
subsVideoItemId = subsVidUp.itemId;
const subsVideoOk = await pollUntilBrainIndexed(subsVideoItemId, 240_000);
if (!subsVideoOk) {
  throw new Error(
    `Video-w/-subs item ${subsVideoItemId} never indexed — check file-indexer logs`,
  );
}
```

Add the variable declaration:

```typescript
let subsVideoItemId: string | null = null;
```

- [ ] **Step 3: Add the flow assertion**

```typescript
it("agent retrieval reaches a video via subtitle stream (WARP-198)", async () => {
  const resp = await chat(
    `Search my videos for "${SUBS_VIDEO_SENTINEL}". What does the recording say?`,
  );

  expect(resp.error).toBeUndefined();
  const hits = citationsFrom(resp);
  expect(hits.length, "agent did not call search_content").toBeGreaterThan(0);

  const subsHit = hits.find((h) => h.path.toLowerCase().includes("warp224-video-subs"));
  expect(subsHit, "no citation for warp224-video-subs.mp4").toBeDefined();
  expect(subsHit!.text.length).toBeGreaterThan(0);
  expect(subsHit!.text.toLowerCase()).toContain(SUBS_VIDEO_SENTINEL);
}, 120_000);
```

- [ ] **Step 4: Run the flow**

```bash
./scripts/test-rag.sh --only end-to-end
```

Expected: PDF + PNG + audio + video-subs + 5-loop PDF + 5-loop audio all pass.

- [ ] **Step 5: Commit**

```bash
git add tests/rag-end-to-end.integration.test.ts
git commit -m "tests(warp-224): video w/ subtitles retrieval flow

Adds e2e coverage for the WARP-198 subtitle-extraction path:
brain-upload with-srt.mp4, poll until file-indexer writes chunks
from the mov_text subtitle stream, ask the agent about the meeting,
assert search_content cited the video with the subtitle sentinel.

Loose-match on 'budget meeting kickoff' which is unique to this
fixture (does not appear in sample.wav's transcript)."
```

---

## Task 5: Video-with-frame-OCR retrieval flow

**Files:**
- Modify: `tests/rag-end-to-end.integration.test.ts`

- [ ] **Step 1: Add the fixture path + sentinels**

```typescript
const FRAME_VIDEO_FIXTURE = resolve(REPO_ROOT, "services/file-indexer/tests/fixtures/with-frame-text.mp4");
// with-frame-text.mp4 has NO audio + NO subtitle stream. Frame OCR
// is the only retrievable channel. Three on-screen slides:
const FRAME_VIDEO_SENTINEL = "BUDGET KICKOFF";
const FRAME_VIDEO_SECONDARY_SENTINEL = "ONE HUNDRED THOUSAND";
```

- [ ] **Step 2: Upload the video in `beforeAll`**

After the video-w/-subs block:

```typescript
// ─── Video w/ frame OCR brain-upload (WARP-208) ───
// The file-indexer needs VIDEO_FRAME_OCR_ENABLED=1 in its env for
// this flow's frame-OCR text to land in chunks. The test override
// (docker/docker-compose.test.override.yml) sets it for this lane.
const frameVidUp = await uploadBrainFile(
  FRAME_VIDEO_FIXTURE,
  "warp224-video-frame.mp4",
  "video/mp4",
);
frameVideoItemId = frameVidUp.itemId;
const frameVideoOk = await pollUntilBrainIndexed(frameVideoItemId, 300_000);
if (!frameVideoOk) {
  throw new Error(
    `Video-frame item ${frameVideoItemId} never indexed — frame OCR may be off (VIDEO_FRAME_OCR_ENABLED) or extractor regressed`,
  );
}
```

Variable declaration:

```typescript
let frameVideoItemId: string | null = null;
```

- [ ] **Step 3: Confirm the test override sets `VIDEO_FRAME_OCR_ENABLED=1` for the file-indexer**

Read `docker/docker-compose.test.override.yml`. The `file-indexer` service entry must include `VIDEO_FRAME_OCR_ENABLED=1` under `environment:`. If absent, add it:

```yaml
file-indexer:
  environment:
    VIDEO_FRAME_OCR_ENABLED: "1"
```

If the file already has a multi-key environment block, append the key without disturbing the others. If you add this key, include the override change in the same Task 5 commit.

- [ ] **Step 4: Add the flow assertion**

```typescript
it("agent retrieval reaches a video via frame OCR only (WARP-208)", async () => {
  const resp = await chat(
    `Search my videos for "${FRAME_VIDEO_SENTINEL}" — it should be on-screen text. What slide is shown?`,
  );

  expect(resp.error).toBeUndefined();
  const hits = citationsFrom(resp);
  expect(hits.length, "agent did not call search_content").toBeGreaterThan(0);

  const frameHit = hits.find((h) => h.path.toLowerCase().includes("warp224-video-frame"));
  expect(frameHit, "no citation for warp224-video-frame.mp4").toBeDefined();
  expect(frameHit!.text.length).toBeGreaterThan(0);

  // Tesseract is more deterministic than faster-whisper, so we can
  // assert the slide string verbatim. Either of the two sentinels
  // proves frame OCR fired (they're on different slides; the chunker
  // may pack them into one chunk or split, both are acceptable).
  const upperText = frameHit!.text.toUpperCase();
  expect(
    upperText.includes(FRAME_VIDEO_SENTINEL) ||
    upperText.includes(FRAME_VIDEO_SECONDARY_SENTINEL),
    `expected frame OCR sentinel in chunk text, got: ${frameHit!.text.slice(0, 200)}`,
  ).toBe(true);
}, 120_000);
```

- [ ] **Step 5: Add a chunk-level metadata assertion to prove frame OCR was the source**

Right after the citation assertion above, add a separate DB-level check:

```typescript
it("frame-OCR video chunks carry the frame_ocr provenance label", async () => {
  // Read the underlying chunk row's text to confirm the frame-OCR
  // section separator survived. The extractor emits "--- Frame OCR ---"
  // before the timestamped slide text; if that separator's missing,
  // the WARP-208 code path didn't run.
  const chunkText = dbQuery(
    `SELECT string_agg("text", ' ') FROM "FileContentChunk" ` +
    `WHERE "brainItemId" = '${frameVideoItemId}' AND "source" = 'brain'`,
  );
  expect(chunkText.length).toBeGreaterThan(0);
  expect(chunkText).toContain("--- Frame OCR ---");
}, 30_000);
```

- [ ] **Step 6: Run the flow**

```bash
./scripts/test-rag.sh --only end-to-end
```

Expected: all prior flows + video-frame + frame-OCR-provenance flows pass.

If the frame-OCR provenance check fails (no `--- Frame OCR ---` separator), the flag isn't on or the extractor regressed — triage `services/file-indexer` logs for the frame_ocr module's stats summary. If the citation check fails but the provenance check passed, the chunker isn't surfacing frame-OCR chunks to search.

- [ ] **Step 7: Commit**

```bash
git add tests/rag-end-to-end.integration.test.ts docker/docker-compose.test.override.yml
git commit -m "tests(warp-224): frame-OCR video retrieval flow + provenance check

Adds e2e coverage for the WARP-208 frame-OCR code path:
brain-upload with-frame-text.mp4 (mute, no subs, three slides),
poll until chunks land, ask the agent about the on-screen text,
assert search_content cited the file with one of the slide
sentinels (BUDGET KICKOFF / ONE HUNDRED THOUSAND).

Sibling provenance assertion confirms the chunk text contains the
'--- Frame OCR ---' separator emitted by the extractor — proves the
frame-OCR pipeline fired (vs. a no-op that would still pass the
citation assertion against a corrupted hit).

Adds VIDEO_FRAME_OCR_ENABLED=1 to docker-compose.test.override.yml
so frame OCR is on for this lane."
```

---

## Task 6: Email retrieval flow (with nested PDF attachment)

**Files:**
- Modify: `tests/rag-end-to-end.integration.test.ts`

- [ ] **Step 1: Add fixture path + sentinels**

```typescript
const EML_FIXTURE = resolve(REPO_ROOT, "services/file-indexer/tests/fixtures/with-pdf-attachment.eml");
// with-pdf-attachment.eml is the WARP-199 fixture: an email with a
// PDF attachment that itself contains the budget sentinel. Two
// retrieval paths to assert: the email body's content, and the
// nested PDF's text via the recursive dispatcher.
const EML_BODY_SENTINEL = "alphahotel"; // PDF attachment sentinel — the WARP-199 fixture's PDF re-uses sample.pdf
const EML_ATTACHMENT_SEPARATOR = "--- Attachment: ";
```

(Spot-check the actual sentinel before committing: `cat services/file-indexer/tests/fixtures/with-pdf-attachment.eml` — adjust the constant if the body uses a different sentinel string. The plan assumes the WARP-199 fixture re-used `sample.pdf`'s sentinel.)

- [ ] **Step 2: Upload the email in `beforeAll`**

```typescript
// ─── Email brain-upload (WARP-199) ───
const emlUp = await uploadBrainFile(
  EML_FIXTURE,
  "warp224-email.eml",
  "message/rfc822",
);
emailItemId = emlUp.itemId;
const emailOk = await pollUntilBrainIndexed(emailItemId, 240_000);
if (!emailOk) {
  throw new Error(
    `Email item ${emailItemId} never indexed — check file-indexer logs for email extractor`,
  );
}
```

Variable declaration:

```typescript
let emailItemId: string | null = null;
```

- [ ] **Step 3: Add the flow assertion (citation + attachment-separator)**

```typescript
it("agent retrieval reaches an email's attached PDF (WARP-199 recursive dispatch)", async () => {
  const resp = await chat(
    `Search my email for "${EML_BODY_SENTINEL}". What's in the attached document?`,
  );

  expect(resp.error).toBeUndefined();
  const hits = citationsFrom(resp);
  expect(hits.length, "agent did not call search_content").toBeGreaterThan(0);

  const emailHit = hits.find((h) => h.path.toLowerCase().includes("warp224-email"));
  expect(emailHit, "no citation for warp224-email.eml").toBeDefined();
  expect(emailHit!.text.length).toBeGreaterThan(0);
  expect(emailHit!.text.toLowerCase()).toContain(EML_BODY_SENTINEL);
}, 120_000);

it("email chunks carry the --- Attachment: --- separator (recursive dispatch)", async () => {
  const chunkText = dbQuery(
    `SELECT string_agg("text", ' ') FROM "FileContentChunk" ` +
    `WHERE "brainItemId" = '${emailItemId}' AND "source" = 'brain'`,
  );
  expect(chunkText.length).toBeGreaterThan(0);
  expect(chunkText).toContain(EML_ATTACHMENT_SEPARATOR);
}, 30_000);
```

- [ ] **Step 4: Run the flow**

```bash
./scripts/test-rag.sh --only end-to-end
```

Expected: all prior flows + email + email-attachment flows pass.

- [ ] **Step 5: Commit**

```bash
git add tests/rag-end-to-end.integration.test.ts
git commit -m "tests(warp-224): email retrieval flow + recursive dispatch check

Adds e2e coverage for the WARP-199 email extractor + recursive
dispatcher: brain-upload with-pdf-attachment.eml, poll until the
file-indexer walks into the PDF, ask the agent about the
attachment, assert search_content cited the email with the PDF's
sentinel content.

Sibling provenance assertion confirms the chunk text contains the
'--- Attachment: ' separator — proves the recursive dispatcher
walked from email -> PDF, not just indexed the email body."
```

---

## Task 7: Archive retrieval flow (Nextcloud-scan path)

**Files:**
- Modify: `tests/rag-end-to-end.integration.test.ts`

- [ ] **Step 1: Add fixture path + sentinels**

```typescript
const ZIP_FIXTURE = resolve(REPO_ROOT, "services/file-indexer/tests/fixtures/simple.zip");
// simple.zip contains note.txt with the budget sentinel — see WARP-200.
// Indexed via the Nextcloud scan path (NOT brain-upload), exercising
// the same code path we use for archives uploaded via files.
const ZIP_BODY_SENTINEL = "the budget for q4";
const ZIP_MEMBER_SEPARATOR = "--- Member: ";
const NC_SUBDIR_ARCHIVE = "test-warp224-archive";
```

(Spot-check: `unzip -p services/file-indexer/tests/fixtures/simple.zip note.txt` — confirm the sentinel matches.)

- [ ] **Step 2: Upload the zip via Nextcloud-scan in `beforeAll`**

```typescript
// ─── Archive Nextcloud-scan (WARP-200) ───
await uploadNextcloudFile(ZIP_FIXTURE, NC_SUBDIR_ARCHIVE);
const zipOk = await pollNcChunkCount(`%${NC_SUBDIR_ARCHIVE}/simple.zip`, 240_000);
if (zipOk === 0) {
  throw new Error("Archive simple.zip never produced FileContentChunk rows — check file-indexer logs");
}
```

- [ ] **Step 3: Add the cleanup in `afterAll`**

In the existing `afterAll` block, alongside the existing NC_SUBDIR cleanup, add:

```typescript
try {
  sh(`${COMPOSE} exec -T nextcloud rm -rf ${NC_DATA_DIR}/${NC_SUBDIR_ARCHIVE}`);
} catch {
  /* swallow */
}
```

- [ ] **Step 4: Add the flow assertion**

```typescript
it("agent retrieval reaches an archive member via Nextcloud scan (WARP-200)", async () => {
  const resp = await chat(
    `Search my files for "${ZIP_BODY_SENTINEL}". What's inside the zip?`,
  );

  expect(resp.error).toBeUndefined();
  const hits = citationsFrom(resp);
  expect(hits.length, "agent did not call search_content").toBeGreaterThan(0);

  const zipHit = hits.find(
    (h) =>
      h.path.includes(NC_SUBDIR_ARCHIVE) &&
      h.path.toLowerCase().endsWith(".zip"),
  );
  expect(zipHit, "no citation for simple.zip").toBeDefined();
  expect(zipHit!.text.length).toBeGreaterThan(0);
  expect(zipHit!.text.toLowerCase()).toContain(ZIP_BODY_SENTINEL);
}, 120_000);

it("archive chunks carry the --- Member: --- separator", async () => {
  const chunkText = dbQuery(
    `SELECT string_agg("text", ' ') FROM "FileContentChunk" ` +
    `WHERE "path" LIKE '%${NC_SUBDIR_ARCHIVE}/simple.zip' AND "source" = 'nextcloud'`,
  );
  expect(chunkText.length).toBeGreaterThan(0);
  expect(chunkText).toContain(ZIP_MEMBER_SEPARATOR);
}, 30_000);
```

- [ ] **Step 5: Run the flow**

```bash
./scripts/test-rag.sh --only end-to-end
```

Expected: all prior flows + archive + archive-member-separator flows pass.

- [ ] **Step 6: Commit**

```bash
git add tests/rag-end-to-end.integration.test.ts
git commit -m "tests(warp-224): archive retrieval flow + member separator check

Adds e2e coverage for the WARP-200 archive extractor via the
Nextcloud-scan path: drop simple.zip into NC, files:scan, poll
until file-indexer walks into note.txt, ask the agent about the
archive contents, assert search_content cited the zip with the
member's text.

Sibling provenance assertion confirms the chunk text contains the
'--- Member: ' separator — proves the recursive dispatcher walked
from zip -> note.txt, not just indexed the archive's manifest."
```

---

## Task 8: Deferred-ASR retrieval flow (`transcribe-now` path)

**Files:**
- Modify: `tests/rag-end-to-end.integration.test.ts`

- [ ] **Step 1: Add helper for triggering deferred-ASR upload**

The existing `uploadBrainFile` helper takes the SYNC chat-attachment path. The deferred-ASR path is triggered by uploading audio in a way the orchestrator routes to the `queued_for_transcription` status — same endpoint, same file, but the orchestrator distinguishes by upload context.

Read `apps/orchestrator/src/routes/files-brain.ts` (the `/api/files/brain/upload` handler) and confirm whether the deferred path is selected by:
  (a) a query parameter (e.g. `?defer=1`), or
  (b) a multipart field (e.g. `defer: "1"`), or
  (c) is automatic for audio MIMEs from non-chat upload contexts.

The WARP-218 spec says: "Audio + video uploads via the chat-attachment path are no longer transcribed synchronously." So all audio/video uploads to `/api/files/brain/upload` end up in `queued_for_transcription` by default — there's no flag needed; it's the default for audio MIMEs. The SYNC path used by Task 3's `uploadBrainFile(WAV_FIXTURE, ...)` actually goes through the deferred queue too.

**Reconcile:** check what status the WAV upload returns in Task 3's `pollUntilBrainIndexed`. If the WAV gets stuck at `queued_for_transcription` forever, Task 3's flow is blocked on the daily run and we have a real bug — Task 3 would need to call `transcribe-now` itself. If the WAV indexes synchronously, then the deferred path requires a different upload context. Use the actual sandbox boot to find out:

```bash
# After Task 3 boots beforeAll, check the audio item's status in the DB.
docker compose -f docker/docker-compose.yml \
  -f docker/docker-compose.test.override.yml exec -T db \
  psql -U droplet -d droplet -c \
  "SELECT id, status, indexedAt FROM \"BrainMemoryItem\" ORDER BY \"createdAt\" DESC LIMIT 5;"
```

If the audio item's `status` is `queued_for_transcription` and `indexedAt` is null even after 60s — Task 3's upload IS deferred and Task 3 needs the same `transcribe-now` call as Task 8. Update Task 3 retroactively to call `transcribeNow(audioItemId)` after `uploadBrainFile`, and split the deferred-flow assertion (Task 8) to use a SECOND audio upload that we DELIBERATELY leave in `queued_for_transcription` until the test calls `transcribe-now`.

If Task 3's audio item's `status` flips through `queued_for_transcription -> indexing -> ready` automatically (SYNC path bypasses the queue for chat-attachments) — then Task 8 needs a different upload mechanism that lands in the queue. Read the orchestrator route to find it; expected mechanism is a multipart field like `chatAttachment: "0"` or a header like `X-Upload-Context: brain-archive`.

**Decision rule for Task 8 implementation:**

1. Spike the boot: bring up the test stack and watch the DB rows for the WAV upload during a Task 3 dry-run.
2. If WAV status = `ready` automatically → continue with Step 2 below for an alternate-context upload.
3. If WAV status = `queued_for_transcription` → adapt by adding `transcribeNow(audioItemId)` in Task 3 AND re-using the same audio item for Task 8's deferred assertion (just assert the queued→indexed status sequence happened at least once during the Task 3 boot).

The Dev subagent picks the right branch based on what they observe; this plan documents both paths.

- [ ] **Step 2: Add the deferred-ASR fixture path + sentinel**

Re-using `sample.wav` is fine — the assertion separates this flow from Task 3 by upload-time status sequence, not by content. Use a different upload name so the citation hit is distinguishable:

```typescript
const DEFERRED_AUDIO_NAME = "warp224-deferred-audio.wav";
const DEFERRED_AUDIO_SENTINEL = "hundred thousand"; // reusable; same fixture
```

- [ ] **Step 3: Upload + assert status sequence in `beforeAll`**

If branch (3) above (Task 3 already deferred): no new upload needed; just remember to call `transcribeNow(audioItemId)` in Task 3 and add an assertion `expect(getBrainStatus(audioItemId)).toBe("ready")` after the poll.

If branch (2): add the deferred upload alongside the existing audio:

```typescript
// ─── Deferred-ASR brain-upload (WARP-218) ───
const deferredUp = await uploadBrainFile(
  WAV_FIXTURE,
  DEFERRED_AUDIO_NAME,
  "audio/wav",
);
deferredItemId = deferredUp.itemId;

// Confirm it landed in the queue.
const initialStatus = getBrainStatus(deferredItemId);
expect(initialStatus, "deferred audio should land in queued_for_transcription").toBe("queued_for_transcription");

// Promote to immediate processing.
const txCode = await transcribeNow(deferredItemId);
expect(txCode, "transcribe-now should accept (202)").toBe(202);

// Wait for the worker to flip status -> indexing -> ready.
const finalStatus = await pollUntilBrainStatus(deferredItemId, "ready", 240_000);
expect(finalStatus, "deferred audio never reached 'ready'").toBe("ready");

// And confirm chunks landed (chat citation depends on this).
const chunkOk = await pollUntilBrainIndexed(deferredItemId, 60_000);
expect(chunkOk, "deferred audio reached ready but no chunks").toBe(true);
```

Variable declaration:

```typescript
let deferredItemId: string | null = null;
```

- [ ] **Step 4: Add the flow assertion**

```typescript
it("agent retrieval reaches a deferred-ASR audio after transcribe-now (WARP-218)", async () => {
  const resp = await chat(
    `Search my recordings for "${DEFERRED_AUDIO_SENTINEL}" — there's a queued one. What does it say?`,
  );

  expect(resp.error).toBeUndefined();
  const hits = citationsFrom(resp);
  expect(hits.length, "agent did not call search_content").toBeGreaterThan(0);

  const deferredHit = hits.find((h) => h.path.toLowerCase().includes("warp224-deferred-audio"));
  expect(deferredHit, "no citation for warp224-deferred-audio.wav").toBeDefined();
  expect(deferredHit!.text.length).toBeGreaterThan(0);
  expect(deferredHit!.text.toLowerCase()).toContain(DEFERRED_AUDIO_SENTINEL);
}, 120_000);
```

- [ ] **Step 5: Run the flow**

```bash
./scripts/test-rag.sh --only end-to-end
```

Expected: all prior flows + deferred-ASR flow pass. The `pollUntilBrainStatus(... "ready", 240_000)` may take 30-60s after `transcribe-now` — within budget.

If the flow fails at `transcribeNow returned 429` — wait 60s and retry once (the retry-cap window is 60min from first attempt, but a fresh upload should not be in cap). If the second call also 429s — real bug, file a triage ticket against WARP-218.

- [ ] **Step 6: Commit**

```bash
git add tests/rag-end-to-end.integration.test.ts
git commit -m "tests(warp-224): deferred-ASR retrieval flow

Adds e2e coverage for the WARP-218 deferred-ASR + transcribe-now
path: brain-upload sample.wav (lands in queued_for_transcription),
POST /api/files/brain/:id/transcribe-now, poll status until
'ready', poll chunks, ask the agent about the audio, assert
search_content cited the deferred audio file.

Status sequence assertions in beforeAll: initial status =
queued_for_transcription, post-transcribe-now status = ready
(via the worker, not synchronous)."
```

---

## Task 9: Negative test — no fabrication when no files indexed

**Files:**
- Modify: `tests/rag-end-to-end.integration.test.ts`

The existing flows all assert WHAT the agent finds when content exists. The negative test asserts what the agent does when nothing relevant exists — does it call `search_content`, get zero hits, and admit it doesn't know? Or does it confabulate? The retrieval-chain assertion is "called search_content + zero hits"; the agent's prose can still say "I don't have access to that document" or "iteration_limit" — both are acceptable.

- [ ] **Step 1: Define a sentinel that NO fixture contains**

```typescript
// A unique nonsense token. If any chunk text contains this, a
// fixture leak has happened — fail loudly.
const NEGATIVE_SENTINEL = "zzzqqqxxx-nonexistent-token-warp224";
```

- [ ] **Step 2: Audit fixtures don't accidentally contain the sentinel**

```typescript
beforeAll(async () => {
  // Existing beforeAll block — append at the very end:
  // ─── Sentinel uniqueness audit ───
  const leak = dbQuery(
    `SELECT count(*) FROM "FileContentChunk" WHERE "text" ILIKE '%${NEGATIVE_SENTINEL}%'`,
  );
  expect(
    Number.parseInt(leak, 10),
    "negative sentinel leaked into a fixture — pick a different token",
  ).toBe(0);
}, 600_000);
```

- [ ] **Step 3: Add the negative test assertion**

```typescript
it("agent does not fabricate citations when nothing relevant is indexed", async () => {
  const resp = await chat(
    `Search my files for "${NEGATIVE_SENTINEL}". What does the document say?`,
  );

  expect(resp.error).toBeUndefined();
  const hits = citationsFrom(resp);

  // The agent SHOULD call search_content (acceptable: 1+ hits, all
  // unrelated, OR zero hits). What we forbid is hallucinated hits.
  // Concretely: no hit's path should reference the sentinel, and no
  // hit's text should contain it.
  for (const h of hits) {
    expect(
      h.path.toLowerCase().includes(NEGATIVE_SENTINEL.toLowerCase()),
      `hallucinated citation: path '${h.path}' references the negative sentinel`,
    ).toBe(false);
    expect(
      h.text.toLowerCase().includes(NEGATIVE_SENTINEL.toLowerCase()),
      `hallucinated citation: text contains the negative sentinel`,
    ).toBe(false);
  }

  // The agent's prose may say anything — "I don't see that document"
  // or "iteration_limit" or even confabulate prose. Free-text isn't
  // the contract this asserts. The contract is: search results are
  // truthful (no fabricated hits).
}, 60_000);
```

- [ ] **Step 4: Run the negative flow**

```bash
./scripts/test-rag.sh --only end-to-end
```

Expected: all flows pass including negative.

If the negative test fails because some hit's text contains the sentinel — pick a different sentinel string and re-run.

If `search_content` returns hits whose text contains nothing close to the negative sentinel (i.e., the model just searched anyway and got back unrelated chunks) — that's fine. Zero hits is also fine.

- [ ] **Step 5: Commit**

```bash
git add tests/rag-end-to-end.integration.test.ts
git commit -m "tests(warp-224): negative test — no fabricated citations

Asserts that when the agent searches for a token absent from every
indexed fixture, no citation hit's path or text contains the
sentinel. Catches the 'agent confidently makes up a source' failure
mode that would silently pass every other flow.

Sentinel-uniqueness audit also runs in beforeAll: scans every
indexed chunk for the negative sentinel and fails loudly if a
fixture's content drifted into it (pick a new sentinel + retry)."
```

---

## Task 10: Runbook section in `docs/RAG_TESTING.md`

**Files:**
- Modify: `docs/RAG_TESTING.md`

- [ ] **Step 1: Add a top-level section after the existing "What gets tested" table**

Append to `docs/RAG_TESTING.md` after the existing table at line ~21:

````markdown
## Chat retrieval validation

The `rag-end-to-end.integration.test.ts` file is the regression-lock
for the **upload → index → chat → cite** chain. Every shipped
extractor has an `it()` block here that proves the agent can
actually retrieve from a file of its kind. WARP-224 grew this from
2 to 8 flows; future RAG-touching changes should add a flow here
or update the relevant one.

### Flows under test

| # | Flow | Fixture | Upload path | Question shape | Asserts | Owner |
|---|---|---|---|---|---|---|
| 1 | PDF | `sample.pdf` | Nextcloud scan | "What does the document with `alphahotel` say?" | citation on `sample.pdf` + `alphahotel` substring | WARP-204 |
| 2 | PNG | `sample.png` | brain-upload | "What text is in the screenshot?" | citation on `warp206-image.png` + `echofoxtrot` substring | WARP-201 |
| 3 | Audio (faster-whisper) | `sample.wav` | brain-upload | "What does the audio recording say about budget?" | citation on `warp224-audio.wav` + `hundred thousand` substring | WARP-197 |
| 4 | Video w/ subs | `with-srt.mp4` | brain-upload | "What does the meeting recording say?" | citation on `warp224-video-subs.mp4` + `budget meeting kickoff` substring | WARP-198 |
| 5 | Video w/ frame text | `with-frame-text.mp4` | brain-upload | "What's on the slide deck?" | citation + `BUDGET KICKOFF` or `ONE HUNDRED THOUSAND` + `--- Frame OCR ---` separator in chunks | WARP-208 |
| 6 | Email + nested PDF | `with-pdf-attachment.eml` | brain-upload | "What's in the email's attached doc?" | citation + body sentinel + `--- Attachment: ` separator in chunks | WARP-199 |
| 7 | Archive member | `simple.zip` | Nextcloud scan | "What's inside the zip?" | citation + `the budget for q4` substring + `--- Member: ` separator in chunks | WARP-200 |
| 8 | Deferred-ASR | `sample.wav` (re-used) | brain-upload + `POST /transcribe-now` | "What does the queued audio say?" | initial status = `queued_for_transcription`, post-transcribe-now status = `ready`, citation + sentinel | WARP-218 |
| ‒ | Negative | (none) | (no upload) | "Search for `zzzqqqxxx-nonexistent…`" | no citation hit's path or text contains the negative sentinel | WARP-224 |

Every flow runs once; flows #1 (PDF) and #3 (audio) ALSO run a 5x
loop to flush retrieval flake. Free-text prose is allowed to vary;
the retrieval chain (`search_content` called, hits include the file,
snippets non-empty) is what we constrain.

### Running the suite

```bash
./scripts/test-rag.sh --only end-to-end
```

Or manually with Compose already up:

```bash
RUN_RAG_INTEGRATION=1 API_URL=http://localhost:3000 \
  npx vitest run --no-file-parallelism \
  tests/rag-end-to-end.integration.test.ts
```

Wall-clock: ~12-25 min cold, ~6-10 min warm. The dominant cost is
the `beforeAll` (compose up + Nextcloud bootstrap + 8 fixture
uploads + indexing waits). Each individual `it()` runs in 30-120s.

### Triaging a failure

| Symptom | First service to check | Likely cause |
|---|---|---|
| `agent did not call search_content` (any flow) | orchestrator | agent loop iteration limit, model not honoring tool prompt, system prompt regression |
| `no citation for <file>` but `search_content` was called and got OTHER hits | file-indexer | the relevant extractor never wrote chunks; check extractor logs for the fixture's MIME |
| `no citation for <file>` AND `search_content` returned zero hits everywhere | ai-gateway | gRPC unreachable, embed model not loaded, `EMBEDDING_UNAVAILABLE` |
| Citation present but `text.length === 0` | file-indexer (chunker) | chunk row exists but text column is empty; corrupted extractor output |
| Frame-OCR flow fails citation but `--- Frame OCR ---` separator absent | file-indexer | `VIDEO_FRAME_OCR_ENABLED` not set in test override (check `docker/docker-compose.test.override.yml`) or extractor regression |
| Email flow citation passes but `--- Attachment: ` separator absent | file-indexer | recursive dispatcher didn't walk into the PDF; check email extractor logs |
| Archive flow citation passes but `--- Member: ` separator absent | file-indexer | recursive dispatcher didn't walk into the zip; check archive extractor logs |
| Deferred-ASR `transcribeNow returned 429` on a fresh upload | orchestrator | retry-cap state corruption; check `BrainMemoryItem` retry columns |
| Deferred-ASR `status` stuck at `queued_for_transcription` post-transcribe-now | file-indexer | MQTT broker, `transcription_worker.run_one` not picking up the message — check broker logs |
| Negative test fails (sentinel hit) | test fixture or sentinel | a fixture contains the negative sentinel; pick a different token |

For the full Compose-up + service-by-service triage cheatsheet
(everything BEFORE chat retrieval enters the picture — Nextcloud
bootstrap, db init, etc.), see "Reading failure modes" above.

Container logs:

```bash
# Tail one service:
docker compose -f docker/docker-compose.yml \
  -f docker/docker-compose.test.override.yml \
  logs --tail 200 file-indexer

# Dump every service for offline triage (mirrors what CI uploads):
for svc in file-indexer orchestrator ai-gateway nextcloud db mcp-server broker; do
  docker compose -f docker/docker-compose.yml \
    -f docker/docker-compose.test.override.yml \
    logs --no-color "$svc" > "rag-${svc}.log"
done
```

### Adding a new flow when a future extractor lands

1. Place the fixture in `services/file-indexer/tests/fixtures/<name>` (commit it; tiny synthetic preferred).
2. Pick a unique sentinel substring that does NOT appear in any other fixture. Audit it via the in-suite negative-uniqueness check.
3. Decide upload path: brain-upload for items that travel via chat / `/api/files/brain/upload`, Nextcloud-scan for archive-style items via the watched data dir.
4. Add a fixture-path + sentinel constant block at the top of `tests/rag-end-to-end.integration.test.ts`.
5. In `beforeAll`, add the upload + poll-until-ready block. Use `uploadBrainFile` / `uploadNextcloudFile` from `tests/helpers/rag-retrieval.ts`.
6. Add the `it()` block for citation assertion. Use the existing PDF flow as a template; replace fixture name + sentinel.
7. If the extractor emits a structural separator (`--- Member: `, `--- Attachment: `, `--- Frame OCR ---`), add a sibling `it()` that scans the chunks for it — this proves the extractor's code path actually fired vs. accidental retrieval from elsewhere.
8. Add the new row to the table above and to `docs/superpowers/specs/<spec>.md`'s flow inventory.
9. Run `./scripts/test-rag.sh --only end-to-end` and confirm green.

### Why we loop on retrieval determinism

Same reasoning as the existing test header: same chunks, same file, same sentinel — that should be deterministic across model invocations even if the model's prose isn't. The 5-loop check on flows #1 and #3 surfaces the "1-in-5 retrieval missed" case that single-shot tests would call green and ship.

### LLM offline acceptance

If `ai-gateway` routes Ollama to an unreachable Jetson (the default
on a developer laptop), the agent hits `max_iter` and returns
`stop_reason: "iteration_limit"`. That's acceptable as long as
`search_content` was still called and hits came back. The test
asserts on the trace, not the model's prose — so iteration_limit
flows pass exactly like a model-online flow would.

To force a specific test model (e.g., a local Ollama with a small
model loaded), set `RAG_E2E_MODEL=mistral` (or whatever) in the
test environment.
````

- [ ] **Step 2: Verify markdown renders cleanly**

```bash
# Render preview if you have a renderer locally; otherwise scan for
# unbalanced backticks / broken tables.
grep -c "^\`\`\`" docs/RAG_TESTING.md
```

Expected: an even number of fence markers.

- [ ] **Step 3: Commit**

```bash
git add docs/RAG_TESTING.md
git commit -m "docs(warp-224): chat retrieval validation runbook

New section in docs/RAG_TESTING.md documenting the 8 retrieval
flows, the run command, the triage matrix (symptom -> service ->
likely cause), and a step-by-step for adding a new flow when a
future extractor lands. Future agents can re-validate the full
RAG surface from these instructions alone."
```

---

## Self-review

After completing all 11 tasks, run this checklist before opening the PR.

**1. Spec coverage:** map each spec section to a task.

| Spec section | Task |
|---|---|
| §Goals (1) regression coverage | Tasks 3-9 |
| §Goals (2) runbook | Task 10 |
| §Architecture | Task 2 (helpers extraction) + Tasks 3-9 (flows) |
| §File map | All tasks; verify exact paths match |
| §Sanity gate | Task 0 |
| §Test flows table — flow 1 PDF | (already exists) |
| §Test flows table — flow 2 PNG | (already exists) |
| §Test flows table — flow 3 Audio | Task 3 |
| §Test flows table — flow 4 Video w/ subs | Task 4 |
| §Test flows table — flow 5 Video w/ frame text | Task 5 + Task 1 (fixture) |
| §Test flows table — flow 6 Email | Task 6 |
| §Test flows table — flow 7 Archive | Task 7 |
| §Test flows table — flow 8 Deferred ASR | Task 8 |
| §New fixture (with-frame-text.mp4) | Task 1 |
| §Runbook section structure | Task 10 |
| §Test file extension shape (8 flows total) | Tasks 3-8 |
| §Reusable test helpers | Task 2 |
| §Error handling — missing fixture skip | (Step in Task 5: poll-until-indexed throws if fixture missing) |
| §Error handling — 429 on transcribe-now | Task 8 Step 5 |
| §Error handling — LLM offline | Inherits from existing test |
| §Testing the test — sentinel uniqueness | Task 9 Step 2 |
| §Testing the test — negative test | Task 9 |
| §Phasing (commits) | One commit per task |

**2. Placeholder scan:**

```bash
grep -nE "TBD|TODO|FIXME|fill in|implement later|XXX|pick a sensible" docs/superpowers/plans/2026-05-09-warp-224-chat-retrieval-validation-plan.md
```

Expected: any matches are inside the negative-test sentinel string itself ("nonexistent-token") or doc text describing what NOT to write — never an actual instruction-level placeholder.

**3. Type consistency:**

- `uploadBrainFile` returns `{itemId, status}` — used as `.itemId` everywhere ✓
- `pollUntilBrainIndexed` returns `boolean` ✓
- `pollUntilBrainStatus` returns `string | null` ✓
- `getBrainStatus` returns `string | null` ✓
- `transcribeNow` returns `number` (HTTP status code) ✓
- `citationsFrom` returns `SearchToolHit[]` ✓
- `chat` returns `ChatResponse` ✓

All consistent across tasks.

**4. File path consistency:**

- `services/file-indexer/tests/fixtures/with-frame-text.mp4` — referenced in Task 1 (create), Task 5 (use). Matches.
- `tests/helpers/rag-retrieval.ts` — created in Task 2, imported in subsequent tasks. Matches.
- `docker/docker-compose.test.override.yml` — modified in Task 5 step 3 only. No conflict.

**5. Commit cohesion:**

11 commits total (Task 0 has no commit; Tasks 1-10 each have one). Each commit is self-contained: tests + the helper / fixture / doc they need. No cross-task code dependencies that would break a partial revert.
