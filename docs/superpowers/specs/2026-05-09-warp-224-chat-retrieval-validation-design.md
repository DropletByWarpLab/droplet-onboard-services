# WARP-224 — Chat retrieval validation across all extractors

**Status:** Design approved 2026-05-09. Spec → Plan → Dev to follow.

## Goals

1. Lock the **upload → index → chat → cite** chain with automated regression coverage for every Phase 1/2/3 extractor we've shipped (text, PDF, PNG/OCR, audio, video subtitles, video frame OCR, email + attachments, archive members, deferred ASR).
2. Produce a **runbook** future agents can follow to revalidate the full surface without re-deriving the test set — what's tested, how, why, and what to do when a flow regresses.

## Non-goals

- LLM free-form prose quality. Same caveat as the existing e2e test: retrieval chain is deterministic, model output isn't. We assert `search_content` was called and returned the right hits with non-empty snippets — never on the agent's free-text prose.
- 7z / encrypted archive coverage (WARP-212 deferred).
- Performance benchmarks (separate ticket if needed).
- Admin-wide / cross-user analytics (covered by WARP-225).
- New ingestion paths. This ticket only surfaces what we've already shipped.

## Architecture

Extend the existing `tests/rag-end-to-end.integration.test.ts` to cover all 8 retrieval flows (PDF + PNG today + 6 new). Reuse the existing harness:

