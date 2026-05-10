/**
 * RAG end-to-end smoke (WARP-206) — proves the whole chain works
 * against a live Compose stack.
 *
 *   PDF (Nextcloud) ─┐
 *                    ├─→ file-indexer ─→ FileContentChunk + indexedAt
 *   PNG (brain)   ───┘
 *
 *   then: POST /api/llm/chat ─→ orchestrator agent loop ─→
 *         search_content (MCP, stdio) ─→ pgvector ─→ chunks
 *         ─→ trace[].result.results[] ─→ "citations"
 *
 * Skip-gated by `RUN_RAG_INTEGRATION=1` to match the rest of the RAG
 * suite. Without it the suite skips so the default unit run stays
 * fast.
 *
 * # On orchestrator reachability
 *
 * The production `docker/docker-compose.yml` does NOT publish the
 * orchestrator's port 3000 to the host (gateway:80 is the public
 * entry point). The integration tests assume `localhost:3000` works,
 * which is true only with the test override
 * `docker/docker-compose.test.override.yml` layered on top. The
 * `scripts/test-rag.sh` runner and the `rag-tests` GitHub Actions
 * workflow both apply that override; running these tests by hand
 * without it will fail with ECONNREFUSED at the first fetch().
 *
 * # On LLM determinism
 *
 * The default ai-gateway routes Ollama → the Jetson appliance, which
 * is unreachable on a CI runner / a developer laptop. We can't make
 * the agent loop emit deterministic prose either way, so we assert
 * the *retrieval* axis:
 *
 *   - the agent called search_content,
 *   - the call returned results pointing at the indexed file's path,
 *   - the matched chunk text is non-empty.
 *
 * This is the part the spec actually constrains. The model's free-
 * form answer can still vary turn-to-turn — that's an LLM property,
 * not a RAG one — but the citation chain is what we promised to
 * stabilize in §11 of `2026-04-28-rag-system-design.md`.
 *
 * # Determinism harness
 *
 * The "5 runs in a row" loop uses `it.each([1..5])` so a single run
 * still produces a useful failure label ("run #3 failed retrieval")
 * rather than a hard-to-bisect blob. We loop on retrieval (not on
 * the model output) for the reason above.
 *
 * Run locally:
 *   ./scripts/test-rag.sh
 * or:
 *   docker compose -f docker/docker-compose.yml \
 *     -f docker/docker-compose.test.override.yml \
 *     up -d db cache broker ai-gateway file-indexer mcp-server orchestrator nextcloud
 *   API_URL=http://localhost:3000 RUN_RAG_INTEGRATION=1 \
 *     npx vitest run tests/rag-end-to-end.integration.test.ts
 */

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
  transcribeNow,
  getBrainStatus,
  pollUntilBrainStatus,
} from "./helpers/rag-retrieval";

// The PDF fixture contains the unique sentinel "alphahotel" (see
// services/file-indexer/tests/test_extractors_pdf.py). The PNG fixture
// contains "echofoxtrot" (see test_extractors_image.py). We re-use
// these so we don't have to ship new fixtures for the e2e lane.
const PDF_FIXTURE = resolve(
  REPO_ROOT,
  "services/file-indexer/tests/fixtures/sample.pdf",
);
const PNG_FIXTURE = resolve(
  REPO_ROOT,
  "services/file-indexer/tests/fixtures/sample.png",
);
const PDF_SENTINEL = "alphahotel";
const PNG_SENTINEL = "echofoxtrot";
const NC_SUBDIR = "test-rag-end-to-end";

const WAV_FIXTURE = resolve(REPO_ROOT, "services/file-indexer/tests/fixtures/sample.wav");
// sample.wav speaks "the budget for q4 is one hundred thousand" in the
// existing WARP-197 fixture. We assert on the substring "hundred thousand"
// because faster-whisper output isn't byte-stable across model versions.
const WAV_SENTINEL = "hundred thousand";

const SUBS_VIDEO_FIXTURE = resolve(REPO_ROOT, "services/file-indexer/tests/fixtures/with-srt.mp4");
// with-srt.mp4 muxes the WARP-197 sample.wav with a mov_text subtitle
// stream containing "budget meeting kickoff" / "projecting q4 revenue
// at one hundred thousand". The video extractor takes the subtitle
// path (no ASR fallback). The unique 4-word phrase isolates THIS file
// from the audio file's transcript.
const SUBS_VIDEO_SENTINEL = "budget meeting kickoff";

const FRAME_VIDEO_FIXTURE = resolve(REPO_ROOT, "services/file-indexer/tests/fixtures/with-frame-text.mp4");
// with-frame-text.mp4 has NO audio + NO subtitle stream. Frame OCR
// is the only retrievable channel. Three on-screen slides:
const FRAME_VIDEO_SENTINEL = "BUDGET KICKOFF";
const FRAME_VIDEO_SECONDARY_SENTINEL = "ONE HUNDRED THOUSAND";

