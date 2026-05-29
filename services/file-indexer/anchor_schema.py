"""Generated from schemas/anchor.schema.json. DO NOT EDIT.

Regenerate via `npm run gen:anchor-schema` from the repo root.
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
