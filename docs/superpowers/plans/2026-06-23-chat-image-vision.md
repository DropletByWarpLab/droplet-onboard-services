# Chat Image Vision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the chat LLM actually see uploaded images (true multimodal vision), capability-aware across local + cloud models, with graceful OCR fallback.

**Architecture:** The file-indexer emits a normalized `vision.jpg` render per image. At chat time the orchestrator reads the render, base64-encodes it into OpenAI `image_url` content blocks on the current user message, and routes the turn to a vision-capable model (the selected one, else a configured local `VISION_MODEL`, else OCR fallback). The ai-gateway `ChatMessage.content` is widened to `str | list[ContentBlock]` and providers pass arrays through. Capability is owned by the gateway (cloud allow-list + Ollama `/api/show`) and looked up by the orchestrator via the cached models list.

**Tech Stack:** TypeScript (orchestrator/Express/Prisma, web-dashboard/Next), Python (ai-gateway/FastAPI/pydantic + LiteLLM/httpx, file-indexer/Pillow/psycopg2), PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-06-23-chat-image-vision-design.md`

**Refinements vs spec (intentional, within approved decisions):**
- Client→orchestrator request stays string-content + `attachments[itemId]`; the content union is internal (orchestrator type) + gateway + providers only.
- Auto-route target is the **local `VISION_MODEL`** only; cloud vision via explicit model selection (resolves the §13 privacy question — no silent off-box send, no orchestrator↔keystore coupling).
- Web-dashboard changes (thumbnail preview, vision badge) are polish; the feature works without them because image upload already sends `attachments`.

**New env vars:** `VISION_MODEL` (optional local vision model id), `VISION_MAX_IMAGES` (default 3), `VISION_RENDER_MAX_PX` (default 1024).

---

## File structure

- `services/ai-gateway/schemas.py` — `ContentBlock` union + `ModelInfo.capabilities`.
- `services/ai-gateway/capabilities.py` *(new)* — capability resolution (cloud allow-list + Ollama probe).
- `services/ai-gateway/providers/{openai_cloud,anthropic_cloud,ollama_local}.py` — preserve content arrays; report capabilities.
- `services/file-indexer/extractors/image.py` — produce normalized render bytes helper.
- `services/file-indexer/brain_ingest.py` — write `vision.jpg`, pass render flag to DB.
- `services/file-indexer/db.py` — set `hasVisionRender`.
- `apps/orchestrator/prisma/schema.prisma` + migration — `hasVisionRender` column.
- `apps/orchestrator/src/types/index.ts` — `ChatMessage.content` union + `ModelInfo.capabilities`.
- `apps/orchestrator/src/services/ai-gateway.client.ts` — capability lookup cache.
- `apps/orchestrator/src/services/vision-attachments.service.ts` *(new)* — build image content blocks (read render, base64, cap, dedup).
- `apps/orchestrator/src/routes/llm.ts` — vision routing decision + merge image blocks; keep OCR fallback.
- `apps/orchestrator/src/config.ts` — `VISION_MODEL`, `VISION_MAX_IMAGES`.
- `apps/orchestrator/src/services/model-readiness.service.ts` — pull `VISION_MODEL`.
- `docs/ENVIRONMENT.md`, `.env.example` — document env vars.

---

## Task 1: ai-gateway content-block schema

**Files:** Modify `services/ai-gateway/schemas.py`; Test `services/ai-gateway/tests/test_schemas_content_blocks.py` (new).

- [ ] **Step 1 — failing test**: content array accepted, total-content validator counts text only.
```python
from schemas import ChatRequest
def test_content_blocks_accepted():
    req = ChatRequest(model="gpt-4o", messages=[{"role":"user","content":[
        {"type":"text","text":"what is this?"},
        {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,AAAA"}}]}])
    assert isinstance(req.messages[0].content, list)
def test_total_content_counts_text_only():
    big = "x"*200
    ChatRequest(model="gpt-4o", messages=[{"role":"user","content":[
        {"type":"text","text":big},
        {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,"+("Q"*500000)}}]}])
```
- [ ] **Step 2 — run, expect fail** (`content` rejects list).
- [ ] **Step 3 — implement**: add blocks + union.
```python
class TextBlock(BaseModel):
    type: Literal["text"] = "text"
    text: str = Field(max_length=32_000)

class ImageUrl(BaseModel):
    url: str = Field(max_length=20_000_000)  # base64 data URL

class ImageUrlBlock(BaseModel):
    type: Literal["image_url"] = "image_url"
    image_url: ImageUrl

ContentBlock = TextBlock | ImageUrlBlock

class ChatMessage(BaseModel):
    role: Literal["system","user","assistant","tool"] = "user"
    content: str | list[ContentBlock] | None = Field(default=None)
    tool_calls: list[ToolCall] | None = None
    tool_call_id: str | None = None
```
Update `_validate_total_content` to count only text:
```python
def _text_len(c) -> int:
    if c is None: return 0
    if isinstance(c, str): return len(c)
    return sum(len(b.text) for b in c if isinstance(b, TextBlock))
# total = sum(_text_len(m.content) for m in self.messages)
```
(Drop the `max_length=32_000` on the str form into the union; keep total cap 128k.)
- [ ] **Step 4 — run, expect pass.**
- [ ] **Step 5 — commit** `feat(ai-gateway): allow multimodal content blocks in ChatMessage`.

## Task 2: ai-gateway capability registry + ModelInfo.capabilities

**Files:** Create `services/ai-gateway/capabilities.py`; Modify `schemas.py` (`ModelInfo`); Test `services/ai-gateway/tests/test_capabilities.py`.

- [ ] **Step 1 — failing test**:
```python
from capabilities import cloud_capabilities, ollama_capabilities_from_show
def test_cloud_vision_allowlist():
    assert cloud_capabilities("gpt-4o")["vision"] is True
    assert cloud_capabilities("claude-3-5-haiku-20241022")["vision"] is True
def test_ollama_show_vision():
    assert ollama_capabilities_from_show({"capabilities":["completion","vision"]})["vision"] is True
    assert ollama_capabilities_from_show({"details":{"families":["mllama"]}})["vision"] is True
    assert ollama_capabilities_from_show({"capabilities":["completion"]})["vision"] is False
```
- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — implement** `capabilities.py`:
```python
_CLOUD_VISION = {"gpt-4o","gpt-4o-mini","gpt-4-turbo"}
_CLOUD_VISION_PREFIX = ("claude-3-5-sonnet","claude-3-5-haiku","claude-sonnet-4","gpt-4o")
def cloud_capabilities(model: str) -> dict:
    v = model in _CLOUD_VISION or model.startswith(_CLOUD_VISION_PREFIX)
    return {"vision": v, "tools": True}
_VISION_FAMILIES = {"clip","mllama","llava","qwen2vl","qwen2.5vl"}
def ollama_capabilities_from_show(show: dict) -> dict:
    caps = show.get("capabilities") or []
    fams = ((show.get("details") or {}).get("families")) or []
    vision = ("vision" in caps) or any(f in _VISION_FAMILIES for f in fams)
    tools = ("tools" in caps) or False
    return {"vision": vision, "tools": tools}
```
Add to `ModelInfo`: `capabilities: dict | None = None` (additive).
- [ ] **Step 4 — run, expect pass.**
- [ ] **Step 5 — commit** `feat(ai-gateway): model capability registry (vision/tools)`.

## Task 3: providers preserve content arrays + report capabilities

**Files:** Modify `services/ai-gateway/providers/{openai_cloud,anthropic_cloud,ollama_local}.py`; Test `services/ai-gateway/tests/test_provider_message_shape.py`.

- [ ] **Step 1 — failing test** (cloud message builder keeps list content as dicts):
```python
from schemas import ChatMessage
from providers.openai_cloud import _to_litellm_messages  # new helper
def test_litellm_messages_preserve_blocks():
    msgs=[ChatMessage(role="user", content=[
        {"type":"text","text":"hi"},
        {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,AAAA"}}])]
    out=_to_litellm_messages(msgs)
    assert out[0]["content"][1]["type"]=="image_url"
    assert isinstance(out[0]["content"][1]["image_url"], dict)
```
- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — implement**: extract a shared helper used by both cloud providers:
```python
def _to_litellm_messages(messages):
    out=[]
    for m in messages:
        c = m.content
        if isinstance(c, list):
            c = [b.model_dump(exclude_none=True) for b in c]
        out.append({"role": m.role, "content": c})
    return out
```
Use it in both `openai_cloud.chat` and `anthropic_cloud.chat`. Ollama already uses `m.model_dump(exclude_none=True)` — no change for content. In each provider's `list_models`, set `capabilities=cloud_capabilities(id)` (cloud) and, for Ollama, resolve via a cached `/api/show` call → `ollama_capabilities_from_show` (best-effort; on error capabilities=None).
- [ ] **Step 4 — run, expect pass; run full ai-gateway suite** `npm run test:ai-gateway`.
- [ ] **Step 5 — commit** `feat(ai-gateway): pass multimodal content through providers + report caps`.

## Task 4: orchestrator types (content union + capabilities)

**Files:** Modify `apps/orchestrator/src/types/index.ts`.

- [ ] **Step 1 — implement** (no isolated test; covered by Task 7/8 tests). Add:
```ts
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentBlock[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning?: string;
  reasoning_content?: string;
}
export interface ModelInfo { /* existing */ capabilities?: { vision?: boolean; tools?: boolean }; }
```
- [ ] **Step 2 — typecheck** `cd apps/orchestrator && npx tsc --noEmit` (expect new union errors only where content is assumed string — fix those call sites to guard `typeof content === "string"`; persistence stores user text which remains string on inbound).
- [ ] **Step 3 — commit** `feat(orchestrator): multimodal ChatMessage content + ModelInfo caps`.

## Task 5: Prisma `hasVisionRender` column + migration

**Files:** Modify `apps/orchestrator/prisma/schema.prisma`; create migration; update `apps/orchestrator/test/setup.ts` Prisma mock if it enumerates columns/enums.

- [ ] **Step 1 — schema**: add to `BrainMemoryItem`:
```prisma
  hasVisionRender Boolean @default(false) // normalized vision.jpg exists on disk
```
- [ ] **Step 2 — migration**: `cd apps/orchestrator && npx prisma migrate dev --name brain_vision_render --create-only`, then verify SQL adds the column with default false; `npx prisma generate`.
- [ ] **Step 3 — run orchestrator suite** to confirm the global Prisma mock still loads (`npm run test:orchestrator`). If a column-shape mock breaks, update it.
- [ ] **Step 4 — commit** `feat(orchestrator): BrainMemoryItem.hasVisionRender column`.

## Task 6: file-indexer emits vision.jpg + sets flag

**Files:** Modify `services/file-indexer/extractors/image.py` (render helper), `services/file-indexer/brain_ingest.py` (write sibling + flag), `services/file-indexer/db.py` (set column); Test `services/file-indexer/tests/test_vision_render.py`.

- [ ] **Step 1 — failing test**: render helper downsizes + returns JPEG bytes.
```python
from PIL import Image
import io
from extractors.image import make_vision_render
def test_make_vision_render_downscales():
    img = Image.new("RGB",(4000,3000),(120,30,30))
    buf=io.BytesIO(); img.save(buf,"PNG")
    out = make_vision_render(buf.getvalue(), max_px=1024)
    r = Image.open(io.BytesIO(out))
    assert max(r.size) <= 1024 and r.format=="JPEG"
```
- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — implement** `make_vision_render(raw: bytes, max_px: int) -> bytes`: open via PIL, `ImageOps.exif_transpose`, convert RGB, thumbnail to `max_px`, save JPEG q=85. In `brain_ingest.handle_brain_uploaded`, for `is_image`, after reading bytes write `Path(path).parent/"vision.jpg"` and call `db.set_vision_render(item_id, True)` (new in `db.py`: `UPDATE "BrainMemoryItem" SET "hasVisionRender"=true WHERE id=%s`). Read `VISION_RENDER_MAX_PX` from env (default 1024). Non-fatal on failure (log + continue, flag stays false → OCR fallback).
- [ ] **Step 4 — run, expect pass; run indexer suite** (`cd services/file-indexer && pytest -q`).
- [ ] **Step 5 — commit** `feat(file-indexer): emit normalized vision.jpg render + set flag`.

## Task 7: orchestrator vision-attachments service

**Files:** Create `apps/orchestrator/src/services/vision-attachments.service.ts`; Test `apps/orchestrator/test/vision-attachments.service.test.ts`.

- [ ] **Step 1 — failing test** (build blocks from ready image items with renders; cap + dedup; ownership):
```ts
// mock prisma.brainMemoryItem.findMany → items with hasVisionRender, status ready
// mock fs read of vision.jpg → small buffer
// expect: returns ContentBlock[] image_url data URLs, capped at maxImages, deduped by itemId, ownership-filtered
```
- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — implement** `buildImageBlocks(prisma, userId, itemIds, { maxImages }) : Promise<ContentBlock[]>`:
  - `findMany({ where: { id: { in }, userId, status: ready, hasVisionRender: true } })`.
  - Order by client order, dedup by id, slice to `maxImages` (most recent first when from conversation set).
  - For each, read `dirname(storagePath)/vision.jpg` (guard via existing `isPathUnderUser`), base64 → `data:image/jpeg;base64,...`, push `{type:"image_url",image_url:{url}}`.
  - Return [] on any miss (caller falls back to OCR text).
- [ ] **Step 4 — run, expect pass.**
- [ ] **Step 5 — commit** `feat(orchestrator): vision-attachments image-block builder`.

## Task 8: orchestrator routing + merge in llm.ts

**Files:** Modify `apps/orchestrator/src/routes/llm.ts`, `apps/orchestrator/src/config.ts`, `apps/orchestrator/src/services/ai-gateway.client.ts`; Test `apps/orchestrator/test/llm-vision-routing.test.ts`.

- [ ] **Step 1 — failing test** for a pure routing helper `decideVisionRoute({ hasImages, selectedModel, selectedVision, visionModel, visionModelVision })`:
  - selected vision-capable → `{ model: selected, mode: "image" }`
  - not capable, VISION_MODEL vision-capable → `{ model: visionModel, mode: "image" }`
  - neither → `{ model: selected, mode: "ocr" }`
  - no images → `{ model: selected, mode: "none" }`
- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — implement**:
  - `config.ts`: add `vision: { model: env.VISION_MODEL ?? null, maxImages: int(env.VISION_MAX_IMAGES ?? 3) }`.
  - `ai-gateway.client.ts`: `getCapabilities(model): Promise<{vision,tools}|null>` backed by a TTL-cached `listModels()` lookup.
  - `llm.ts`: pure `decideVisionRoute(...)`; in the chat handler, when `attachments` include image MIMEs and userId present, gather candidate image itemIds (this turn + recent conversation image items capped at `maxImages`), look up capabilities, call `decideVisionRoute`. If `mode==="image"`, build blocks via `buildImageBlocks`, replace the latest user message's content with `[{type:text,text:<orig>}, ...blocks]`, and set the effective model for the agent run to the route's model. If `mode==="ocr"`, keep existing `buildAttachmentContext` path and append a one-line "this model can't view images; working from extracted text" note. `mode==="none"` unchanged.
  - Determine image MIME from the `BrainMemoryItem.mimeType` (`startsWith("image/")`).
- [ ] **Step 4 — run, expect pass; full orchestrator suite + tsc.**
- [ ] **Step 5 — commit** `feat(orchestrator): vision routing + image-block injection with OCR fallback`.

## Task 9: model-readiness pulls VISION_MODEL

**Files:** Modify `apps/orchestrator/src/services/model-readiness.service.ts`; extend its test.

- [ ] **Step 1 — failing test**: when `VISION_MODEL` set, readiness requests a pull for it in addition to `LLM_MODEL`.
- [ ] **Step 2 — run, expect fail.**
- [ ] **Step 3 — implement**: include `config.vision.model` (when non-null) in the set of models ensured/pulled at startup.
- [ ] **Step 4 — run, expect pass.**
- [ ] **Step 5 — commit** `feat(orchestrator): ensure VISION_MODEL is pulled at startup`.

## Task 10: config docs

**Files:** Modify `docs/ENVIRONMENT.md`, `.env.example`.

- [ ] **Step 1 — document** `VISION_MODEL`, `VISION_MAX_IMAGES`, `VISION_RENDER_MAX_PX` (purpose, default, which service reads each).
- [ ] **Step 2 — commit** `docs: document vision env vars`.

## Task 11 (polish): web-dashboard image preview + vision badge

**Files:** Modify `apps/web-dashboard/src/components/AttachmentChip.tsx` (or ChatInput), model picker; extend tests.

- [ ] **Step 1 — image thumbnail**: when an attachment's mime is `image/*`, render a small object-URL thumbnail in the chip.
- [ ] **Step 2 — vision badge**: in the model picker, badge models whose `capabilities.vision` is true (from `GET /llm/models`).
- [ ] **Step 3 — dashboard suite + tsc** (`npm run test --workspace web-dashboard` / `npx tsc --noEmit`).
- [ ] **Step 4 — commit** `feat(web-dashboard): image thumbnail preview + vision model badge`.

---

## Self-review

- **Spec coverage:** capability model → T2/T3; routing → T8; data flow render → T6; chat assembly + cap/dedup → T7/T8; gateway union → T1; providers → T3; prisma column → T5; config → T9/T10; OCR fallback → T8; web polish → T11. Privacy open-Q resolved by local-only auto-route (documented above). ✓
- **Placeholder scan:** each code step has concrete code/commands. ✓
- **Type consistency:** `ContentBlock` shape identical across schemas.py / types/index.ts; `capabilities {vision,tools}` consistent; `buildImageBlocks` / `decideVisionRoute` names stable. ✓
- **Test infra caveats:** orchestrator global Prisma mock (test/setup.ts) may need the new column/enum-free addition acknowledged (T5 Step 3); ai-gateway tests run via `npm run test:ai-gateway`.
