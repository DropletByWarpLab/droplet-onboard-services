# Chat image vision — design

- **Date:** 2026-06-23
- **Status:** Approved (design); pending implementation plan
- **Topic:** Let the chat LLM actually *see* uploaded images (true multimodal vision),
  capability-aware across local and cloud models, with graceful OCR fallback.
- **WARP ticket:** _to be created_ (track implementation under a dedicated WARP ticket)
- **Related:** `docs/ADR-027-files-sharepoint-parity.md`,
  `docs/superpowers/specs/2026-05-09-warp-208-frame-ocr-design.md` (image OCR),
  `docs/superpowers/specs/2026-05-08-warp-218-deferred-asr-design.md`
  (`BrainMemoryItemStatus` enum / explicit-column pattern).

---

## 1. Problem

Today an uploaded image is **never sent to the model as pixels.** The chat stack is
`content: string` end to end:

- web-dashboard `ChatRequest.messages[].content: string`; images upload via a
  *separate* `POST /api/files/brain/upload` and the chat carries only
  `attachments: [{ itemId }]`.
- orchestrator zod schema `content: z.string()` (`apps/orchestrator/src/routes/llm.ts`).
- ai-gateway pydantic `content: str | None` (`services/ai-gateway/schemas.py`).
- all three providers flatten messages to `{role, content}` strings.

Images are handled by a parallel text-extraction pipeline: the file-indexer runs
**Tesseract OCR** (`services/file-indexer/extractors/image.py`); at chat time
`buildAttachmentContext` inlines the extracted text as a system message. A textless
photo/diagram yields **no OCR text** → zero `FileContentChunk` rows → the model
receives only:

```
[1] "photo.jpg" (image/jpeg) — no inlined content (no text could be extracted).
```

That is the reported symptom: *"the LLM sees the image upload but can't act on it."*
True visual understanding ("what's in this picture?", "read this chart") is
impossible regardless of model, because the bytes never leave the upload/index
pipeline and any non-string content block is discarded at the gateway schema.

## 2. Goals

- The chat model can **see** an uploaded image (real vision), not just OCR text.
- **Capability-aware** across **both** local (Ollama) and cloud (OpenAI/Anthropic).
- **Auto-route** image turns to a vision-capable model; **OCR fallback** when none.
- **Persist** images across a conversation, **capped** at the most recent N.
- One generic image representation that works for every provider.

## 3. Non-goals

- Video / audio multimodal input (the content union leaves room, but out of scope here).
- Image *generation*.
- Lazy back-fill of vision renders for images uploaded before this feature ships
  (those fall back to OCR text).
- Fixing the ai-gateway cloud **streaming** tools-drop bug (`_stream_chat` in
  `openai_cloud.py` / `anthropic_cloud.py` omits `tools`). It is real but unrelated:
  the agent loop calls the gateway with `stream: false`
  (`apps/orchestrator/src/services/llm-agent.service.ts:437`), where tools *are*
  forwarded. Noted here so it isn't conflated with this work; tracked separately.

## 4. Decisions (settled during brainstorming)

1. **Scope:** both local + cloud, capability-aware.
2. **Fallback:** auto-route to a vision model (prefer local → cloud-BYOK), else OCR text + notify.
3. **Persistence:** re-send images on later turns, capped at the most recent N (`VISION_MAX_IMAGES`).
4. **Transport:** Approach A — widen `content` to the canonical OpenAI multimodal union
   (`string | ContentBlock[]`) at every layer; only *produce* arrays for image-bearing
   user turns so existing string paths are undisturbed.
5. **Image normalization:** the file-indexer emits a downscaled `vision.jpg` render;
   the orchestrator base64-encodes it into a data URL at chat time.

## 5. Architecture

```
                upload (unchanged)                index (new: vision render)
  browser ───────────────────────► orchestrator ──MQTT──► file-indexer
   │  POST /api/files/brain/upload    writes original       OCR + writes vision.jpg,
   │                                   bytes to disk        sets hasVisionRender (psycopg2)
   │
   │  POST /api/llm/chat  { messages, attachments:[{itemId}] }
   ▼
 orchestrator (routes/llm.ts)
   • resolve vision capability of selected model (via gateway capability info)
   • gather current + recent conversation image items (cap N, dedup)
   • read each vision.jpg → base64 data URL
   • build current user message as ContentBlock[]   (text + image_url blocks)
   • route turn to a vision model (selected → VISION_MODEL → cloud-BYOK) or OCR-fallback
   ▼  stream:false, content can be ContentBlock[]
 ai-gateway (/ai/chat)
   • ChatMessage.content: str | list[ContentBlock]  (pass-through, no flattening)
   • capability registry → ModelInfo.capabilities
   ▼
 provider (litellm cloud  |  ollama OpenAI-compat /v1/chat/completions)
```

