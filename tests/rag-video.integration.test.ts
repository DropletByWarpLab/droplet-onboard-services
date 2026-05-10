/**
 * Video extractor — live integration test against the Compose stack
 * (WARP-198).
 *
 * Boots the relevant services (db, cache, broker, ai-gateway,
 * orchestrator, file-indexer), POSTs each fixture at
 * `POST /api/files/brain/upload`, then polls the FileContentChunk
 * table until the file-indexer has produced at least one chunk for
 * the BrainMemoryItem.
 *
 *   - `with-srt.mp4` — a 4-second clip muxing the WARP-197 sample.wav
 *     fixture with a `mov_text` subtitle stream containing
 *     "budget meeting kickoff" / "projecting q4 revenue at one
 *     hundred thousand". The indexer should pick the subtitle path
 *     and surface that text in chunk content.
 *   - `no-srt.mp4` — same audio + a testsrc video, no subtitle
 *     stream. The indexer should fall back to ffmpeg → audio
 *     extractor (faster-whisper). We don't assert specific transcript
 *     content because faster-whisper output isn't stable across
 *     versions / hardware; we just confirm chunks materialize.
 *
 * The plan template suggested asserting on `metadata.subtitle_source`
 * directly off FileContentChunk rows — but the chunk schema doesn't
 * carry an extractor-metadata column today. The extractor's
 * `subtitle_source` lives on the in-process ExtractedDoc only; the
 * persisted signal we have is the chunk text + warnings array. So
 * the asr_transcript test asserts chunk presence rather than a label.
 *
 * Skip behavior: requires `RUN_RAG_INTEGRATION=1`. Without it the
 * suite skips so unit-only test runs stay fast.
 *
 * Run locally:
 *   docker compose -f docker/docker-compose.yml up -d \
 *     db cache broker ai-gateway orchestrator file-indexer
 *   API_URL=http://localhost:3000 RUN_RAG_INTEGRATION=1 \
 *     npx vitest run tests/rag-video.integration.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { COMPOSE } from "./helpers/rag-retrieval";
const SHOULD_RUN = process.env.RUN_RAG_INTEGRATION === "1";
const API_URL = process.env.API_URL ?? "http://localhost:3000";

function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function shSilent(cmd: string): string {
  return execSync(cmd, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function dbQuery(sql: string): string {
  return shSilent(
    `${COMPOSE} exec -T db psql -U droplet -d droplet -t -A -c ${JSON.stringify(sql)}`,
  );
}

async function pollChunkText(
  brainItemId: string,
  timeoutMs = 180_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = dbQuery(
      `SELECT string_agg("text", ' ') FROM "FileContentChunk"
       WHERE "brainItemId" = '${brainItemId}' AND "source" = 'brain'`,
    );
    if (out && out.length > 0 && out !== "") return out;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return "";
}

async function uploadVideoFixture(
  fixtureRel: string,
  filename: string,
): Promise<string> {
  const fixturePath = path.resolve(__dirname, fixtureRel);
  const bytes = fs.readFileSync(fixturePath);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "video/mp4" }), filename);
  const res = await fetch(`${API_URL}/api/files/brain/upload`, {
    method: "POST",
    body: form,
  });
  expect(res.status).toBe(202);
  const data = (await res.json()) as { itemId: string; status: string };
  expect(data.itemId).toBeTruthy();
  return data.itemId;
}

describe.skipIf(!SHOULD_RUN)(
  "WARP-198 video extraction — live integration",
  () => {
    beforeAll(() => {
      sh(
        `${COMPOSE} up -d db cache broker ai-gateway orchestrator file-indexer`,
      );
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        try {
          dbQuery("SELECT 1");
          break;
        } catch {
          execSync("sleep 1");
        }
      }
    }, 180_000);

    it("extracts subtitle text when the video has an embedded subtitle stream", async () => {
      const itemId = await uploadVideoFixture(
        "../services/file-indexer/tests/fixtures/with-srt.mp4",
        "with-srt.mp4",
      );
      const combined = await pollChunkText(itemId);
      expect(combined.length).toBeGreaterThan(0);
      // The mov_text subtitle stream's first cue.
      expect(combined.toLowerCase()).toContain("budget meeting");
    }, 240_000);

    it("falls back to ASR when no subtitle stream is present", async () => {
      const itemId = await uploadVideoFixture(
        "../services/file-indexer/tests/fixtures/no-srt.mp4",
        "no-srt.mp4",
      );
      // Cold faster-whisper model load + transcription on CPU can take
      // up to 3 min on first run because the small.en weights have to
      // download. We give it the same generous budget the audio
      // integration test does.
      const combined = await pollChunkText(itemId, 180_000);
      expect(combined.length).toBeGreaterThan(0);
      // Don't assert specific phrases — whisper output isn't stable
      // across versions / hardware. The pipeline running end-to-end
      // is what we care about here.
    }, 240_000);
  },
);
