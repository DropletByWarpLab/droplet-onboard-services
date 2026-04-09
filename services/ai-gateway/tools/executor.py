"""Tool executor — dispatches LLM tool calls to orchestrator APIs.

Receives tool call requests from the LLM (name + arguments) and executes
them by making HTTP requests to the orchestrator's REST API. Returns the
result as a string for the model to incorporate into its response.
"""

from __future__ import annotations

import json
import logging
import os

import httpx

logger = logging.getLogger(__name__)

ORCHESTRATOR_URL = os.getenv("ORCHESTRATOR_URL", "http://orchestrator:3000")

# Shared HTTP client (initialized lazily)
_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(base_url=ORCHESTRATOR_URL, timeout=30.0)
    return _client


async def execute_tool(name: str, arguments: dict) -> str:
    """Execute a tool call and return the result as a JSON string.

    Returns error messages as strings rather than raising exceptions,
    so the LLM can see what went wrong and adjust.
    """
    handler = TOOL_HANDLERS.get(name)
    if not handler:
        return json.dumps({"error": f"Unknown tool: {name}"})

    try:
        result = await handler(arguments)
        return json.dumps(result) if isinstance(result, (dict, list)) else str(result)
    except httpx.ConnectError:
        logger.error("Orchestrator unreachable at %s for tool %s", ORCHESTRATOR_URL, name)
        return json.dumps({"error": "Orchestrator service is unreachable"})
    except httpx.HTTPStatusError as e:
        logger.error("Tool %s HTTP error: %s", name, e)
        return json.dumps({"error": f"HTTP {e.response.status_code}: {e.response.text[:200]}"})
    except Exception as e:
        logger.error("Tool %s failed: %s", name, e)
        return json.dumps({"error": str(e)})


# --- Tool handlers ---


async def _list_files(args: dict) -> dict:
    path = args.get("path", "/")
    client = _get_client()
    resp = await client.get("/api/files", params={"path": path})
    resp.raise_for_status()
    return resp.json()


async def _read_file(args: dict) -> dict:
    path = args["path"]
    client = _get_client()
    resp = await client.get("/api/files/download", params={"path": path})
    resp.raise_for_status()
    content_type = resp.headers.get("content-type", "")
    if "text" in content_type or "json" in content_type or "xml" in content_type:
        return {"path": path, "content": resp.text[:10000]}  # cap at 10k chars
    return {"path": path, "error": f"Binary file (type: {content_type}), cannot read as text"}


async def _search_files(args: dict) -> dict:
    path = args.get("path", "/")
    pattern = args["pattern"].lower()
    client = _get_client()
    resp = await client.get("/api/files", params={"path": path})
    resp.raise_for_status()
    data = resp.json()
    matches = [
        entry for entry in data.get("entries", data.get("files", []))
        if pattern in entry.get("name", "").lower()
    ]
    return {"path": path, "pattern": pattern, "matches": matches}


async def _list_devices(args: dict) -> dict:
    client = _get_client()
    resp = await client.get("/api/devices")
    resp.raise_for_status()
    return resp.json()


async def _get_system_health(args: dict) -> dict:
    client = _get_client()
    resp = await client.get("/api/health")
    resp.raise_for_status()
    return resp.json()


async def _list_sync_targets(args: dict) -> dict:
    client = _get_client()
    resp = await client.get("/api/sync/targets")
    resp.raise_for_status()
    return resp.json()


async def _trigger_sync(args: dict) -> dict:
    target_id = args["target_id"]
    client = _get_client()
    resp = await client.post("/api/sync/trigger", json={"targetId": target_id})
    resp.raise_for_status()
    return resp.json()


# --- Smart Home / Matter tools ---


async def _list_smart_home_devices(args: dict) -> dict:
    client = _get_client()
    resp = await client.get("/api/matter/devices")
    resp.raise_for_status()
    return resp.json()


async def _get_smart_home_device(args: dict) -> dict:
    node_id = args["node_id"]
    client = _get_client()
    resp = await client.get(f"/api/matter/devices/{node_id}")
    resp.raise_for_status()
    return resp.json()


async def _control_device(args: dict) -> dict:
    node_id = args["node_id"]
    command = args["command"]
    data = args.get("data")
    client = _get_client()
    body = {"command": command}
    if data:
        body["data"] = data
    resp = await client.post(f"/api/matter/devices/{node_id}/command", json=body)
    resp.raise_for_status()
    return resp.json()


async def _discover_matter_devices(args: dict) -> dict:
    client = _get_client()
    resp = await client.get("/api/matter/discover", timeout=30.0)
    resp.raise_for_status()
    return resp.json()


async def _commission_device(args: dict) -> dict:
    pairing_code = args["pairing_code"]
    client = _get_client()
    resp = await client.post(
        "/api/matter/commission",
        json={"pairing_code": pairing_code},
        timeout=60.0,
    )
    resp.raise_for_status()
    return resp.json()


async def _get_command_history(args: dict) -> dict:
    client = _get_client()
    params = {}
    if "node_id" in args:
        params["entityId"] = f"matter.{args['node_id']}"
    if "limit" in args:
        params["limit"] = str(args["limit"])
    resp = await client.get("/api/matter/audit", params=params)
    resp.raise_for_status()
    return resp.json()


TOOL_HANDLERS = {
    "list_files": _list_files,
    "read_file": _read_file,
    "search_files": _search_files,
    "list_devices": _list_devices,
    "get_system_health": _get_system_health,
    "list_sync_targets": _list_sync_targets,
    "trigger_sync": _trigger_sync,
    "list_smart_home_devices": _list_smart_home_devices,
    "get_smart_home_device": _get_smart_home_device,
    "control_device": _control_device,
    "discover_matter_devices": _discover_matter_devices,
    "commission_device": _commission_device,
    "get_command_history": _get_command_history,
}


async def close():
    """Close the shared HTTP client."""
    global _client
    if _client:
        await _client.aclose()
        _client = None