The OpenAI content-array shape is consumed natively by **both** LiteLLM (cloud) and
Ollama's OpenAI-compat endpoint, so one representation serves all providers. LiteLLM
translates OpenAI `image_url` → Anthropic image blocks automatically.

## 6. Capability model

The ai-gateway is the source of truth.

- A capability registry resolves `{ vision: bool, tools: bool }` per model id.
  - **Cloud:** hardcoded allow-list. Vision-capable: `gpt-4o`, `gpt-4o-mini`,
    `gpt-4-turbo`, `claude-sonnet-4-*`, `claude-3-5-sonnet-*`, `claude-3-5-haiku-*`.
  - **Local (Ollama):** query `/api/show` — its `capabilities` array reports
    `"vision"` for multimodal models; fall back to a `details.families` heuristic
    (`clip` / `mllama`). Cache per model id.
- `ModelInfo` gains an optional `capabilities: { vision, tools }` (pydantic in the
  gateway, mirrored in `apps/orchestrator/src/types/index.ts`). This finally
  populates the **already-stubbed** `role`/capabilities field in
  `models-summary.service.ts`, so `GET /llm/models` and the dashboard picker can
  badge vision-capable models. Field is additive/back-compatible.

## 7. Routing decision (orchestrator, per turn)

When a chat request has image attachments (current turn or recent conversation
images within the cap):

1. Look up the selected model's vision capability.
2. **Selected model is vision-capable** → use it; attach image blocks.
3. **Not capable** → choose a vision model by policy:
   - configured local `VISION_MODEL` (pulled at startup like `LLM_MODEL`, and ready); else
   - a cloud vision model **only if the user has a BYOK key** for that provider; else
   - none.
4. A vision model found → route **this turn** to it (the user's selected model is
   unchanged for subsequent text-only turns).
5. **None available** → OCR fallback: existing `buildAttachmentContext` text injection
   plus a one-line note that the image could not be viewed by the current model.

Tools are forwarded as today. A local vision model lacking tool support simply won't
emit tool calls (degraded, not blocked) — see Risks.

## 8. Data flow detail

1. **Upload** (unchanged): bytes at `/data/brain-memory/<userId>/<itemId>/original.<ext>`;
   orchestrator publishes `droplet/files/brain/uploaded` with `path`.
2. **Indexer** (new): for image MIME, in addition to OCR, write a normalized
   **`vision.jpg`** sibling — `Path(storagePath).parent / "vision.jpg"` — that is
   EXIF-rotated, downscaled to a max longest side (~1024px), re-encoded JPEG (q≈85),
   using Pillow (already a dependency; handles HEIC/TIFF/WebP). Set a new
   `BrainMemoryItem.hasVisionRender = true` via the existing direct-psycopg2 write
   path (`services/file-indexer/db.py`, alongside `mark_brain_item_indexed`).
   Textless photos still reach `status='ready'` (existing `image_only` path) but now
   carry a usable render.
3. **Chat time** (orchestrator):
   - Collect image `BrainMemoryItem`s for the turn: current-turn attachments that are
     images **+** recent conversation image items, capped at `VISION_MAX_IMAGES`
     (most recent first, dedup by `itemId`). Ownership enforced by `userId` filter,
     as today.
   - For each with `hasVisionRender`, read `vision.jpg`, base64 →
     `data:image/jpeg;base64,…`.
   - Build the **current** user message as `ContentBlock[]`:
     `[{type:"text", text: userText}, {type:"image_url", image_url:{url: dataUrl}}, …]`.
     (Re-sending recent images on the current message is what makes follow-ups in
     later turns work, while the cap bounds token cost.)
   - Non-image attachments (PDFs/docs) keep the existing OCR/text system-message path.
   - If routing chose OCR fallback, images go through the text path instead.
4. **Gateway:** `content` accepts `str | list[ContentBlock]`; pass-through.
5. **Providers:** stop flattening — preserve the content array (e.g. via
   `model_dump(exclude_none=True)` rather than `{"role":…, "content": m.content}`).

## 9. Component changes by layer

**web-dashboard**
- `src/lib/types.ts`: `content` union on `ChatRequest` messages (and `ChatMessage`).
- composer: image **thumbnail preview** (extend `AttachmentChip.tsx` / `ChatInput.tsx`).
- model picker: light **vision badge** from `capabilities` (optional, low-cost).

**orchestrator**
- `prisma/schema.prisma`: add `hasVisionRender Boolean @default(false)` to
  `BrainMemoryItem` + migration. (Explicit column — no guessing, per CLAUDE.md.)
- `routes/llm.ts`: content union in zod; vision routing decision; capped image-block
  assembly helper (`buildVisionContent` / merge into current user message); preserve
  OCR fallback.