const EML_FIXTURE = resolve(REPO_ROOT, "services/file-indexer/tests/fixtures/with-pdf-attachment.eml");
// with-pdf-attachment.eml is the WARP-199 fixture: an email body that
// reads "Bob, see the attached PDF for the full proposal." plus a
// ReportLab-generated placeholder PDF attachment.
//
// We assert on the EMAIL BODY for citation (the embedded PDF is a
// placeholder with no meaningful text). The attachment-separator
// assertion proves the recursive dispatcher still walked into the PDF.
const EML_BODY_SENTINEL = "bob, see the attached pdf";
const EML_ATTACHMENT_SEPARATOR = "--- Attachment: ";

const ZIP_FIXTURE = resolve(REPO_ROOT, "services/file-indexer/tests/fixtures/simple.zip");
// simple.zip contains note.txt with "the budget for q4 is one hundred
// thousand" and more.txt with "second file" — see WARP-200. Indexed
// via the Nextcloud scan path (NOT brain-upload), exercising the same
// code path we use for archives uploaded via files.
const ZIP_BODY_SENTINEL = "the budget for q4";
const ZIP_MEMBER_SEPARATOR = "--- Member: ";
const NC_SUBDIR_ARCHIVE = "test-warp224-archive";

const DEFERRED_AUDIO_NAME = "warp224-deferred-audio.wav";
const DEFERRED_AUDIO_SENTINEL = "hundred thousand"; // same fixture as Task 3, distinguished by upload name

// A unique nonsense token. If any chunk text contains this, a
// fixture leak has happened — fail loudly.
const NEGATIVE_SENTINEL = "zzzqqqxxx-nonexistent-token-warp224";

