"""Recorded WebStaX JSON payloads from the Lantronix SM8TAT2SA at 192.168.1.77.

Captured READ-ONLY on 2026-06-03 against firmware v1.04.0079 (ADR-018 item 10).
These are the verbatim shapes the corrected `LantronixDriver` parses. They are
the ONLY source of switch data in the test suite — no test ever opens a socket
to the device (it rate-limits and locks the admin account on repeated logins).

Endpoint -> payload map:
  GET /config/login              -> LOGIN_GET (carries `userip` for the POST)
  POST /config/login             -> LOGIN_POST_OK / LOGIN_POST_FAIL
  GET /stat/sysinfo              -> SYSINFO
  GET /stat/vlan_membership_stat -> VLAN_MEMBERSHIP_STAT
  GET /stat/vlan_port_stat       -> VLAN_PORT_STAT
  GET /stat/poe_status           -> POE_STATUS

The legacy prototype endpoints (/stat/vlan, /stat/port,
/stat/vlan_membership) 404 on this firmware and are intentionally absent.
"""

from __future__ import annotations

# --- Auth handshake ---------------------------------------------------------

# GET /config/login — the firmware echoes the caller IP it sees; the driver
# lifts `userip` from here and replays it in the POST envelope.
LOGIN_GET: dict = {
    "status": "none",
    "userip": "192.168.1.50",
    "System Name": "Droplet Switch",
}

# POST /config/login success. The switch always answers 200; success lives in
# the body `status` field, never the HTTP code.
LOGIN_POST_OK: dict = {
    "status": "success",
    "privilege": 15,
    "agent_id": 4,
    "user": "admin",
}

# POST /config/login failure (wrong credentials).
LOGIN_POST_FAIL: dict = {
    "status": "error",
    "msg": "Wrong username or password!",
}


# --- Reads (confirmed HTTP 200 on v1.04.0079) -------------------------------

SYSINFO: dict = {
    "data": {
        "Model Name": "SM8TAT2SA",
        "Hardware Version": "v3.01",
        "Firmware Version": "v1.04.0079",
        "PoE Firmware Version": "RNU-016",
        "MAC Address": "00-C0-F2-A3-E6-3D",
        "Serial Number": "C020323BR3400900",
        "System Name": "Droplet Switch",
        "Location": "",
        "Contact": "",
        "System Description": (
            "Smart Managed Switch, 8-port Gigabit PoE+, 2-port 100/1000 SFP"
        ),
    }
}

# GET /stat/vlan_membership_stat
# data rows: [vlan_id:int, name:str, members:int[], untagged:int[]]
# tagged ports = members - untagged.
#   VLAN 1   "default"  members 2,3,7,10  untagged 2,3,7,10  (no tagged)
#   VLAN 10  "lan"      members 1,4,5,8,9 untagged 1,4,5,8,9  (no tagged)
#   VLAN 100 "cameras"  members 5,6       untagged 6          (port 5 tagged)
VLAN_MEMBERSHIP_STAT: dict = {
    "data": [
        [1, "default", [2, 3, 7, 10], [2, 3, 7, 10]],
        [10, "lan", [1, 4, 5, 8, 9], [1, 4, 5, 8, 9]],
        [100, "cameras", [5, 6], [6]],
    ]
}

# GET /stat/vlan_port_stat — per-port PVID + tagging.
# `pvid` (int) is the port's untagged VLAN. A trunk port carries
# txtag="All except-native"; access ports carry txtag="None". Port 5 is the
# trunk here (PVID 10, txtag "All except-native"); every other port is access.
VLAN_PORT_STAT: dict = {
    "data": [
        {
            "port": 1,
            "element": [
                {
                    "user": 7,
                    "PVID": "10",
                    "pvid": 10,
                    "portype": 1,
                    "type": "C-Port",
                    "infilter": True,
                    "inaccept": 0,
                    "frameType": "All",
                    "etagging": 3,
                    "txtag": "None",
                    "flag": 31,
                }
            ],
        },
        {"port": 2, "element": [{"PVID": "1", "pvid": 1, "txtag": "None"}]},
        {"port": 3, "element": [{"PVID": "1", "pvid": 1, "txtag": "None"}]},
        {"port": 4, "element": [{"PVID": "10", "pvid": 10, "txtag": "None"}]},
        {
            "port": 5,
            "element": [
                {
                    "PVID": "10",
                    "pvid": 10,
                    "etagging": 0,
                    "txtag": "All except-native",
                }
            ],
        },
        {"port": 6, "element": [{"PVID": "100", "pvid": 100, "txtag": "None"}]},
        {"port": 7, "element": [{"PVID": "1", "pvid": 1, "txtag": "None"}]},
        {"port": 8, "element": [{"PVID": "10", "pvid": 10, "txtag": "None"}]},
        {"port": 9, "element": [{"PVID": "10", "pvid": 10, "txtag": "None"}]},
        {"port": 10, "element": [{"PVID": "1", "pvid": 1, "txtag": "None"}]},
    ]
}

# GET /stat/poe_status — per-port PoE, already-200 on v1.04.0079 (the prototype
# parser handles this shape; ADR-018 item 10 preserves it). PoE rows carry the
# admin state in `Admin`, the live state in `Status` (Delivering/On vs Off),
# power in `Power(mW)`, and limits in `Class` / `Max Power(mW)`. Ports 1-8 are
# PoE-capable; the SFP ports (9-10) have no PoE rows.
POE_STATUS: dict = {
    "data": [
        {
            "port": 1,
            "Admin": "Enabled",
            "Status": "Delivering",
            "Power(mW)": 12500,
            "Class": "Class 3",
            "Max Power(mW)": 30000,
        },
        {
            "port": 2,
            "Admin": "Enabled",
            "Status": "Off",
            "Power(mW)": 0,
            "Class": "",
            "Max Power(mW)": 30000,
        },
    ]
}