- Compose-up the test stack via `./scripts/test-rag.sh` or vitest's `RUN_RAG_INTEGRATION=1` gate.
- Brain-upload or Nextcloud-scan path per fixture (matches each extractor's real-world entry point).
- Poll until indexer signals readiness (`indexedAt` for legacy / `status='ready'` for `BrainMemoryItem`).
- Drive `POST /api/llm/chat` with a question only answerable from the file's content.
- Inspect the assistant trace for a `search_content` tool call.
- Assert: tool call happened, hits include the expected file path, snippet is non-empty.
- For LLM-offline runs: `stop_reason: "iteration_limit"` is acceptable as long as `search_content` was invoked and returned hits. Inherited from existing PDF/PNG flow.

5 retrieval-chain runs per flow to flush flake (matches existing test's "5 runs in a row" determinism check).

## File map

| File | Status | Purpose |
|---|---|---|
| `tests/rag-end-to-end.integration.test.ts` | extend | 8 flows total (2 existing + 6 new) |
| `services/file-indexer/tests/fixtures/with-frame-text.mp4` | new | 5-second clip, frame-OCR-only content (no audio, no subs); generated via Docker linux ffmpeg with proper drawtext support |
| `scripts/generate-frame-text-fixture.sh` | new | Reproducible Docker-based regenerator for the above fixture |
| `docs/RAG_TESTING.md` | extend | New "Chat retrieval validation" section (functionality-first naming, no "phase") |

All other fixtures already exist in `services/file-indexer/tests/fixtures/`:

```
sample.pdf                  WARP-204
sample.png                  WARP-201
sample.wav                  WARP-197 audio + WARP-218 deferred ASR
with-srt.mp4                WARP-198 video subtitles
with-pdf-attachment.eml     WARP-199 email + nested PDF
simple.zip                  WARP-200 archive with text member
```

## Sanity gate (Task 0)

Before extending the suite, run `./scripts/test-rag.sh` against current `main`. Treat this as a hard gate:

- All 6 existing tests pass → proceed to extension.
- Any text/image (WARP-201) test regresses → halt, fix the underlying bug as a blocker, retry. Do not stack new flows on a broken baseline.
- Other extractor tests regress → file as separate fix tickets, unblock WARP-224's relevant flow if necessary, but proceed with the rest.

The Dev subagent's first step is this gate. The plan must not allow new test code to land without it being green.

## Test flows (final list)

Each row asserts the same retrieval-chain contract. "Existing" means already in `rag-end-to-end.integration.test.ts`; "New" means added by this ticket.

| # | Flow | Status | Fixture | Upload | Chat question | Specific assertion |
|---|---|---|---|---|---|---|
| 1 | PDF | Existing | `sample.pdf` | Nextcloud scan | "What's in the budget kickoff document?" | tool call + hit on `sample.pdf` + non-empty snippet |
| 2 | PNG | Existing | `sample.png` | brain-upload | "What text is in the screenshot?" | as above |
| 3 | Audio | New | `sample.wav` | brain-upload (sync, chat-attachment path — not deferred) | "What number is mentioned in the audio recording?" | as above |
| 4 | Video w/ subs | New | `with-srt.mp4` | brain-upload | "What does the meeting recording say about budget?" | as above + assert chunk text contains the subtitle sentinel |
| 5 | Video w/ frame text | New | `with-frame-text.mp4` (new fixture) | brain-upload | "What text appears on screen in the slide deck?" | as above + assert chunk text contains the slide sentinel ("BUDGET KICKOFF" / "Q4 REVENUE TARGET" / "ONE HUNDRED THOUSAND") |
| 6 | Email | New | `with-pdf-attachment.eml` | brain-upload | "What's the figure in the email's attached proposal?" | as above + assert `--- Attachment: proposal.pdf ---` separator survived chunking |
| 7 | Archive | New | `simple.zip` | Nextcloud scan | "What does the note inside the zip say?" | as above + assert `--- Member: note.txt ---` separator survived chunking |
| 8 | Deferred ASR | New | `sample.wav` (re-used) | brain-upload as audio (lands in `status='queued_for_transcription'`) → `POST /api/files/brain/:id/transcribe-now` → wait for `status='ready'` | "What number is mentioned in the queued audio?" | as above + assert initial status was `queued_for_transcription` and post-transcribe-now is `ready` |

Loop count per flow: 5 runs (retrieval-chain determinism check).

## New fixture: `with-frame-text.mp4`

The only fixture WARP-208 didn't ship was a video where on-screen text is the *only* retrievable content (no audio, no subtitle stream). Required because flow #5 must isolate the frame-OCR code path — if the video has subtitles, the extractor takes the subtitle path and frame OCR never runs.

### Generation

PIL slides + ffmpeg in a Docker linux container (avoids the macOS-Homebrew ffmpeg-without-drawtext issue that bit WARP-208 Task 3.1):

```bash
# scripts/generate-frame-text-fixture.sh — sketch
docker run --rm -v "$(pwd):/work" -w /work python:3.12-slim \
  bash -c 'pip install Pillow && python -c "
from PIL import Image, ImageDraw, ImageFont
import os
for i, line in enumerate([\"BUDGET KICKOFF\", \"Q4 REVENUE TARGET\", \"ONE HUNDRED THOUSAND\"], start=1):
    im = Image.new(\"RGB\", (1280, 720), \"black\")
    d = ImageDraw.Draw(im)
    f = ImageFont.load_default(size=80)
    bbox = d.textbbox((0,0), line, font=f)
    d.text(((1280-bbox[2])/2, (720-bbox[3])/2), line, fill=\"white\", font=f)
    im.save(f\"/work/slide_{i}.png\")
"'
docker run --rm -v "$(pwd):/work" -w /work jrottenberg/ffmpeg:7-alpine \
  -y -framerate 0.6 -i slide_%d.png -c:v libx264 -t 5 -pix_fmt yuv420p \
  -an services/file-indexer/tests/fixtures/with-frame-text.mp4
rm slide_*.png
```

The script is committed so anyone can regenerate. The fixture itself is ~30-50 KB and committed to git. Three sentinel phrases give the test a clear text target.

### Why slides + concat instead of `drawtext`

`drawtext` requires ffmpeg built `--enable-libfreetype --enable-libfontconfig`. The Linux Docker image satisfies that, but committing the fixture means we never re-pay the build cost; only contributors regenerating the fixture need Docker, and they only need it once per fixture lifetime.

## Runbook section in `docs/RAG_TESTING.md`

New section titled **"Chat retrieval validation"** (functionality-first, no "phase 2/3"). Structure:

1. **What's tested** — the 8-flow table from above, with one column added: "Owner ticket" (WARP-201..208/218) so triagers can find the original spec quickly.
2. **How to run**:
   - `./scripts/test-rag.sh --only end-to-end` (single-flow filter).
   - Manual mode: vitest invocation with `RUN_RAG_INTEGRATION=1`.
3. **Triage matrix** — failure symptom → first service to check. Mirrors the existing "Reading failure modes" table style. Examples:
   - `search_content` not called → orchestrator agent loop or model not honoring the tool prompt
   - `search_content` called but zero hits → ai-gateway gRPC, embedding model, pgvector
   - Hit found but snippet empty → chunker, FileContentChunk write
   - Specific to flow #5 (frame OCR): chunks present but no `subtitle_source` containing `frame_ocr` → `VIDEO_FRAME_OCR_ENABLED` not set, or extractor regression
   - Specific to flow #8 (deferred ASR): `status` stuck at `queued_for_transcription` → MQTT broker, transcribe-now route, worker not picking up message
4. **Adding a new flow when a future extractor lands** — template snippet showing how to copy an existing flow, swap fixture + question + assertion, register the fixture in the table.
5. **The "5 runs in a row" rationale** — same as existing test header comment: retrieval determinism is a property of the chain (same chunks, same file, same sentinel) but free-text isn't.
6. **LLM-offline acceptance** — `stop_reason: "iteration_limit"` is acceptable as long as `search_content` was called and returned hits. Inherits from existing flow.

## Test file extension shape

Pseudo-skeleton (real code lives in the plan):

```ts
// tests/rag-end-to-end.integration.test.ts
describe.skipIf(!SHOULD_RUN)("rag end-to-end retrieval chain", () => {
  beforeAll(async () => { /* compose up + waitForOrchestratorHealth, unchanged */ });

  // existing flows
  it("PDF: agent calls search_content and cites sample.pdf", async () => { /* unchanged */ });
  it("PNG: agent calls search_content and cites sample.png", async () => { /* unchanged */ });

  // new flows (one it() per row in the table)
  it("Audio: agent cites sample.wav after sync brain-upload", async () => { /* ... */ });
  it("Video w/ subs: agent cites with-srt.mp4 via subtitle text", async () => { /* ... */ });
  it("Video w/ frame text: agent cites with-frame-text.mp4 via on-screen text", async () => { /* ... */ });
  it("Email: agent cites with-pdf-attachment.eml via nested PDF text", async () => { /* ... */ });
  it("Archive: agent cites simple.zip via member text", async () => { /* ... */ });
  it("Deferred ASR: transcribe-now path produces searchable transcript", async () => { /* ... */ });
});
```

Each `it()` runs the 5-loop retrieval determinism check, like the existing PDF/PNG tests.

## Reusable test helpers

To keep flow bodies under ~30 lines each, factor these helpers into the same test file (or a sibling `tests/helpers/rag-retrieval.ts`):

- `uploadBrainFile(buffer, filename, mime) → {itemId, status}`
- `uploadNextcloudFile(buffer, filename) → {fileId}`
- `pollUntilReady({brainId | fileId}, timeoutMs=120_000)`
- `chatAndAssertSearchHit({question, expectedFilePath, expectedSnippetSubstring?})` — runs the chat call, asserts `search_content` called with hits including `expectedFilePath`, snippet non-empty (and optionally contains a sentinel substring)

Helpers stay in the same workspace (`tests/`); no new package.

## Error handling

- **Compose stack boot failure** — abort beforeAll, surface the failure with the existing log-tar artifact path.
- **One flow fails, others pass** — vitest reports per-flow; Dev/CI surface which flow regressed without aborting siblings.
- **Frame-OCR fixture missing** — Skip flow #5 with `it.skip()` and a console warning naming `scripts/generate-frame-text-fixture.sh`. Don't leave the suite red just because the binary is gone.
- **`transcribe-now` returns 429** — Test treats as a transient failure and retries once after 60s (matches the WARP-218 retry-window). Two consecutive 429s = real bug, fail the flow.
- **LLM offline** — already handled by existing test's `stop_reason: "iteration_limit"` acceptance. Carry that pattern into the new flows.

## Testing the test

The new flows need their own quality bar:

- **Sentinel uniqueness** — every fixture's content must contain a phrase that's unlikely to appear in *any other* fixture, so a misrouted retrieval can't accidentally pass the assertion. Audited at fixture-creation time and asserted again in the test ("if `sample.wav` chunks contain the slide-deck sentinel, that's a fixture-collision bug, fail loudly").
- **Negative test** — one `it()` that uploads no files, asks a chat question, asserts `search_content` returns zero hits and the agent doesn't fabricate a source. Catches the "agent confidently makes things up" failure mode.

## Phasing (commits)

1. Sanity gate — run `./scripts/test-rag.sh` on `main`, capture report. (No commit.)
2. Generator script + new fixture — `scripts/generate-frame-text-fixture.sh` + `with-frame-text.mp4`. Single commit.
3. Test helpers — `tests/helpers/rag-retrieval.ts` if used. Single commit.
4. Six new test flows — one commit per flow (audio, video subs, video frame text, email, archive, deferred ASR), each TDD-style: red → minimal harness → green.
5. Negative test — one commit.
6. Runbook section in `docs/RAG_TESTING.md` — single commit.

Eight-ish commits total. Single PR.

## Open questions resolved during brainstorm

| Q | Resolution |
|---|---|
| Single test file vs. sibling? | Extend existing `rag-end-to-end.integration.test.ts`. Compose boot is the dominant cost; one file amortizes it. |
| Synthesize fixtures at runtime vs. commit? | Commit. User direction: tiny synthetic fixtures, all in git. |
| Naming convention | Functionality-first across all new files/sections/dirs. No "phase 2/3" terminology in this ticket's deliverables. Existing names already in git stay (don't churn). |
| Sanity-gate failure handling | Hard gate. If WARP-201 (text/image) regresses, fix that first as a blocker before adding new flows. |
| LLM-offline acceptance | Inherit from existing PDF/PNG flow: `stop_reason: "iteration_limit"` + `search_content` called and returned hits = pass. |
| Loop count | 5 runs per flow. Matches existing convention. |
| Sentinel uniqueness | Audit at fixture creation time + assert in tests so a misrouted retrieval can't pass. |
| Negative test | One flow asserts zero-hit + no-fabrication when nothing is indexed. |

## Acceptance criteria

- `./scripts/test-rag.sh` passes on `main` (sanity gate met).
- `tests/rag-end-to-end.integration.test.ts` runs 8 retrieval flows, all green.
- `services/file-indexer/tests/fixtures/with-frame-text.mp4` committed; sentinel text matches what flow #5 asserts.
- `scripts/generate-frame-text-fixture.sh` committed and executable; rerunning it on a contributor's machine reproduces an equivalent fixture (frame-text content equivalent, exact byte-equality not required).
- `docs/RAG_TESTING.md` "Chat retrieval validation" section renders cleanly and a fresh agent can run the suite from those instructions alone.
- All four PR-required workflows (file-indexer-tests, orchestrator-tests, mcp-server-tests, docker-build) still green.
- No regressions in existing e2e flows.
