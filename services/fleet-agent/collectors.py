"""WARP-963 — host telemetry collectors (operational shape ONLY).

Reads /proc for the heartbeat's required fields (uptime, loadavg,
cpu_pct, ram) plus best-effort inventory/network extras. No file names,
no user data, no per-client LAN detail ever leaves this module — that
is the customer-privacy line the fleet design doc draws for heartbeats.

Read failures RAISE (OSError/ValueError); the agent's fail-open tick
wrapper catches, logs, and skips the beat. We deliberately do not
fabricate zeros for unreadable metrics — a missing beat is honest, a
zeroed one lies to the operator dashboard.

CPU percent: first call derives the since-boot average from /proc/stat
(honest without history); subsequent calls diff against the previous
snapshot for an interval reading.
"""

from __future__ import annotations

import platform
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


class HostCollector:
    def __init__(self, firmware_version: str, proc_root: Path = Path("/proc")) -> None:
        self._firmware_version = firmware_version
        self._proc = proc_root
        self._last_cpu: Optional[tuple[int, int]] = None  # (busy, total)

    # ------------------------------------------------------------------
    # Heartbeat (contract-required fields: ts, uptime_s, load, cpu_pct, ram)
    # ------------------------------------------------------------------

    def heartbeat_payload(self, ts: str) -> dict:
        return {
            "ts": ts,
            "uptime_s": self._uptime_s(),
            "load": self._loadavg(),
            "cpu_pct": self._cpu_pct(),
            "ram": self._ram(),
        }

    def metrics_samples(self, ts: str) -> list[dict]:
        load = self._loadavg()
        ram = self._ram()
        return [
            {"ts": ts, "name": "system.load.1m", "value": load["1m"]},
            {"ts": ts, "name": "system.cpu.pct", "value": self._cpu_pct()},
            {"ts": ts, "name": "system.ram.used_mb", "value": ram["used_mb"]},
            {"ts": ts, "name": "system.uptime_s", "value": self._uptime_s()},
        ]

    def inventory_payload(self, ts: str) -> dict:
        payload = {
            "ts": ts,
            "firmware_version": self._firmware_version,
            "kernel": platform.release(),
            "hardware": {"machine": platform.machine()},
        }
        boot_id = self._boot_id()
        if boot_id:
            payload["boot_id"] = boot_id
        return payload

    def network_payload(self, ts: str) -> dict:
        """Operational shape only. Richer VLAN/device data belongs to the
        routing service and lands with the WARP-961 agent unification —
        v1 reports the WAN-ish default-route iface when derivable."""
        payload: dict = {"ts": ts}
        iface = self._default_route_iface()
        if iface:
            payload["wan"] = {"iface": iface}
        return payload

    # ------------------------------------------------------------------
    # /proc readers
    # ------------------------------------------------------------------

    def _read(self, name: str) -> str:
        return (self._proc / name).read_text(encoding="utf-8")

    def _uptime_s(self) -> int:
        return int(float(self._read("uptime").split()[0]))

    def _loadavg(self) -> dict:
        parts = self._read("loadavg").split()
        return {"1m": float(parts[0]), "5m": float(parts[1]), "15m": float(parts[2])}

    def _ram(self) -> dict:
        total_kb = 0
        available_kb = 0
        for line in self._read("meminfo").splitlines():
            if line.startswith("MemTotal:"):
                total_kb = int(line.split()[1])
            elif line.startswith("MemAvailable:"):
                available_kb = int(line.split()[1])
        if total_kb <= 0:
            raise ValueError("meminfo: MemTotal missing")
        used_mb = max(0, (total_kb - available_kb) // 1024)
        return {"used_mb": used_mb, "total_mb": max(1, total_kb // 1024)}

    def _cpu_pct(self) -> float:
        for line in self._read("stat").splitlines():
            if not line.startswith("cpu "):
                continue
            fields = [int(v) for v in line.split()[1:]]
            idle = fields[3] + (fields[4] if len(fields) > 4 else 0)
            total = sum(fields)
            busy = total - idle
            previous, self._last_cpu = self._last_cpu, (busy, total)
            if previous is not None:
                d_total = total - previous[1]
                d_busy = busy - previous[0]
                if d_total > 0:
                    return round(100.0 * d_busy / d_total, 1)
            if total > 0:  # first call: honest since-boot average
                return round(100.0 * busy / total, 1)
            return 0.0
        raise ValueError("stat: aggregate cpu line missing")

    def _boot_id(self) -> Optional[str]:
        try:
            return self._read("sys/kernel/random/boot_id").strip()
        except (OSError, ValueError):
            return None

    def _default_route_iface(self) -> Optional[str]:
        try:
            for line in self._read("net/route").splitlines()[1:]:
                parts = line.split()
                if len(parts) >= 2 and parts[1] == "00000000":
                    return parts[0]
        except (OSError, ValueError):
            return None
        return None
