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
    # --- Smart Home / Matter tools ---
    ToolDefinition(
        function=ToolFunction(
            name="list_smart_home_devices",
            description=(
                "List all smart home devices connected via Matter protocol, grouped by category "
                "(lights, switches, sensors, climate, media, covers, locks, other). "
                "Each device includes its current state, connection status, and attributes. "
                "Call this first to see what devices are available before controlling them."
            ),
            parameters={"type": "object", "properties": {}},
        )
    ),
    ToolDefinition(
        function=ToolFunction(
            name="get_smart_home_device",
            description=(
                "Get detailed information about a specific smart home device by its node ID. "
                "Returns the device name, category, state, connection status, vendor info, "
                "endpoint details, and all current attribute values."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "node_id": {
                        "type": "string",
                        "description": "The Matter node ID of the device (e.g. '1', '2').",
                    }
                },
                "required": ["node_id"],
            },
        )
    ),
    ToolDefinition(
        function=ToolFunction(
            name="control_device",
            description=(
                "Send a command to a smart home device. Available commands depend on device type:\n"
                "- Lights/switches: 'turn_on', 'turn_off', 'toggle'\n"
                "- Lights with dimming: 'set_brightness' (data: {brightness: 0-100})\n"
                "- Thermostats: 'set_temperature' (data: {temperature: degrees_celsius, mode: 0=heat/1=cool})\n"
                "- Locks: 'lock', 'unlock'\n"
                "Some commands (locks, extreme temperatures) require user confirmation and will "
                "return a confirmation token instead of executing immediately."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "node_id": {
                        "type": "string",
                        "description": "The Matter node ID of the device to control.",
                    },
                    "command": {
                        "type": "string",
                        "description": "Command to send: turn_on, turn_off, toggle, set_brightness, set_temperature, lock, unlock.",
                    },
                    "data": {
                        "type": "object",
                        "description": "Optional command parameters (e.g. {brightness: 75} or {temperature: 22}).",
                    },
                },
                "required": ["node_id", "command"],
            },
        )
    ),
    ToolDefinition(
        function=ToolFunction(
            name="discover_matter_devices",
            description=(
                "Scan the local WiFi network for new Matter-compatible devices that haven't been "
                "commissioned yet. Returns a list of discovered devices with their discriminator, "
                "vendor/product info, and network addresses. The scan takes about 15 seconds. "
                "After discovering devices, use 'commission_device' with the device's pairing code to add it."
            ),
            parameters={"type": "object", "properties": {}},
        )
    ),
    ToolDefinition(
        function=ToolFunction(
            name="commission_device",
            description=(
                "Commission (pair) a new Matter device using its pairing code. "
                "The pairing code can be a manual code (11 or 21 digit number printed on the device) "
                "or a QR code payload (starts with 'MT:'). This establishes a secure connection "
                "and adds the device to the Droplet controller. After commissioning, the device "
                "will appear in list_smart_home_devices and can be controlled."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "pairing_code": {
                        "type": "string",
                        "description": "The device pairing code — either a manual code (e.g. '34970112332') or QR payload (e.g. 'MT:Y.K9042C00KA0648G00').",
                    }
                },
                "required": ["pairing_code"],
            },
        )
    ),
    ToolDefinition(
        function=ToolFunction(
            name="get_command_history",
            description=(
                "View the recent command audit log for smart home devices. "
                "Shows what commands were sent, whether they were auto-executed or required "
                "confirmation, and if any were blocked by safety rules."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "node_id": {
                        "type": "string",
                        "description": "Optional: filter by device node ID. Omit to see all devices.",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of entries to return. Default: 20.",
                        "default": 20,
                    },
                },
            },
        )
    ),
]


def get_tool_definitions() -> list[ToolDefinition]:
    """Return all available tool definitions."""
    return AVAILABLE_TOOLS
