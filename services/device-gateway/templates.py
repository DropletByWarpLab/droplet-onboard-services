"""Point templates for common office devices, from standard MIBs.

A device created with `template` and no points gets these points. Only
standard, vendor-neutral OIDs belong here (index .1 = the first supply /
input), so a template works on any compliant device; vendor-specific
points are added by hand. All template points are read-only.
"""

from __future__ import annotations

TEMPLATES: dict[str, dict] = {
    # Printer-MIB (RFC 3805) + Host Resources MIB (RFC 2790).
    "printer": {
        "protocol": "snmp",
        "label": "Network printer",
        "points": [
            {"id": "status", "name": "Printer status", "kind": "number",
             "oid": "1.3.6.1.2.1.25.3.5.1.1.1"},  # hrPrinterStatus: 3 idle, 4 printing, 5 warmup
            {"id": "supply_level", "name": "First supply level", "kind": "number",
             "oid": "1.3.6.1.2.1.43.11.1.1.9.1.1"},  # prtMarkerSuppliesLevel
            {"id": "supply_capacity", "name": "First supply capacity", "kind": "number",
             "oid": "1.3.6.1.2.1.43.11.1.1.8.1.1"},  # prtMarkerSuppliesMaxCapacity
            {"id": "supply_name", "name": "First supply", "kind": "text",
             "oid": "1.3.6.1.2.1.43.11.1.1.6.1.1"},  # prtMarkerSuppliesDescription
            {"id": "page_count", "name": "Pages printed", "kind": "number", "unit": "pages",
             "oid": "1.3.6.1.2.1.43.10.2.1.4.1.1"},  # prtMarkerLifeCount
            {"id": "display", "name": "Console message", "kind": "text",
             "oid": "1.3.6.1.2.1.43.16.5.1.2.1.1"},  # prtConsoleDisplayBufferText
        ],
    },
    # UPS-MIB (RFC 1628).
    "ups": {
        "protocol": "snmp",
        "label": "UPS",
        "points": [
            {"id": "battery_status", "name": "Battery status", "kind": "number",
             "oid": "1.3.6.1.2.1.33.1.2.1.0"},  # 2 normal, 3 low, 4 depleted
            {"id": "charge", "name": "Charge remaining", "kind": "number", "unit": "%",
             "oid": "1.3.6.1.2.1.33.1.2.4.0"},
            {"id": "runtime", "name": "Runtime remaining", "kind": "number", "unit": "min",
             "oid": "1.3.6.1.2.1.33.1.2.3.0"},
            {"id": "input_voltage", "name": "Input voltage", "kind": "number", "unit": "V",
             "oid": "1.3.6.1.2.1.33.1.3.3.1.3.1"},
            {"id": "output_source", "name": "Output source", "kind": "number",
             "oid": "1.3.6.1.2.1.33.1.4.1.0"},  # 3 normal, 5 battery
            {"id": "load", "name": "Output load", "kind": "number", "unit": "%",
             "oid": "1.3.6.1.2.1.33.1.4.4.1.5.1"},
        ],
    },
    # SNMPv2-MIB system group + HOST-RESOURCES — anything with an SNMP agent.
    "host": {
        "protocol": "snmp",
        "label": "Any SNMP device",
        "points": [
            {"id": "name", "name": "Name", "kind": "text", "oid": "1.3.6.1.2.1.1.5.0"},
            {"id": "description", "name": "Description", "kind": "text", "oid": "1.3.6.1.2.1.1.1.0"},
            {"id": "location", "name": "Location", "kind": "text", "oid": "1.3.6.1.2.1.1.6.0"},
            {"id": "uptime", "name": "Uptime", "kind": "number", "unit": "s", "scale": 0.01,
             "oid": "1.3.6.1.2.1.1.3.0"},  # sysUpTime is in hundredths
        ],
    },
}


def apply_template(payload: dict) -> dict:
    """Fill `points` from `template` when the body brings none.

    Raises ValueError for an unknown template or one for another protocol.
    """
    name = payload.get("template")
    if not name:
        return payload
    tpl = TEMPLATES.get(name)
    if tpl is None:
        raise ValueError(f"unknown template {name!r}")
    if tpl["protocol"] != payload.get("protocol"):
        raise ValueError(f"template {name!r} is for {tpl['protocol']} devices")
    if payload.get("points"):
        return payload
    return {**payload, "points": [dict(p) for p in tpl["points"]]}


def listing() -> list[dict]:
    return [
        {"id": k, "label": v["label"], "protocol": v["protocol"], "points": len(v["points"])}
        for k, v in TEMPLATES.items()
    ]
