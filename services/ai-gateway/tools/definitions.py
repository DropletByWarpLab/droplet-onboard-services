"""Tool definitions for LLM function calling.

These are the tools the LLM can invoke to interact with the Droplet
system — file management, device listing, sync control, and health status.
Definitions follow the OpenAI function calling schema format.
"""

from __future__ import annotations

from schemas import ToolDefinition, ToolFunction

AVAILABLE_TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        function=ToolFunction(
            name="list_files",
            description="List files and directories at a given path on the Droplet device.",
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Directory path to list. Defaults to root '/'.",
                        "default": "/",
                    }
                },
            },
        )
    ),
    ToolDefinition(
        function=ToolFunction(
            name="read_file",
            description="Read the text content of a file on the Droplet device. Only works for text files.",
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Full path to the file to read.",
                    }
                },
                "required": ["path"],
            },
        )
    ),
    ToolDefinition(
        function=ToolFunction(
            name="search_files",
            description="Search for files by name pattern within a directory.",
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Directory to search in. Defaults to root '/'.",
                        "default": "/",
                    },
                    "pattern": {
                        "type": "string",
                        "description": "Filename pattern to search for (case-insensitive substring match).",
                    },
                },
                "required": ["pattern"],
            },
        )
    ),
    ToolDefinition(
        function=ToolFunction(
            name="list_devices",
            description="List all connected devices on the Droplet network.",
            parameters={"type": "object", "properties": {}},
        )
    ),
    ToolDefinition(
        function=ToolFunction(
            name="get_system_health",
            description="Get the current health status of the Droplet system including database, cache, and AI services.",
            parameters={"type": "object", "properties": {}},
        )
    ),
    ToolDefinition(
        function=ToolFunction(
            name="list_sync_targets",
            description="List all configured file synchronization targets.",
            parameters={"type": "object", "properties": {}},
        )
    ),
    ToolDefinition(
        function=ToolFunction(
            name="trigger_sync",
            description="Trigger an immediate file sync for a specific sync target.",
            parameters={
                "type": "object",
                "properties": {
                    "target_id": {
                        "type": "string",
                        "description": "ID of the sync target to trigger.",
                    }
                },
                "required": ["target_id"],
            },
        )
    ),
]


def get_tool_definitions() -> list[ToolDefinition]:
    """Return all available tool definitions."""
    return AVAILABLE_TOOLS
