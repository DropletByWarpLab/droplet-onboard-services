"""Physical port map for the edge router (WARP-1866), and its write half (WARP-1907).

The Network tab has had a full port map for the managed *switch* since
WARP-1674 (faceplate + port table: link, speed, traffic, role, VLAN, PoE).
The *router* only ever exposed its **logical** interfaces — lan / wan / guest,
with a name, proto, address and zone. On the RB5009 that leaves nine physical
jacks with nothing in the product telling you which ones are live.

This module derives the physical port map from three reads the router's
``droplet-ai`` rpcd ACL **already** grants — no image change, no reflash:

  * ``network.device status``   → per-device carrier / speed / MAC / counters
  * ``luci-rpc getBoardJSON``   → the board's factory port roster
  * ``uci get network``         → what each jack is actually wired to *now*

Every derivation below is a pure function over those three payloads so the
honesty rules are unit-testable without a router.

Honesty rules this module exists to enforce
-------------------------------------------

**Link is ``carrier``, never ``up``.** On a DSA switch port ``up`` is the
*admin* state and is true for every jack the kernel has brought up, cable or
not: the live RB5009 reports ``up=true, carrier=false`` on p4–p8 with nothing
plugged in. Keying the UI off ``up`` would light all eight jacks — the same
class of defect as WARP-1716, where dark switch ports announced themselves as
"Open" while carrying gigabytes.

**A jack with no netifd object is ABSENT, not down.** The RB5009's SFP cage is
a real netdev and is listed in ``board.json``, but it is not a bridge member
and ``network.device status`` does not report it at all. "We have no reading
for this cage" and "this cage is down" are different claims; conflating them
invents a fact. Such a port is reported ``present=false`` / ``status=absent``.

**The roster comes from the board + uci, never from the raw netdev list.**
Enumerating ``network.device status`` directly would present ``lo``, the
``br-lan`` bridge, the ``br-lan.30`` VLAN and the DSA conduit ``eth0`` as
physical ports. The conduit is the trap worth naming: it looks exactly like a
jack (``devtype=ethernet``, carrier up, real counters) and reports 10 Gb —
faster than any port on the box — because it is the internal CPU link. It is
excluded structurally: it appears in neither ``board.json``'s network section
nor any uci section, so a roster built from those two never contains it. That
is also why the roster is not filtered by ``devtype=="dsa"`` — that test would
be right for this one board and wrong for every non-DSA shape (the Pi edge
router's jacks are plain ``ethernet``).

Turning a jack off (WARP-1907)
------------------------------

netifd exposes no "shut this jack" ubus call. A jack is administratively downed
by a uci ``config device`` section carrying ``option enabled '0'``, keyed by
``option name '<netdev>'``. Verified against netifd's own source at the revision
the shipped router runs (``netifd 2025.05.23~7901e66c``, OpenWrt 25.12.5
r33051): ``device.c`` declares ``[DEV_ATTR_ENABLED] = { .name = "enabled",
.type = BLOBMSG_TYPE_BOOL }``; ``device_init_settings()`` turns a false value
into ``device_set_disabled(dev, true)``; and ``device_refresh_present()`` then
forces ``present = false`` **regardless of** ``sys_present`` — so a physically
present DSA jack really does go down and its bridge drops it. The jack then
reports ``up: false, carrier: false``, which :func:`derive_ports` already maps
to ``status: "disabled"``; no new vocabulary is needed on the read side.

🔴 **Most jacks have NO ``config device`` section**, so the write has to create
one. On the live RB5009 exactly three exist — ``br_lan`` (the bridge),
``guest_dev`` (the VLAN) and ``wan_dev``, a bare ``config device { option name
'p1' }``. p2–p8 are realised by netifd from bridge membership alone. Hence
:func:`device_section_name` (find the existing section, keyed by the NETDEV name
the section declares — ``config device 'br_lan'`` creates ``br-lan``) and
:func:`new_device_section_name` (mint a fresh, uci-safe, collision-free section
name when there is none).

**The disable guard is asymmetric, and the asymmetry is the whole design.**
``safe_apply``'s 60s auto-rollback fires only when the router stops answering
the routing service *over the LAN*:

  * **WAN jack** — the router stays reachable on the LAN, so the connectivity
    probe succeeds, ``uci.confirm()`` runs, and the household is offline until
    somebody turns it back on. No automatic undo. Guarded, and its copy must
    never promise one.
  * **A jack carrying a management network WITH a live link** — this is a
    genuine self-cut: the probe fails, and OpenWrt reverts after 60s. Guarded,
    and here the copy may say so.
  * **A jack carrying a management network with NO link** — allowed. On the
    RB5009 every LAN jack is a ``br-lan`` member, so a guard that asked only
    "does this carry ``lan``?" would demand a force-confirm for five empty
    jacks. An empty jack that merely appears in a bridge's config is carrying
    nothing.

:func:`disable_guard` is the single source of that policy. It is published on
the READ (:func:`annotate_write_guards`) so the dashboard can render the right
confirmation copy without owning a second, drifting copy of the rules, and the
write route calls the same function — the two cannot disagree.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Callable, Optional

logger = logging.getLogger("droplet.routing.router_ports")

#: uci `device` section types that are logical, not a jack. A section of one of
#: these types names a bridge/VLAN netdev; its *members* are the jacks.
_BRIDGE_TYPES = frozenset({"bridge"})
_VLAN_TYPES = frozenset({"8021q", "8021ad"})

#: Never a physical port on any shape.
_NEVER_A_PORT = frozenset({"lo"})

#: Interface-name → role. Anything else is reported as `other` rather than
#: guessed at: a deployment may add interfaces we have no vocabulary for, and
#: labelling one "lan" because it isn't "wan" would be a fabrication.
_ROLE_BY_NETWORK = {
    "wan": "wan",
    "wan6": "wan",
    "lan": "lan",
    "guest": "guest",
}

#: Ports whose name marks them as a fibre cage rather than a copper jack.
_SFP_RE = re.compile(r"^(sfp|fiber|fibre)", re.IGNORECASE)

#: netifd's universal sub-interface convention: `<parent>.<vid>`.
#:
#: 🔴 A VLAN does NOT have to have a `config device` section. netifd creates the
#: sub-device implicitly from the name alone, and both shipping shapes rely on
#: that: the Pi edge router's config carries `option device 'eth1.100'` with no
#: device section (deliberately — see the comment above `config interface
#: 'cameras'` in openwrt/files/etc/config/network), and this service's own
#: `setup_camera_subnet` writes `network.cameras.device = 'br-lan.100'` plus a
#: `config bridge-vlan` — a section type that is neither a bridge nor a VLAN
#: device section. Keying "is this logical?" off the presence of a uci section
#: therefore MISSES both, and the missing name falls through to "it's a jack",
#: putting a VLAN on the faceplate as physical hardware. Match the name.
_VLAN_SUFFIX_RE = re.compile(r"^(?P<parent>.+)\.(?P<vid>\d+)$")

#: netifd `devtype` / `type` values that prove a netdev is logical. Belt and
#: braces alongside the name test: the status payload we already fetch says so
#: outright, and reading it costs nothing.
_LOGICAL_DEVTYPES = frozenset({"bridge", "vlan"})
_LOGICAL_TYPES = frozenset({"bridge", "8021q", "8021ad"})


def vlan_parent(name: str) -> Optional[str]:
    """`"eth1.100"` → `"eth1"`; a name with no VLAN suffix → ``None``."""
    m = _VLAN_SUFFIX_RE.fullmatch(name or "")
    return m.group("parent") if m else None


def is_sfp(name: str) -> bool:
    """True for a fibre cage — it renders differently and, when empty, reports
    no netifd object at all (see the module docstring)."""
    return bool(_SFP_RE.match(name or ""))


def parse_speed(speed: Any) -> tuple[Optional[str], Optional[str]]:
    """netifd's link speed ("1000F" / "2500F" / "100H") → (label, duplex).

    Returns ``(None, None)`` for the down/unknown forms. netifd reports the
    field as absent on a carrier-down DSA port on this build, and as "-1F" on
    others — both mean "no link", so both collapse to None rather than to a
    fabricated "0 Mb".
    """
    m = re.fullmatch(r"(-?\d+)([FH]?)", str(speed or ""))
    if not m:
        return None, None
    mbps = int(m.group(1))
    if mbps <= 0:
        return None, None
    if mbps >= 1000 and mbps % 100 == 0:
        gbps = mbps / 1000
        label = f"{gbps:.1f}".rstrip("0").rstrip(".") + " Gb"
    else:
        label = f"{mbps} Mb"
    return label, {"F": "full", "H": "half"}.get(m.group(2))


def parse_traffic(statistics: Any) -> Optional[dict]:
    """netifd's per-device ``statistics`` block → ``{rx_bytes, tx_bytes}``.

    ``None`` when the device reports no counters — "we don't know" and "nothing
    has crossed this port" are different claims and the dashboard renders them
    differently. Mirrors the switch driver's ``_traffic_fields``.
    """
    if not isinstance(statistics, dict):
        return None
    try:
        rx = int(statistics["rx_bytes"])
        tx = int(statistics["tx_bytes"])
    except (KeyError, TypeError, ValueError):
        return None
    if rx < 0 or tx < 0:
        return None
    return {"rx_bytes": rx, "tx_bytes": tx}


def _as_list(value: Any) -> list[str]:
    """Normalise a uci option that may be a list, a whitespace-joined string,
    or absent.

    🔴 uci returns a MULTI-value option as a JSON list but a single-value (or
    whitespace-joined) one as a plain STRING — iterating that string yields one
    CHARACTER at a time. The switch driver shipped this exact bug and rendered
    VLAN 1 with zero ports (audit 2026-08-06); do not "simplify" this away.
    """
    if isinstance(value, str):
        return value.split()
    if isinstance(value, list):
        return [str(v) for v in value if str(v)]
    return []


def _uci_sections(uci_network: Any) -> dict[str, dict]:
    """The ``{section: {...}}`` map out of either a raw ubus ``uci get`` reply
    (``{"values": {...}}``) or an already-unwrapped dict."""
    if not isinstance(uci_network, dict):
        return {}
    values = uci_network.get("values")
    source = values if isinstance(values, dict) else uci_network
    return {k: v for k, v in source.items() if isinstance(v, dict)}


def _device_sections(uci_network: Any) -> dict[str, dict]:
    """uci ``config device`` sections keyed by the NETDEV name they create.

    The section name and the netdev name are different strings — ``config
    device 'br_lan'`` creates ``br-lan`` — and every reference elsewhere in
    ``/etc/config/network`` uses the netdev name, so that is the key.
    """
    out: dict[str, dict] = {}
    for section in _uci_sections(uci_network).values():
        if section.get(".type") != "device":
            continue
        name = section.get("name")
        if isinstance(name, str) and name:
            out[name] = section
    return out


# ---------------------------------------------------------------------------
# Write half (WARP-1907) — `config device` resolution
# ---------------------------------------------------------------------------

#: uci's boolean spellings. `uci_bool` reads all of them because a hand-edited
#: config is allowed to use any, and misreading `off` as "not false" would let
#: the post-write readback pass on a jack that is still up.
_UCI_FALSE = frozenset({"0", "off", "false", "no", "disabled"})
_UCI_TRUE = frozenset({"1", "on", "true", "yes", "enabled"})

#: Characters uci permits in a section name. Everything else is folded to `_`.
_SECTION_UNSAFE_RE = re.compile(r"[^A-Za-z0-9_]")

#: Prefix for a section this service mints. Keeps our sections identifiable in
#: `uci show network` and out of the way of the image's own names (`wan_dev`,
#: `br_lan`, `guest_dev`).
_SECTION_PREFIX = "port_"


def uci_bool(value: Any, default: bool) -> bool:
    """A uci option that means a boolean → ``bool``.

    ``default`` is returned for an absent option, which is a real answer rather
    than a missing one: netifd's ``enabled`` defaults to true, so "no option" is
    a positive claim that the device is up.
    """
    if value is None:
        return default
    text = str(value).strip().lower()
    if text in _UCI_FALSE:
        return False
    if text in _UCI_TRUE:
        return True
    return default


def device_section_name(uci_network: Any, netdev: str) -> Optional[str]:
    """The uci ``config device`` SECTION name that configures ``netdev``.

    ``None`` when no section configures it — the common case, and the reason the
    write path has to be able to create one (module docstring).

    Matching is on the section's ``option name``, never on the section's own
    name: ``config device 'br_lan'`` creates the netdev ``br-lan``, and every
    reference elsewhere in ``/etc/config/network`` uses the netdev name.
    """
    if not netdev:
        return None
    for section_name, section in _uci_sections(uci_network).items():
        if section.get(".type") != "device":
            continue
        if section.get("name") == netdev:
            return section_name
    return None


def device_section_enabled(uci_network: Any, netdev: str) -> bool:
    """Whether uci currently says ``netdev`` is administratively up.

    True when there is no section, and true when the section carries no
    ``enabled`` option — both mean netifd's default, which is up.
    """
    section_name = device_section_name(uci_network, netdev)
    if section_name is None:
        return True
    section = _uci_sections(uci_network).get(section_name, {})
    return uci_bool(section.get("enabled"), default=True)


def new_device_section_name(netdev: str, uci_network: Any) -> str:
    """Mint a uci-safe, unused section name for a new ``config device``.

    Section names live in ONE namespace per config across every section type, so
    a name already taken by an unrelated section would be clobbered by
    ``uci add``. Collisions get a numeric suffix rather than an error: the caller
    is mid-write and a refusal here would be a worse outcome than a `_2`.
    """
    stem = _SECTION_PREFIX + _SECTION_UNSAFE_RE.sub("_", netdev or "")
    taken = set(_uci_sections(uci_network))
    if stem not in taken:
        return stem
    for suffix in range(2, 100):
        candidate = f"{stem}_{suffix}"
        if candidate not in taken:
            return candidate
    # 98 sections all named after one jack is a config nobody has; fail loudly
    # rather than silently reusing one of them.
    raise ValueError(f"cannot find a free uci section name for device {netdev!r}")


# ---------------------------------------------------------------------------
# Write half (WARP-1907) — the disable guard
# ---------------------------------------------------------------------------

#: Refusal codes. The route answers 409 + one of these unless `force` is set.
GUARD_WAN_PORT = "WAN_PORT"
GUARD_MANAGEMENT_PORT = "MANAGEMENT_PORT"

#: Interface names that mean "the internet comes in here". Derived from the
#: read side's role table so the two can't drift apart.
_WAN_NETWORKS = frozenset(
    name for name, role in _ROLE_BY_NETWORK.items() if role == "wan"
)

#: 🔴 The WAN refusal must NOT promise an automatic revert. safe_apply probes
#: the router over the LAN; cutting the WAN leaves that probe succeeding, so
#: `uci.confirm()` runs and the change is permanent. Saying "it reverts itself"
#: would be false at exactly the moment the user is relying on it.
_WAN_REASON = (
    "This is the jack your internet comes in on. Turning it off takes everyone "
    "in the home offline, and it will stay off until you turn it back on — "
    "nothing puts it back for you. Confirm again to continue."
)

#: Here the promise IS true: this jack carries the path the appliance is reached
#: on, so cutting it fails safe_apply's connectivity probe and OpenWrt restores
#: the old config on its own.
_MANAGEMENT_REASON = (
    "This is the jack this dashboard reaches your appliance through, and "
    "something is plugged into it. Turning it off will cut your own connection "
    "— the appliance puts it back automatically after a minute."
)


def is_wan_port(port: dict) -> bool:
    """Whether this jack carries the upstream internet connection.

    Reads the ``networks`` list, NOT the derived ``role``. ``role`` is the first
    network with a role we recognise, so a jack carrying ``["lan", "wan"]``
    derives ``role="lan"`` — gating on the role alone would wave the WAN jack
    straight through the guard that exists for it.
    """
    return any(n in _WAN_NETWORKS for n in port.get("networks") or [])


def disable_guard(
    port: dict,
    is_management_interface: Callable[[str], bool],
) -> Optional[dict]:
    """The extra confirmation turning this jack OFF requires, or ``None``.

    ``None`` means an ordinary Tier-2 confirm is enough. A dict means the write
    is refused with 409 + ``code`` unless the caller passes ``force`` — the
    explicit acknowledgement, the same shape the interface writes use.

    Enabling a jack is never guarded: it has no blast radius, and requiring the
    same ceremony to restore the WAN as to cut it would be backwards.
    """
    if is_wan_port(port):
        # Checked first. A jack that is BOTH the WAN and a live management path
        # gets the WAN refusal, because that is the one with no automatic undo
        # and therefore the one the copy has to describe.
        return {"code": GUARD_WAN_PORT, "reason": _WAN_REASON}

    # Link state is half the test: on the RB5009 every LAN jack is a `br-lan`
    # member, so "carries a management network" alone describes five empty
    # jacks that are carrying nothing at all.
    if port.get("link_up") and any(
        is_management_interface(n) for n in port.get("networks") or []
    ):
        return {"code": GUARD_MANAGEMENT_PORT, "reason": _MANAGEMENT_REASON}

    return None


def annotate_write_guards(
    port_map: dict,
    is_management_interface: Callable[[str], bool],
) -> dict:
    """Publish :func:`disable_guard` on every port of a ``GET /network/ports``
    payload, as ``disable_guard``.

    The dashboard needs to know *before* it opens a confirm dialog whether this
    jack needs the extra acknowledgement and which sentence to show — and the
    management-interface list is deployment configuration
    (``DROPLET_MGMT_INTERFACES``) that no client can know. Publishing the
    verdict keeps one source of policy instead of a second, drifting copy in
    TypeScript.
    """
    ports = port_map.get("ports")
    if not isinstance(ports, list):
        return port_map
    return {
        **port_map,
        "ports": [
            {**p, "disable_guard": disable_guard(p, is_management_interface)}
            for p in ports
        ],
    }


def resolve_members(
    device: str,
    devices: dict[str, dict],
    _seen: Optional[set[str]] = None,
) -> list[str]:
    """Resolve a netdev name to the physical jacks that carry its traffic.

    A bridge resolves to its member ports; a VLAN resolves to whatever its
    parent resolves to (the VLAN rides the parent's jacks); anything else is a
    jack and resolves to itself.

    A VLAN is recognised two ways, and BOTH are load-bearing: an explicit uci
    ``config device`` of type 8021q/8021ad, and — the case that shipped as a
    bug — the implicit ``<parent>.<vid>`` name with no section at all. Falling
    through to "it's a jack" on the implicit form put a VLAN sub-interface on
    the faceplate as physical hardware, and it also mis-attributed the parent:
    the real jack carrying the camera VLAN reported only ``lan``, never
    ``cameras``. Resolving to the parent fixes both halves at once.

    ``_seen`` breaks a cycle in a hand-edited config — a VLAN whose parent
    chain loops back would otherwise recurse forever on a live router.
    """
    if not device:
        return []
    seen = _seen if _seen is not None else set()
    if device in seen:
        logger.warning("uci device cycle at %r; stopping resolution", device)
        return []
    seen.add(device)

    section = devices.get(device)
    if section is None:
        # No uci section. Before calling it a jack, check the name for netifd's
        # implicit VLAN form — the parent is the thing that has a socket on it.
        parent = vlan_parent(device)
        if parent:
            return resolve_members(parent, devices, seen)
        return [device]

    section_type = str(section.get("type") or "")
    if section_type in _BRIDGE_TYPES:
        members: list[str] = []
        for port in _as_list(section.get("ports")):
            members.extend(resolve_members(port, devices, seen))
        return members
    if section_type in _VLAN_TYPES:
        parent = section.get("ifname")
        return resolve_members(parent, devices, seen) if isinstance(parent, str) else []
    return [device]


def board_roster(board: Any) -> list[str]:
    """Physical port names from ``board.json``'s ``network`` block.

    This is the only source that knows about a jack the current config does not
    use — the RB5009's SFP cage is listed here and appears nowhere in uci. Both
    shapes are handled: ``{"ports": [...]}`` (a switch-backed board) and
    ``{"device": "eth1"}`` (a single-NIC-per-role board like the Pi).
    """
    if not isinstance(board, dict):
        return []
    network = board.get("network")
    if not isinstance(network, dict):
        return []
    out: list[str] = []
    for role in network.values():
        if not isinstance(role, dict):
            continue
        for name in _as_list(role.get("ports")):
            out.append(name)
        device = role.get("device")
        if isinstance(device, str) and device:
            out.append(device)
    return out


def _sort_key(name: str) -> tuple:
    """Order jacks the way they sit on the faceplate.

    Natural sort on the trailing number (p2 before p10, eth0 before eth1),
    grouped by the alphabetic stem, with a nameless-number port last. Fibre
    cages sort after copper — which is where they physically are on the
    RB5009, and how the switch faceplate already draws them.
    """
    m = re.fullmatch(r"([A-Za-z_-]*)(\d*)", name or "")
    stem, digits = (m.group(1), m.group(2)) if m else (name, "")
    return (1 if is_sfp(name) else 0, stem, int(digits) if digits else -1, name)


def derive_ports(
    board: Any,
    uci_network: Any,
    device_status: Any,
) -> list[dict]:
    """Join the three reads into the physical port map.

    Roster = every jack named by ``board.json`` ∪ every jack any uci interface
    resolves to. Bridges, VLAN devices and loopback are excluded structurally;
    so is the DSA conduit, which is named by neither source (module docstring).
    """
    sections = _uci_sections(uci_network)
    devices = _device_sections(uci_network)
    statuses = device_status.get("values") if isinstance(device_status, dict) else None
    if not isinstance(statuses, dict):
        statuses = device_status if isinstance(device_status, dict) else {}

    # netdev → the uci interfaces whose traffic reaches it, in config order.
    networks_by_port: dict[str, list[str]] = {}
    for section in sections.values():
        if section.get(".type") != "interface":
            continue
        name = section.get(".name")
        device = section.get("device")
        if not isinstance(name, str) or not isinstance(device, str):
            continue
        for member in resolve_members(device, devices):
            networks_by_port.setdefault(member, [])
            if name not in networks_by_port[member]:
                networks_by_port[member].append(name)

    roster: list[str] = []
    for name in [*board_roster(board), *networks_by_port]:
        if not name or name in _NEVER_A_PORT or name in roster:
            continue
        # A name that IS a bridge or a VLAN is logical, not a jack. It can reach
        # here from board.json on a board whose factory config bridges in
        # software; its members are already in the roster via resolve_members.
        #
        # Tested three ways, because no single one of them covers every config:
        #   1. an explicit uci `config device` section type;
        #   2. netifd's implicit `<parent>.<vid>` name — the form with NO
        #      section, which both shipping shapes use (see _VLAN_SUFFIX_RE);
        #   3. what the device itself reports. `network.device status` already
        #      told us `devtype: "vlan"` / `type: "8021q"`; the first version of
        #      this module never read it, and paid for it.
        section_type = str(devices.get(name, {}).get("type") or "")
        if section_type in _BRIDGE_TYPES or section_type in _VLAN_TYPES:
            continue
        if vlan_parent(name):
            continue
        reported = statuses.get(name) if isinstance(statuses.get(name), dict) else {}
        if (
            str(reported.get("devtype") or "") in _LOGICAL_DEVTYPES
            or str(reported.get("type") or "") in _LOGICAL_TYPES
        ):
            continue
        roster.append(name)

    ports: list[dict] = []
    for name in sorted(roster, key=_sort_key):
        status = statuses.get(name)
        networks = [n for n in networks_by_port.get(name, []) if n not in _NEVER_A_PORT]
        # Role follows the FIRST interface that has a role we know. `wan` and
        # `wan6` share a jack, and a bridge port carries both `lan` and the
        # `guest` VLAN — the port is a lan port that also trunks guest, not a
        # guest port.
        role = "unused"
        for network in networks:
            mapped = _ROLE_BY_NETWORK.get(network)
            if mapped:
                role = mapped
                break
        else:
            if networks:
                role = "other"

        if not isinstance(status, dict):
            # No netifd object: an empty SFP cage, or a jack the running config
            # never realised. Absent — never a fabricated "down" row.
            ports.append({
                "id": name,
                "role": role,
                "networks": networks,
                "present": False,
                "admin_up": None,
                "link_up": False,
                "speed": None,
                "duplex": None,
                "mac": None,
                "is_sfp": is_sfp(name),
                "traffic": None,
                "status": "absent",
            })
            continue

        admin_up = bool(status.get("up"))
        # THE load-bearing line: carrier, not up. See the module docstring.
        link_up = bool(status.get("carrier"))
        speed, duplex = parse_speed(status.get("speed"))
        mac = status.get("macaddr")
        ports.append({
            "id": name,
            "role": role,
            "networks": networks,
            "present": True,
            "admin_up": admin_up,
            "link_up": link_up,
            "speed": speed if link_up else None,
            "duplex": duplex if link_up else None,
            "mac": mac if isinstance(mac, str) and mac else None,
            "is_sfp": is_sfp(name),
            "traffic": parse_traffic(status.get("statistics")),
            "status": "online" if link_up else ("offline" if admin_up else "disabled"),
        })
    return ports


def get_router_ports(router) -> dict:
    """``GET /network/ports`` — the physical port map, or an honest refusal.

    ``supported: false`` when the router reports no physical port roster at all
    (a shape whose board.json carries no network block and whose interfaces
    resolve to nothing we can call a jack — e.g. a containerised OpenWrt whose
    "ports" are veth pairs owned by the host). The dashboard renders the
    ``detail`` instead of an empty faceplate, which would read as "your router
    has no ports".

    ``board.json`` is optional: a build without ``luci-rpc`` still yields the
    configured jacks from uci, just without any cage the config doesn't use. A
    real ubus fault on the two required reads propagates — an unreachable
    router must surface as unreachable, never as an all-dark faceplate.
    """
    try:
        device_status = router.network.device_status()
        uci_network = router.uci.get("network")
    except AttributeError:
        # A router shape with no device_status surface at all — ROUTING_MODE=mock,
        # whose MockRouter implements the wireless/dhcp/firewall reads but not
        # this one. Same degradation the fabric synthesis already does
        # (main.py's `except AttributeError` on the identical call). Without
        # this the route 500s, and the panel's error branch fires BEFORE its
        # `supported` branch — so a shape limitation would render as "we can't
        # reach the router", the exact conflation this contract forbids.
        logger.info("router shape exposes no device_status; reporting no port map")
        return {
            "supported": False,
            "detail": (
                "This deployment's router doesn't report a physical port map."
            ),
            "model": None,
            "ports": [],
        }

    try:
        board = router.system.board_json()
    except Exception as exc:  # noqa: BLE001 — board.json is a bonus, not a dependency
        logger.info("board.json unavailable (%s); roster falls back to uci only", exc)
        board = {}

    ports = derive_ports(board, uci_network, device_status)
    model = None
    if isinstance(board, dict) and isinstance(board.get("model"), dict):
        name = board["model"].get("name")
        model = name if isinstance(name, str) and name else None

    if not ports:
        return {
            "supported": False,
            "detail": (
                "This router doesn't report a physical port map. Its network "
                "interfaces are shown below instead."
            ),
            "model": model,
            "ports": [],
        }
    return {"supported": True, "detail": None, "model": model, "ports": ports}
