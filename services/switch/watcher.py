"""
Smart-port watcher
==================
Watches three signals on the managed switch and publishes a single
``smart-port/event`` MQTT message whenever any one of them changes
for an access-port device:

  * **MAC table** — new MAC learned on a port (driver.get_mac_table).
  * **PoE class** — a port flips from "no PD" to a class N (or vice
    versa). Cheap proxy for "physical device plugged in / unplugged".
  * **DHCP lease file** — a new lease line appears in the host-bound
    leases file. Confirms the device DHCPed and gives us its IP +
    hostname.

The watcher does **no classification** — that is the agent's job. It
only emits the "something just happened" signal with the union of
evidence it has so far. The agent decides whether the device is a
camera, a workstation, or something else.

Payload shape (per WARP-396 design doc, ``docs/SMART_PORT_AUTOVLAN.md``):

```
{
  "port": 7,
  "mac": "E4:30:22:50:2A:FD",
  "oui": "E4:30:22",
  "poe_class": 3,
  "ip": "192.168.20.176",
  "hostname": "XNV-C8083R-E43022502AFD",
  "source": "mac_table" | "poe_class" | "dhcp_lease",
  "ts": 1779437597
}
```

The watcher keeps a small in-memory dedup window: it will not emit
two events for the same ``(port, mac)`` pair inside 60 s, even if
both the MAC table AND the lease file signal change. The agent's
own per-event cooldown in Phase 4 is the second layer.

Cadence is conservative — every ``WATCH_INTERVAL_S`` seconds (default
5). The Lantronix's web management plane is single-session-friendly
and the keepalive helper in the driver already pings ``/stat/sysinfo``
every 20 s; one more read of ``/stat/dynamic_mac_table`` + one of
``/stat/poe_status`` per cycle is within that envelope.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Optional

import paho.mqtt.client as mqtt

from drivers.base import SwitchDriver, SwitchError

logger = logging.getLogger("droplet.switch.watcher")

# Tunables (env-overridable so we don't have to rebuild the container
# to flip cadence during a POC field test).
WATCH_INTERVAL_S = float(os.environ.get("SMART_PORT_WATCH_INTERVAL_S", "5"))
DEDUP_WINDOW_S = float(os.environ.get("SMART_PORT_DEDUP_WINDOW_S", "60"))
DEFAULT_LEASE_FILE = os.environ.get(
    "SMART_PORT_LEASE_FILE",
    "/var/lib/misc/droplet-poc-lan.leases",
)
TOPIC = "smart-port/event"


def _parse_mqtt_url(url: str) -> tuple[str, int, Optional[str], Optional[str]]:
    """Parse ``mqtt://user:pass@host:port`` into (host, port, user, pw).

    Mirrors the helper in services/camera-discovery so the two services
    treat the broker env the same way.
    """
    from urllib.parse import urlparse

    parsed = urlparse(url)
    host = parsed.hostname or "localhost"
    port = parsed.port or 1883
    user = parsed.username
    password = parsed.password
    return host, port, user, password


@dataclass
class _Signal:
    """One observation the watcher might combine with others before emitting."""

    port: int
    mac: Optional[str]
    poe_class: Optional[int]
    ip: Optional[str]
    hostname: Optional[str]
    source: str  # "mac_table" | "poe_class" | "dhcp_lease"


class SmartPortWatcher:
    """Background loop that bridges switch state changes onto MQTT.

    Lifecycle is owned by the FastAPI lifespan: ``start()`` spawns the
    asyncio task; ``stop()`` cancels it and disconnects from MQTT.
    """

    def __init__(
        self,
        driver: SwitchDriver,
        mqtt_broker_url: str,
        *,
        watch_interval_s: float = WATCH_INTERVAL_S,
        dedup_window_s: float = DEDUP_WINDOW_S,
        lease_file: str = DEFAULT_LEASE_FILE,
        client_id: str = "droplet-switch-watcher",
    ) -> None:
        self._driver = driver
        self._mqtt_broker_url = mqtt_broker_url
        self._watch_interval_s = watch_interval_s
        self._dedup_window_s = dedup_window_s
        self._lease_file = lease_file
        self._client_id = client_id

        self._mqtt: Optional[mqtt.Client] = None
        self._task: Optional[asyncio.Task] = None
        self._stop_event: asyncio.Event = asyncio.Event()

        # State carried across ticks for diff-detection.
        self._known_macs: dict[int, set[str]] = {}  # port -> set of MACs
        self._known_poe: dict[int, Optional[int]] = {}  # port -> last class
        self._known_leases: set[str] = set()  # raw lease line digests
        # (port, mac) -> last-emitted ts (for dedup window).
        self._last_emit: dict[tuple[int, str], float] = {}
        # mac -> last known {ip, hostname} from the lease file (for enrichment).
        self._lease_index: dict[str, dict[str, str]] = {}
        # Set on first scan so we don't fire events for the entire pre-existing
        # MAC table as if every device just got plugged in.
        self._primed = False

    # --- lifecycle ---

    async def start(self) -> None:
        if self._task is not None:
            return
        try:
            self._mqtt = self._connect_mqtt()
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Smart-port watcher cannot reach MQTT broker (%s) — will not emit events",
                exc,
            )
            self._mqtt = None
        self._stop_event.clear()
        self._task = asyncio.create_task(self._run(), name="smart-port-watcher")
        logger.info(
            "Smart-port watcher started (interval=%.1fs, dedup=%.0fs, leases=%s)",
            self._watch_interval_s,
            self._dedup_window_s,
            self._lease_file,
        )

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=5)
            except asyncio.TimeoutError:
                self._task.cancel()
            self._task = None
        if self._mqtt is not None:
            try:
                self._mqtt.loop_stop()
                self._mqtt.disconnect()
            except Exception:  # noqa: BLE001
                pass
            self._mqtt = None
        logger.info("Smart-port watcher stopped")

    # --- main loop ---

    async def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                signals = await self._collect_signals()
                # First tick after start: seed state without emitting. Otherwise
                # plugging the box back in would treat every existing camera
                # as "just appeared".
                if not self._primed:
                    self._primed = True
                    logger.info(
                        "Smart-port watcher primed: %d known MAC(s), %d known port(s)",
                        sum(len(v) for v in self._known_macs.values()),
                        len(self._known_poe),
                    )
                else:
                    for sig in signals:
                        self._maybe_emit(sig)
            except SwitchError as exc:
                logger.debug("Smart-port watcher: switch read failed (%s)", exc)
            except Exception:  # noqa: BLE001
                logger.exception("Smart-port watcher: unexpected error")
            try:
                await asyncio.wait_for(
                    self._stop_event.wait(), timeout=self._watch_interval_s
                )
            except asyncio.TimeoutError:
                pass

    async def _collect_signals(self) -> list[_Signal]:
        signals: list[_Signal] = []

        # 1) Refresh DHCP lease index — used for enrichment + as its own
        # signal source (host-bound file, not switch-derived).
        new_leases = self._read_lease_file()
        if new_leases is not None:
            current_lines = set(new_leases.keys())
            added_lines = current_lines - self._known_leases
            self._known_leases = current_lines
            # Rebuild the mac-keyed enrichment lookup. The raw file map
            # (returned by _read_lease_file) is keyed by the unaltered
            # lease line so we can detect "this exact line is new"; the
            # enrichment index is keyed by uppercase MAC so the mac-table
            # tick can correlate without re-parsing.
            self._lease_index = {
                info["mac"]: info for info in new_leases.values() if info.get("mac")
            }
            if self._primed:
                for line in added_lines:
                    info = new_leases[line]
                    signals.append(_Signal(
                        port=0,  # unknown until the MAC-table tick correlates it
                        mac=info.get("mac"),
                        poe_class=None,
                        ip=info.get("ip"),
                        hostname=info.get("hostname"),
                        source="dhcp_lease",
                    ))

        # 2) MAC table — new MAC on any access port.
        try:
            macs = await self._driver.get_mac_table()
        except SwitchError:
            macs = []
        seen_by_port: dict[int, set[str]] = {}
        for entry in macs:
            port = int(entry["port"])
            mac = entry["mac"].upper()
            seen_by_port.setdefault(port, set()).add(mac)
        for port, current in seen_by_port.items():
            prior = self._known_macs.get(port, set())
            added = current - prior
            for mac in added:
                info = self._lease_index.get(mac, {})
                signals.append(_Signal(
                    port=port,
                    mac=mac,
                    poe_class=None,
                    ip=info.get("ip"),
                    hostname=info.get("hostname"),
                    source="mac_table",
                ))
        self._known_macs = seen_by_port

        # 3) PoE class transitions on PoE-capable ports.
        try:
            poe = await self._driver.get_poe_status()
        except SwitchError:
            poe = []
        for entry in poe:
            port = int(entry.get("port", 0))
            cls_str = (entry.get("class") or "").strip()
            cls: Optional[int] = None
            if cls_str:
                # Format is "Class 3" — pull the trailing int.
                token = cls_str.split()[-1]
                if token.isdigit():
                    cls = int(token)
                elif cls_str.isdigit():
                    cls = int(cls_str)
            prior = self._known_poe.get(port, ...)  # sentinel = unobserved
            if prior is not ... and prior != cls:
                # Real transition. Correlate with the MAC table for this port
                # so the agent can act without waiting for another tick.
                port_macs = self._known_macs.get(port, set())
                mac = next(iter(port_macs), None)
                info = self._lease_index.get(mac or "", {}) if mac else {}
                signals.append(_Signal(
                    port=port,
                    mac=mac,
                    poe_class=cls,
                    ip=info.get("ip"),
                    hostname=info.get("hostname"),
                    source="poe_class",
                ))
            self._known_poe[port] = cls

        return signals

    def _read_lease_file(self) -> Optional[dict[str, dict[str, str]]]:
        """Read the dnsmasq lease file, return {raw_line: {mac, ip, hostname}}.

        dnsmasq leases format: ``<expiry> <mac> <ip> <hostname> <clientid>``
        (one lease per line). Returns ``None`` if the file does not exist —
        which is the normal case until the host sets it up.
        """
        try:
            with open(self._lease_file, "r", encoding="utf-8", errors="replace") as fh:
                lines = fh.readlines()
        except FileNotFoundError:
            return None
        except Exception as exc:  # noqa: BLE001
            logger.debug("Lease file unreadable (%s): %s", self._lease_file, exc)
            return None

        index: dict[str, dict[str, str]] = {}
        for raw in lines:
            parts = raw.strip().split()
            if len(parts) < 4:
                continue
            mac = parts[1].upper()
            ip = parts[2]
            hostname = parts[3] if parts[3] != "*" else ""
            index[raw.strip()] = {"mac": mac, "ip": ip, "hostname": hostname}
        return index

    # --- emit ---

    def _maybe_emit(self, sig: _Signal) -> None:
        if not sig.mac and not sig.ip:
            # Nothing to correlate — drop. The next tick will likely
            # provide either a MAC (from the switch) or an IP (from
            # the lease file) and we'll emit then.
            return
        key = (sig.port, sig.mac or sig.ip or "")
        now = time.time()
        last = self._last_emit.get(key, 0)
        if now - last < self._dedup_window_s:
            logger.debug("Dedup: dropped %s for %s", sig.source, key)
            return
        self._last_emit[key] = now

        payload = {
            "port": sig.port,
            "mac": sig.mac,
            "oui": sig.mac[:8] if sig.mac else None,
            "poe_class": sig.poe_class,
            "ip": sig.ip,
            "hostname": sig.hostname,
            "source": sig.source,
            "ts": int(now),
        }
        # Strip None values so consumers don't have to special-case them.
        payload = {k: v for k, v in payload.items() if v is not None}
        self._publish(payload)
        logger.info("smart-port/event %s", payload)

    def _publish(self, payload: dict) -> None:
        if self._mqtt is None:
            return
        try:
            self._mqtt.publish(TOPIC, json.dumps(payload), qos=1)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Smart-port watcher: MQTT publish failed (%s)", exc)

    # --- MQTT ---

    def _connect_mqtt(self) -> mqtt.Client:
        host, port, user, password = _parse_mqtt_url(self._mqtt_broker_url)
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=self._client_id)
        if user:
            client.username_pw_set(user, password)
        client.connect(host, port, keepalive=60)
        client.loop_start()
        return client
