"""Live payloads captured off the production RB5009 (WARP-1866).

Read from the edge router at 192.168.9.1 on 2026-08-10 — `ubus call
network.device status`, `luci-rpc getBoardJSON` and `uci get network`, trimmed
to the fields the port map reads but otherwise verbatim. Real payloads, not
hand-written ones, because every trap this module guards against is a property
of the real reply and a synthetic fixture would quietly drop it:

  * p4–p8 carry `up: true` with `carrier: false` — the admin-vs-link
    distinction that makes `up` the wrong field to key the UI on;
  * a carrier-down port has NO `speed` key at all (not "-1F", not "0");
  * `sfp` is in board.json's LAN roster and is COMPLETELY ABSENT from
    `network.device status` — the empty-cage case;
  * `eth0` (the DSA conduit) looks more like a real jack than the jacks do:
    carrier up, real counters, and 10 Gb;
  * the `br_lan` uci section is named `br_lan` but creates the netdev `br-lan`.
"""

from __future__ import annotations

# `ubus call network.device status` — the bulk form returns the device map at
# the top level, with no "values" envelope.
DEVICE_STATUS = {
    "br-lan": {
        "up": True, "carrier": True, "present": True, "speed": "1000F",
        "devtype": "bridge", "type": "bridge", "macaddr": "d0:ea:11:41:67:2d",
        "bridge-members": ["p2", "p3", "p4", "p5", "p6", "p7", "p8"],
        "statistics": {"rx_bytes": 218194856, "tx_bytes": 72287609},
    },
    "br-lan.30": {
        "up": True, "carrier": True, "present": True, "speed": "1000F",
        "devtype": "vlan", "type": "8021q", "macaddr": "d0:ea:11:41:67:2d",
        "statistics": {"rx_bytes": 0, "tx_bytes": 1088},
    },
    "eth0": {
        "up": True, "carrier": True, "present": True, "speed": "10000F",
        "devtype": "ethernet", "type": "Network device",
        "macaddr": "d0:ea:11:41:67:2c", "mtu": 1504,
        "statistics": {"rx_bytes": 295738412, "tx_bytes": 283979043},
    },
    "lo": {
        "up": True, "carrier": True, "present": True,
        "type": "Network device", "macaddr": "00:00:00:00:00:00",
        "statistics": {"rx_bytes": 8049, "tx_bytes": 8049},
    },
    "p1": {
        "up": True, "carrier": True, "present": True, "speed": "2500F",
        "devtype": "dsa", "type": "Network device",
        "macaddr": "d0:ea:11:41:67:2c",
        "statistics": {"rx_bytes": 63507437, "tx_bytes": 210377086},
    },
    "p2": {
        "up": True, "carrier": True, "present": True, "speed": "1000F",
        "devtype": "dsa", "type": "Network device",
        "macaddr": "d0:ea:11:41:67:2d",
        "statistics": {"rx_bytes": 24784447, "tx_bytes": 22573095},
    },
    "p3": {
        "up": True, "carrier": True, "present": True, "speed": "1000F",
        "devtype": "dsa", "type": "Network device",
        "macaddr": "d0:ea:11:41:67:2e",
        "statistics": {"rx_bytes": 205693124, "tx_bytes": 49725610},
    },
    # p4..p8 — nothing plugged in. Note `up: True` and NO `speed` key.
    "p4": {
        "up": True, "carrier": False, "present": True, "devtype": "dsa",
        "type": "Network device", "macaddr": "d0:ea:11:41:67:2f",
        "statistics": {"rx_bytes": 0, "tx_bytes": 0},
    },
    "p5": {
        "up": True, "carrier": False, "present": True, "devtype": "dsa",
        "type": "Network device", "macaddr": "d0:ea:11:41:67:30",
        "statistics": {"rx_bytes": 0, "tx_bytes": 0},
    },
    "p6": {
        "up": True, "carrier": False, "present": True, "devtype": "dsa",
        "type": "Network device", "macaddr": "d0:ea:11:41:67:31",
        "statistics": {"rx_bytes": 0, "tx_bytes": 0},
    },
    "p7": {
        "up": True, "carrier": False, "present": True, "devtype": "dsa",
        "type": "Network device", "macaddr": "d0:ea:11:41:67:32",
        "statistics": {"rx_bytes": 0, "tx_bytes": 0},
    },
    "p8": {
        "up": True, "carrier": False, "present": True, "devtype": "dsa",
        "type": "Network device", "macaddr": "d0:ea:11:41:67:33",
        "statistics": {"rx_bytes": 0, "tx_bytes": 0},
    },
    # No "sfp" key — the empty cage reports nothing at all.
}

# `luci-rpc getBoardJSON` — verbatim.
BOARD_JSON = {
    "model": {"id": "mikrotik,rb5009", "name": "MikroTik RB5009"},
    "led": {
        "sfp": {"name": "SFP", "sysfs": "green:sfp", "type": "netdev",
                "device": "sfp", "mode": "link tx rx"},
        "wan_port_link": {
            "name": "WAN-PORT-LINK",
            "sysfs": "!cp0!config-space@f2000000!mdio@12a200!switch@0!mdio1:00:green:",
            "type": "netdev", "device": "p1",
            "mode": "tx rx link_10 link_100 link_1000 link_2500",
        },
    },
    "network": {
        "lan": {"ports": ["p2", "p3", "p4", "p5", "p6", "p7", "p8", "sfp"],
                "protocol": "static"},
        "wan": {"device": "p1", "protocol": "dhcp"},
    },
}

# `ubus call uci get {"config": "network"}` — the "values" envelope is real.
UCI_NETWORK = {
    "values": {
        "loopback": {
            ".anonymous": False, ".type": "interface", ".name": "loopback",
            ".index": 0, "device": "lo", "proto": "static",
            "ipaddr": ["127.0.0.1/8"],
        },
        "globals": {".anonymous": False, ".type": "globals",
                    ".name": "globals", ".index": 1},
        "br_lan": {
            ".anonymous": False, ".type": "device", ".name": "br_lan",
            ".index": 2, "name": "br-lan", "type": "bridge",
            "ports": ["p2", "p3", "p4", "p5", "p6", "p7", "p8"],
        },
        "lan": {
            ".anonymous": False, ".type": "interface", ".name": "lan",
            ".index": 3, "device": "br-lan", "proto": "static",
            "ipaddr": "192.168.9.1", "netmask": "255.255.255.0",
            "ip6assign": "60",
        },
        "wan_dev": {".anonymous": False, ".type": "device",
                    ".name": "wan_dev", ".index": 4, "name": "p1"},
        "wan": {
            ".anonymous": False, ".type": "interface", ".name": "wan",
            ".index": 5, "device": "p1", "proto": "dhcp",
        },
        "wan6": {
            ".anonymous": False, ".type": "interface", ".name": "wan6",
            ".index": 6, "device": "p1", "proto": "dhcpv6",
        },
        "guest_dev": {
            ".anonymous": False, ".type": "device", ".name": "guest_dev",
            ".index": 7, "type": "8021q", "ifname": "br-lan", "vid": "30",
            "name": "br-lan.30",
        },
        "guest": {
            ".anonymous": False, ".type": "interface", ".name": "guest",
            ".index": 8, "device": "br-lan.30", "proto": "static",
            "ipaddr": "192.168.30.1", "netmask": "255.255.255.0",
        },
    }
}
