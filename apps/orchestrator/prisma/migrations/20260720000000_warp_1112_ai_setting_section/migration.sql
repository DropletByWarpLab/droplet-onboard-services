-- WARP-1112: add the `ai` SettingSection member so the active local model
-- choice can live in WorkspaceSetting (`ai.model.chat`). Managed from the
-- /models surface via PATCH /api/models/active — kept out of the generic
-- Settings route's SECTION_VALUES so the validated endpoint is the only writer.
--
-- AlterEnum
ALTER TYPE "SettingSection" ADD VALUE 'ai';