describe.skipIf(!SHOULD_RUN)(
  "RAG end-to-end smoke — Nextcloud + brain → /api/llm/chat (WARP-206)",
  () => {
    let brainItemId: string | null = null;
    let audioItemId: string | null = null;
    let subsVideoItemId: string | null = null;
    let frameVideoItemId: string | null = null;
    let emailItemId: string | null = null;
    let deferredItemId: string | null = null;

    beforeAll(async () => {
      // Bring up the full chain. mcp-server is a sibling Compose
      // service on `main` — see docker/docker-compose.yml lines 130+.
      // It's the network-surface MCP transport; the orchestrator's
      // in-process agent uses the stdio child it spawns itself, but
      // the service still needs to be in the dependency graph so
      // `depends_on: db` waits hold.
      sh(
        `${COMPOSE} up -d db cache broker ai-gateway file-indexer mcp-server orchestrator nextcloud`,
      );

      // Wait for DB.
      const dbDeadline = Date.now() + 60_000;
      while (Date.now() < dbDeadline) {
        try {
          dbQuery("SELECT 1");
          break;
        } catch {
          execSync("sleep 1");
        }
      }

      // Wait for Nextcloud's bootstrap (occ status returns 0). On a
      // cold boot this is the long pole — 2-3 minutes is normal.
      const ncDeadline = Date.now() + 240_000;
      while (Date.now() < ncDeadline) {
        try {
          sh(
            `${COMPOSE} exec -T -u www-data nextcloud php /var/www/html/occ status`,
          );
          break;
        } catch {
          execSync("sleep 2");
        }
      }

      // Wait for orchestrator's API health. Without this the first
      // fetch races the ExpressJS startup and 502s through the bridge.
      const orchDeadline = Date.now() + 90_000;
      while (Date.now() < orchDeadline) {
        try {
          const r = await fetch(`${API_URL}/api/orchestrator/health`);
          if (r.ok) break;
        } catch {
          /* connection refused while booting */
        }
        await new Promise((r) => setTimeout(r, 1500));
      }

      // ─── Step 1: drop a PDF into Nextcloud's admin user files dir ───
      await uploadNextcloudFile(PDF_FIXTURE, NC_SUBDIR);

      // ─── Step 2: upload a PNG via the brain-upload API ───
      const upJson = await uploadBrainFile(
        PNG_FIXTURE,
        "warp206-image.png",
        "image/png",
      );
      brainItemId = upJson.itemId;

      // ─── Step 3: poll for indexedAt + chunk rows on both ───
      // Generous timeouts: cold-boot Tesseract OCR + pgvector embed +
      // chunk insert can take 30-60s under load.
      const ncOk = await pollNcChunkCount(
        `%${NC_SUBDIR}/sample.pdf`,
        180_000,
      );
      if (ncOk === 0) {
        throw new Error(
          "Nextcloud PDF never produced FileContentChunk rows — check file-indexer logs",
        );
      }
      const brainOk = await pollUntilBrainIndexed(brainItemId, 180_000);
      if (!brainOk) {
        throw new Error(
          `Brain item ${brainItemId} never indexed — check file-indexer + ai-gateway logs`,
        );
      }

      // ─── Audio brain-upload (chat-attachment path; deferred per WARP-218) ───
      const wavUp = await uploadBrainFile(WAV_FIXTURE, "warp224-audio.wav", "audio/wav");
      audioItemId = wavUp.itemId;
      expect(
        wavUp.status,
        "audio uploads must land in queued_for_transcription per WARP-218",
      ).toBe("queued_for_transcription");
      const wavTxCode = await transcribeNow(audioItemId);
      expect(wavTxCode, `transcribe-now for audio returned ${wavTxCode}`).toBe(202);
      const audioOk = await pollUntilBrainIndexed(audioItemId, 240_000);
      if (!audioOk) {
        throw new Error(`Audio brain item ${audioItemId} never indexed — check file-indexer + ai-gateway logs`);
      }

      // ─── Video w/ subtitles brain-upload (deferred per WARP-218; force via transcribe-now) ───
      const subsVidUp = await uploadBrainFile(
        SUBS_VIDEO_FIXTURE,
        "warp224-video-subs.mp4",
        "video/mp4",
      );
      subsVideoItemId = subsVidUp.itemId;
      expect(
        subsVidUp.status,
        "video uploads must land in queued_for_transcription per WARP-218",
      ).toBe("queued_for_transcription");
      const subsTxCode = await transcribeNow(subsVideoItemId);
      expect(subsTxCode, `transcribe-now for video-subs returned ${subsTxCode}`).toBe(202);
      const subsVideoOk = await pollUntilBrainIndexed(subsVideoItemId, 240_000);
      if (!subsVideoOk) {
        throw new Error(
          `Video-w/-subs item ${subsVideoItemId} never indexed — check file-indexer logs`,
        );
      }

      // ─── Video w/ frame OCR brain-upload (WARP-208) (deferred per WARP-218; force via transcribe-now) ───
      // The file-indexer needs VIDEO_FRAME_OCR_ENABLED=1 in its env for
      // this flow's frame-OCR text to land in chunks. The test override
      // (docker/docker-compose.test.override.yml) sets it for this lane.
      const frameVidUp = await uploadBrainFile(
        FRAME_VIDEO_FIXTURE,
        "warp224-video-frame.mp4",
        "video/mp4",
      );
      frameVideoItemId = frameVidUp.itemId;
      expect(
        frameVidUp.status,
        "video uploads must land in queued_for_transcription per WARP-218",
      ).toBe("queued_for_transcription");
      const frameTxCode = await transcribeNow(frameVideoItemId);
      expect(frameTxCode, `transcribe-now for video-frame returned ${frameTxCode}`).toBe(202);
      const frameVideoOk = await pollUntilBrainIndexed(frameVideoItemId, 300_000);
      if (!frameVideoOk) {
        throw new Error(
          `Video-frame item ${frameVideoItemId} never indexed — frame OCR may be off (VIDEO_FRAME_OCR_ENABLED) or extractor regressed`,
        );
      }

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

      // ─── Archive Nextcloud-scan (WARP-200) ───
      await uploadNextcloudFile(ZIP_FIXTURE, NC_SUBDIR_ARCHIVE);
      const zipOk = await pollNcChunkCount(`%${NC_SUBDIR_ARCHIVE}/simple.zip`, 240_000);
      if (zipOk === 0) {
        throw new Error("Archive simple.zip never produced FileContentChunk rows — check file-indexer logs");
      }

      // ─── Deferred-ASR brain-upload (WARP-218) — explicit status-sequence flow ───
      const deferredUp = await uploadBrainFile(WAV_FIXTURE, DEFERRED_AUDIO_NAME, "audio/wav");
      deferredItemId = deferredUp.itemId;

      // Confirm initial status BEFORE transcribe-now (this is what makes the
      // deferred-flow assertion distinct from Task 3's audio flow).
      const initialStatus = getBrainStatus(deferredItemId);
      expect(
        initialStatus,
        "deferred audio should land in queued_for_transcription before transcribe-now",
      ).toBe("queued_for_transcription");

      // Promote to immediate processing.
      const txCode = await transcribeNow(deferredItemId);
      expect(txCode, `transcribe-now for deferred audio returned ${txCode}`).toBe(202);

      // Wait for the worker to flip status -> indexing -> ready.
      const finalStatus = await pollUntilBrainStatus(deferredItemId, "ready", 240_000);
      expect(
        finalStatus,
        `deferred audio never reached 'ready' (last seen: ${finalStatus})`,
      ).toBe("ready");

      // And confirm chunks landed.
      const chunkOk = await pollUntilBrainIndexed(deferredItemId, 60_000);
      expect(chunkOk, "deferred audio reached 'ready' but no chunks").toBe(true);

      // ─── Sentinel uniqueness audit ───
      // If any indexed chunk contains the negative sentinel, the negative
      // test below would silently pass against a hit — defeating the whole
      // point. Fail loudly so the next dev picks a different token.
      const leak = dbQuery(
        `SELECT count(*) FROM "FileContentChunk" WHERE "text" ILIKE '%${NEGATIVE_SENTINEL}%'`,
      );
      expect(
        Number.parseInt(leak, 10),
        "negative sentinel leaked into a fixture — pick a different token",
      ).toBe(0);
    }, 600_000); // 10 min ceiling — Nextcloud cold-boot + OCR + embed

    afterAll(async () => {
      try {
        sh(
          `${COMPOSE} exec -T nextcloud rm -rf ${NC_DATA_DIR}/${NC_SUBDIR}`,
        );
      } catch {
        /* swallow */
      }
      try {
        sh(`${COMPOSE} exec -T nextcloud rm -rf ${NC_DATA_DIR}/${NC_SUBDIR_ARCHIVE}`);
      } catch {
        /* swallow */
      }
      // Don't `compose down` here — the runner / CI step owns
      // teardown so artifacts (logs) can be captured first.
    });

    it("agent retrieval reaches the Nextcloud-indexed PDF", async () => {
      const resp = await chat(
        `Search my documents for the unique token "${PDF_SENTINEL}". What does the document containing it say?`,
      );

      expect(resp.error).toBeUndefined();
      // The agent loop should produce some prose, even if the model
      // is off-line and the message is empty (iteration_limit). Don't
      // require a non-empty content string — the model's free-form
      // output isn't the contract this test enforces.
      expect(resp.message).toBeDefined();

      const hits = citationsFrom(resp);
      expect(hits.length).toBeGreaterThan(0);
      // PDF citation MUST point at the file we just indexed (prefix
      // match for the Nextcloud /admin/files/... layout).
      const pdfHit = hits.find(
        (h) =>
          h.path.includes(NC_SUBDIR) && h.path.toLowerCase().endsWith(".pdf"),
      );
      expect(pdfHit, `no citation for ${NC_SUBDIR}/sample.pdf`).toBeDefined();
      expect(pdfHit!.text.length).toBeGreaterThan(0);
      // The chunk's text should actually contain the sentinel — this
      // is the proof that retrieval (not just listing) worked.
      expect(pdfHit!.text.toLowerCase()).toContain(PDF_SENTINEL);
    }, 120_000);

    it("agent retrieval reaches the brain-uploaded PNG (OCR path)", async () => {
      const resp = await chat(
        `Search my documents for the token "${PNG_SENTINEL}" — it should be from an image. What does the image contain?`,
      );

      expect(resp.error).toBeUndefined();
      const hits = citationsFrom(resp);
      expect(hits.length).toBeGreaterThan(0);
      // Brain items live under a per-user path. The chat path doesn't
      // resolve to /admin/files/... — match the filename stem instead.
      const pngHit = hits.find((h) => h.path.toLowerCase().includes("warp206-image"));
      expect(pngHit, "no citation for warp206-image.png").toBeDefined();
      expect(pngHit!.text.length).toBeGreaterThan(0);
      expect(pngHit!.text.toLowerCase()).toContain(PNG_SENTINEL);
    }, 120_000);

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

    it("agent retrieval reaches an email's body and walks into the attached PDF (WARP-199)", async () => {
      const resp = await chat(
        `Search my email for "Bob, see the attached PDF". What does the email say?`,
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

    // Determinism harness — see header comment. We loop on retrieval
    // because that's the part the spec constrains. The model's prose
    // is allowed to vary across runs; it just has to keep calling
    // search_content and getting back the same chunks.
    it.each([1, 2, 3, 4, 5])(
      "retrieval stays deterministic across run #%i (PDF citation)",
      async (run) => {
        const resp = await chat(
          `Tell me about "${PDF_SENTINEL}" from my documents.`,
        );
        const hits = citationsFrom(resp);
        expect(
          hits.length,
          `run #${run}: agent did not call search_content or got no hits`,
        ).toBeGreaterThan(0);
        const pdfHit = hits.find(
          (h) =>
            h.path.includes(NC_SUBDIR) && h.path.toLowerCase().endsWith(".pdf"),
        );
        expect(
          pdfHit,
          `run #${run}: PDF citation missing — retrieval is flaky`,
        ).toBeDefined();
        expect(pdfHit!.text.toLowerCase()).toContain(PDF_SENTINEL);
      },
      120_000,
    );

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
  },
);
