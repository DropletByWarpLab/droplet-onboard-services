#!/usr/bin/env node
/**
 * Codegen: schemas/anchor.schema.json → Pydantic v2 + Zod/TS.
 *
 * Hand-rolled generator (not jsonschema-to-zod) so the output is
 * deterministic and free of cosmetic churn. The drift test re-runs
 * this script and byte-compares; any churn = test failure.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const args = process.argv.slice(2);
const outDirIdx = args.indexOf("--out-dir");
const PY_OUT = outDirIdx >= 0
  ? join(args[outDirIdx + 1], "anchor_schema.py")
  : join(ROOT, "services/file-indexer/anchor_schema.py");
const TS_OUT = outDirIdx >= 0
  ? join(args[outDirIdx + 1], "anchor.ts")
  : join(ROOT, "packages/shared-types/src/anchor.ts");

const SCHEMA_PATH = join(ROOT, "schemas/anchor.schema.json");
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));

const PY = `"""Generated from schemas/anchor.schema.json. DO NOT EDIT.

Regenerate via \`npm run gen:anchor-schema\` from the repo root.
"""
from __future__ import annotations

from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_ARCHIVE_ANCHOR_DEPTH = 3


class PdfPageAnchor(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["pdf-page"] = "pdf-page"
    page: int = Field(..., ge=1)


class MediaTimestampAnchor(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["media-timestamp"] = "media-timestamp"
    startMs: int = Field(..., ge=0)
    endMs: int = Field(..., ge=1)

    # Cross-field invariant: endMs > startMs (strict). JSON Schema 2020-12
    # can't express this; enforced here and in the Zod schema via .refine().
    @model_validator(mode="after")
    def _check_end_after_start(self) -> "MediaTimestampAnchor":
        if self.endMs <= self.startMs:
            raise ValueError("endMs must be strictly greater than startMs")
        return self


class EmailPartAnchor(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["email-part"] = "email-part"
    messageId: str = Field(..., min_length=1)
    partIndex: int = Field(..., ge=0)


class ArchiveMemberAnchor(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["archive-member"] = "archive-member"
    member: str = Field(..., min_length=1)
    innerAnchor: Optional["Anchor"] = None


class NoneAnchor(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["none"] = "none"


Anchor = Annotated[
    Union[
        PdfPageAnchor,
        MediaTimestampAnchor,
        EmailPartAnchor,
        ArchiveMemberAnchor,
        NoneAnchor,
    ],
    Field(discriminator="kind"),
]

ArchiveMemberAnchor.model_rebuild()
`;

const TS = `// Generated from schemas/anchor.schema.json. DO NOT EDIT.
// Regenerate via \`npm run gen:anchor-schema\` from the repo root.
import { z } from "zod";

export const MAX_ARCHIVE_ANCHOR_DEPTH = 3;

export const PdfPageAnchorSchema = z.object({
  kind: z.literal("pdf-page"),
  page: z.number().int().min(1),
});

// Cross-field invariant: endMs > startMs (strict). JSON Schema 2020-12 can't
// express this; enforced here via .refine() and in Pydantic via @model_validator.
// .refine() turns the schema into a ZodEffects, which is incompatible with
// z.discriminatedUnion — AnchorSchema below uses z.union for that reason.
export const MediaTimestampAnchorSchema = z.object({
  kind: z.literal("media-timestamp"),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(1),
}).refine((d) => d.endMs > d.startMs, {
  message: "endMs must be strictly greater than startMs",
  path: ["endMs"],
});

export const EmailPartAnchorSchema = z.object({
  kind: z.literal("email-part"),
  messageId: z.string().min(1),
  partIndex: z.number().int().min(0),
});

export const NoneAnchorSchema = z.object({
  kind: z.literal("none"),
});

// Archive recursion: typed via z.lazy. Depth cap is a runtime invariant.
type ArchiveMemberAnchor = {
  kind: "archive-member";
  member: string;
  innerAnchor?: Anchor | null;
};

export const ArchiveMemberAnchorSchema: z.ZodType<ArchiveMemberAnchor> = z.lazy(() =>
  z.object({
    kind: z.literal("archive-member"),
    member: z.string().min(1),
    innerAnchor: AnchorSchema.nullable().optional(),
  })
);

// z.union rather than z.discriminatedUnion: the latter requires raw
// ZodObject members, but MediaTimestampAnchorSchema is a ZodEffects (refined)
// and ArchiveMemberAnchorSchema is a ZodLazy. Each member's \`kind\` is still
// a z.literal, so misses fail fast on the discriminator either way.
export const AnchorSchema: z.ZodType<Anchor> = z.union([
  PdfPageAnchorSchema,
  MediaTimestampAnchorSchema,
  EmailPartAnchorSchema,
  ArchiveMemberAnchorSchema,
  NoneAnchorSchema,
]);

export type PdfPageAnchor = z.infer<typeof PdfPageAnchorSchema>;
export type MediaTimestampAnchor = z.infer<typeof MediaTimestampAnchorSchema>;
export type EmailPartAnchor = z.infer<typeof EmailPartAnchorSchema>;
export type NoneAnchor = z.infer<typeof NoneAnchorSchema>;
export type { ArchiveMemberAnchor };
export type Anchor =
  | PdfPageAnchor
  | MediaTimestampAnchor
  | EmailPartAnchor
  | ArchiveMemberAnchor
  | NoneAnchor;
`;

mkdirSync(dirname(PY_OUT), { recursive: true });
mkdirSync(dirname(TS_OUT), { recursive: true });
writeFileSync(PY_OUT, PY, "utf-8");
writeFileSync(TS_OUT, TS, "utf-8");
console.log(`wrote ${PY_OUT}`);
console.log(`wrote ${TS_OUT}`);
