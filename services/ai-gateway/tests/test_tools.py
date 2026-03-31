"""Tests for tool calling infrastructure."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from tools.definitions import get_tool_definitions, AVAILABLE_TOOLS
from tools.executor import execute_tool, TOOL_HANDLERS


# --- Tool definition tests ---


def test_tool_definitions_not_empty():
    """There are tool definitions available."""
    tools = get_tool_definitions()
    assert len(tools) > 0


def test_tool_definitions_have_required_fields():
    """Each tool definition has name, description, and parameters."""
    for tool in AVAILABLE_TOOLS:
        assert tool.type == "function"
        assert tool.function.name
        assert tool.function.description
        assert isinstance(tool.function.parameters, dict)


def test_tool_names_match_handlers():
    """Every defined tool has a corresponding handler."""
    tool_names = {t.function.name for t in AVAILABLE_TOOLS}
    handler_names = set(TOOL_HANDLERS.keys())
    assert tool_names == handler_names, (
        f"Mismatch: defined={tool_names - handler_names}, "
        f"handled={handler_names - tool_names}"
    )


# --- Tool executor tests ---


@pytest.mark.asyncio
async def test_execute_unknown_tool():
    """Unknown tool returns an error message."""
    result = await execute_tool("nonexistent_tool", {})
    data = json.loads(result)
    assert "error" in data
    assert "Unknown tool" in data["error"]


@pytest.mark.asyncio
async def test_execute_tool_handles_connection_error():
    """Tool executor handles orchestrator being unreachable."""
    with patch("tools.executor._get_client") as mock_client:
        client = AsyncMock()
        client.get = AsyncMock(side_effect=Exception("connection refused"))
        mock_client.return_value = client

        result = await execute_tool("list_devices", {})
        data = json.loads(result)
        assert "error" in data


@pytest.mark.asyncio
async def test_execute_list_files():
    """list_files tool calls the correct endpoint."""
    mock_response = AsyncMock()
    mock_response.json = lambda: {"entries": [{"name": "test.txt", "size": 100}]}
    mock_response.raise_for_status = lambda: None

    mock_client = AsyncMock()
    mock_client.get = AsyncMock(return_value=mock_response)

    with patch("tools.executor._get_client", return_value=mock_client):
        result = await execute_tool("list_files", {"path": "/docs"})
        data = json.loads(result)
        assert "entries" in data
        mock_client.get.assert_called_once_with("/api/files", params={"path": "/docs"})


@pytest.mark.asyncio
async def test_execute_get_system_health():
    """get_system_health tool calls the health endpoint."""
    mock_response = AsyncMock()
    mock_response.json = lambda: {"status": "ok", "uptime": 3600}
    mock_response.raise_for_status = lambda: None

    mock_client = AsyncMock()
    mock_client.get = AsyncMock(return_value=mock_response)

    with patch("tools.executor._get_client", return_value=mock_client):
        result = await execute_tool("get_system_health", {})
        data = json.loads(result)
        assert data["status"] == "ok"
        mock_client.get.assert_called_once_with("/api/health")
