// Generated from schemas/anchor.schema.json. DO NOT EDIT.
// Regenerate via `npm run gen:anchor-schema` from the repo root.
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
// and ArchiveMemberAnchorSchema is a ZodLazy. Each member's `kind` is still
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
