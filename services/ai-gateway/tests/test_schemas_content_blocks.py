"""Multimodal content-block support on ChatMessage (image vision)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from schemas import ChatMessage, ChatRequest, ImageUrlBlock, TextBlock


def test_string_content_still_accepted():
    m = ChatMessage(role="user", content="hello")
    assert m.content == "hello"


def test_content_blocks_accepted():
    req = ChatRequest(
        model="gpt-4o",
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "what is this?"},
                    {
                        "type": "image_url",
                        "image_url": {"url": "data:image/jpeg;base64,AAAA"},
                    },
                ],
            }
        ],
    )
    blocks = req.messages[0].content
    assert isinstance(blocks, list)
    assert isinstance(blocks[0], TextBlock)
    assert isinstance(blocks[1], ImageUrlBlock)
    assert blocks[1].image_url.url.startswith("data:image/jpeg;base64,")


def test_total_content_counts_text_only_not_image_bytes():
    big_text = "x" * 200
    big_image = "Q" * 500_000  # would blow the 128k cap if counted
    # Must NOT raise: image data URLs do not count toward the text budget.
    ChatRequest(
        model="gpt-4o",
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": big_text},
                    {
                        "type": "image_url",
                        "image_url": {"url": "data:image/jpeg;base64," + big_image},
                    },
                ],
            }
        ],
    )


def test_total_text_budget_still_enforced():
    with pytest.raises(ValidationError):
        ChatRequest(
            model="gpt-4o",
            messages=[
                {"role": "user", "content": [{"type": "text", "text": "y" * 20_000}]}
                for _ in range(10)
            ],
        )