- `types/index.ts`: `ChatMessage` content union; `ModelInfo.capabilities`.
- `services/ai-gateway.client.ts`: type pass-through (no wire-shape change beyond union).
- `services/model-readiness.service.ts`: also pull `VISION_MODEL` when configured.
- read renders via existing `brain-memory.service.ts` path helpers
  (`isPathUnderUser`, item-dir convention).

**ai-gateway**
- `schemas.py`: `ContentBlock` models (`text`, `image_url`); `content: str | list[...]`;
  total-content validator counts text parts only, plus an image count/size cap;
  `ModelInfo.capabilities`.
- capability registry module (cloud allow-list + Ollama `/api/show` probe + cache).
- `providers/openai_cloud.py`, `anthropic_cloud.py`, `ollama_local.py`: stop flattening;
  pass content arrays; report `capabilities` in `list_models`.

**file-indexer**
- image extractor / `brain_ingest.py`: produce `vision.jpg` for image MIME.
- `db.py`: set `hasVisionRender` in the same SQL path that marks the item ready.

## 10. Configuration (new env vars)

- `VISION_MODEL` (optional) — preferred local vision model id to pull and auto-route to
  (e.g. a llama3.2-vision / llava tag). Empty → no local vision; rely on cloud-BYOK.
- `VISION_MAX_IMAGES` (default e.g. `3`) — cap on images re-sent per request.
- `VISION_RENDER_MAX_PX` (default e.g. `1024`) — indexer downscale longest side.

All documented in `docs/ENVIRONMENT.md` and `.env.example`.

## 11. Error handling & edge cases

- **No render** (pre-feature items, or render failed) → OCR fallback + note. No lazy
  regeneration in v1.
- **Too many / too large** → capped at `VISION_MAX_IMAGES`; downscale bounds per-image
  size; oldest dropped from the set.
- **Format** → HEIC/TIFF/WebP normalized to JPEG by the indexer; providers never get
  raw HEIC. Animated/multi-frame: first frame only.
- **Model claims vision but provider 4xx** → surface gateway error as today.
- **Capability probe fails** (Ollama `/api/show` unreachable) → treat model as
  non-vision (conservative) → OCR fallback.
- **Privacy:** auto-routing an image to a **cloud** model sends it off-box. Policy
  prefers local and reaches cloud only when the user already has a cloud BYOK key
  (treated as the consent signal). _Open question (§13): whether to gate cloud image
  auto-route behind an explicit "allow cloud for images" toggle._

## 12. Testing & success criteria

**Success scenario:** upload a textless photo; ask "what's in this image?" with a
vision model available → the model describes it. With none available → graceful
OCR-fallback note. A follow-up several turns later still references the image
(capped persistence holds).

- **Unit**
  - gateway: `ChatMessage` accepts content arrays; rejects malformed blocks;
    total-content validator (text-only) + image cap; capability registry returns
    correct `vision` flags for known cloud ids and mocked Ollama `/api/show`;
    providers preserve arrays (mock litellm / httpx).
  - orchestrator: routing decision table (selected-vision / `VISION_MODEL` /
    cloud-BYOK / none); image assembly (merge + cap + dedup + ownership);
    OCR fallback path unchanged; zod accepts the union.
  - indexer: image extract writes `vision.jpg` at expected dims/format and sets
    `hasVisionRender`; non-image MIME untouched.
- **Integration:** fake provider asserts the outbound payload carries `image_url`
  blocks for a vision route; asserts text-only for the fallback route.
- **Regression:** existing text chat + document-OCR attachment path unchanged
  (guard against the content-union refactor regressing string call sites).

## 13. Open questions

- **Cloud image consent:** require an explicit per-conversation / per-user
  "allow cloud for images" toggle before auto-routing an image to a cloud model,
  or treat "has BYOK key" as sufficient consent? (Default in this design: BYOK key
  = consent. Revisit during planning if a stricter posture is wanted.)
- **`VISION_MODEL` default:** ship with a specific local vision model pulled by
  default on capable hardware, or leave empty (cloud-only until configured)?
  Cross-repo (`droplet-local-LLM`) coordination if defaulted.

## 14. Risks

- **Content-union blast radius:** every site assuming `content: string`
  (persistence, char-budgeting, history replay, logging) must tolerate arrays.
  Mitigation: only produce arrays for image-bearing user turns; audit + regression tests.
- **Local vision + tools:** a local vision model may not support tool calling; image
  turns routed to it lose tool use. Capability registry tracks `tools` too; behavior
  is degraded, not broken.
- **Token cost on the edge box:** base64 images inflate ~33%; the cap + downscale
  bound it, but multiple large images on a small local context window are still heavy.
