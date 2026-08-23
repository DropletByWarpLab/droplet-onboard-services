"""Tests for LoadingTracker — async-safe set of model names being pulled/loaded."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.mark.asyncio
async def test_add_remove_contains():
    from loading_state import LoadingTracker
    t = LoadingTracker()
    assert not await t.contains("llama3.2:3b")
    await t.add("llama3.2:3b")
    assert await t.contains("llama3.2:3b")
    await t.remove("llama3.2:3b")
    assert not await t.contains("llama3.2:3b")


@pytest.mark.asyncio
async def test_list_returns_sorted():
    from loading_state import LoadingTracker
    t = LoadingTracker()
    await t.add("zeta")
    await t.add("alpha")
    await t.add("mu")
    assert await t.list() == ["alpha", "mu", "zeta"]


@pytest.mark.asyncio
async def test_remove_missing_is_noop():
    from loading_state import LoadingTracker
    t = LoadingTracker()
    await t.remove("never-added")  # must not raise


@pytest.mark.asyncio
async def test_concurrent_add_removes_are_consistent():
    from loading_state import LoadingTracker
    t = LoadingTracker()

    async def add_then_remove(name: str) -> None:
        for _ in range(50):
            await t.add(name)
            await asyncio.sleep(0)
            await t.remove(name)

    await asyncio.gather(*[add_then_remove(f"m{i}") for i in range(10)])
    assert await t.list() == []
