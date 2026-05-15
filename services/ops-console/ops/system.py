"""Host-system telemetry — CPU / memory / disk / network / uptime.

Scope: things the OPERATOR cares about when remote-debugging an
appliance in the field. Not customer-visible (the dashboard already
exposes a sanitised "is everything healthy?" view).

Container-vs-host caveat
------------------------
psutil reads /proc — which in a containerised deployment shows the
CONTAINER's view, not the host's. Concretely:

  * CPU + memory   — accurate to host (cgroup-shared by default)
  * load avg       — accurate to host (kernel-scope)
  * processes      — container-local (shows only ops-console's pid 1)
  * uptime         — container-local (since container start, not host)
  * disks          — container-local (overlay rootfs, not host fs)
  * network ifaces — container-local (eth0 = bridge endpoint, no eth*)

To get host-accurate readings, add to docker-compose.yml's ops-console
service: `pid: host` (real process list + uptime) and
`volumes: - /:/hostfs:ro` (real disk usage; system.py would then need
to scan /hostfs/proc/mounts). Deliberately NOT enabled today — it
expands the attack surface for a tool that already mounts docker.sock.
Revisit when ops needs disk-full alerting.

Design notes
------------
* psutil works the same on Linux + Windows, so dev box and POC produce
  identical shapes — we don't have to fork the response model per OS.
* Every reading is a snapshot, not a stream. The UI polls /ops/system
  at whatever cadence makes sense (default 5s). Streaming would force
  websockets which adds reconnect / proxy headache for a 1-operator
  tool. Revisit if we ever fan out to >5 operators.
* CPU percent on first call returns 0.0 (psutil quirk — it needs a
  delta). We do a primed module-load call so the first /ops/system
  hit returns a real number.
* Disks: only mountpoints that look like real filesystems. We skip
  loop / tmpfs / overlay / squashfs because container layers add a
  dozen entries the operator does not care about.
* Network: per-interface byte counters since boot. The UI computes
  rate by diffing two consecutive samples — keeps this module
  stateless.
"""
from __future__ import annotations

import logging
import socket
import time
from dataclasses import dataclass, field, asdict
from typing import Any

import psutil

logger = logging.getLogger("ops.system")

# Mountpoint filesystems we ignore — pure kernel / container plumbing
# that adds noise without telling the operator anything actionable.
# Match by fstype string (psutil.disk_partitions returns it raw).
_BORING_FSTYPES = frozenset({
    "tmpfs", "devtmpfs", "squashfs", "overlay", "overlay2",
    "proc", "sysfs", "cgroup", "cgroup2", "pstore", "bpf",
    "tracefs", "debugfs", "configfs", "fusectl", "mqueue",
    "hugetlbfs", "autofs", "binfmt_misc", "ramfs",
})

# Prime psutil's CPU sampler at module load — its first cpu_percent()
# call returns 0.0 because it needs a delta. By calling once here,
# the first /ops/system request gets a real reading. Cheap (<1ms).
psutil.cpu_percent(interval=None)


@dataclass
class CpuInfo:
    percent: float                    # overall 0..100
    per_core: list[float]             # 0..100 per logical CPU
    load_avg_1m: float | None         # None on Windows
    load_avg_5m: float | None
    load_avg_15m: float | None
    cores_logical: int
    cores_physical: int | None        # None on some virt hosts


@dataclass
class MemInfo:
    total_bytes: int
    available_bytes: int
    used_bytes: int
    percent: float                    # 0..100
    swap_total_bytes: int
    swap_used_bytes: int
    swap_percent: float


@dataclass
class DiskMount:
    mountpoint: str
    fstype: str
    device: str
    total_bytes: int
    used_bytes: int
    free_bytes: int
    percent: float                    # 0..100


@dataclass
class NetIface:
    name: str
    is_up: bool
    addrs: list[str]                  # IPv4/IPv6 strings (no MAC)
    mac: str | None
    bytes_sent: int                   # since boot
    bytes_recv: int
    packets_sent: int
    packets_recv: int
    errors_in: int
    errors_out: int
    drops_in: int
    drops_out: int


@dataclass
class HostInfo:
    hostname: str
    boot_time_epoch: float            # seconds since epoch
    uptime_seconds: float             # convenience: now - boot_time
    process_count: int


@dataclass
class SystemSnapshot:
    timestamp: float                  # epoch seconds when sampled
    host: HostInfo
    cpu: CpuInfo
    memory: MemInfo
    disks: list[DiskMount]
    network: list[NetIface]


def _load_avg() -> tuple[float | None, float | None, float | None]:
    """psutil.getloadavg() exists on POSIX; raises on Windows. We
    swallow + return None so the dataclass stays honest about platform
    differences instead of fabricating a number."""
    try:
        one, five, fifteen = psutil.getloadavg()
        return one, five, fifteen
    except (AttributeError, OSError):
        return None, None, None


def _cpu_info() -> CpuInfo:
    one, five, fifteen = _load_avg()
    return CpuInfo(
        percent=psutil.cpu_percent(interval=None),
        per_core=psutil.cpu_percent(interval=None, percpu=True),
        load_avg_1m=one,
        load_avg_5m=five,
        load_avg_15m=fifteen,
        cores_logical=psutil.cpu_count(logical=True) or 0,
        cores_physical=psutil.cpu_count(logical=False),
    )


def _mem_info() -> MemInfo:
    vm = psutil.virtual_memory()
    sw = psutil.swap_memory()
    return MemInfo(
        total_bytes=vm.total,
        available_bytes=vm.available,
        used_bytes=vm.used,
        percent=vm.percent,
        swap_total_bytes=sw.total,
        swap_used_bytes=sw.used,
        swap_percent=sw.percent,
    )


def _disks() -> list[DiskMount]:
    out: list[DiskMount] = []
    for part in psutil.disk_partitions(all=False):
        if part.fstype.lower() in _BORING_FSTYPES:
            continue
        try:
            usage = psutil.disk_usage(part.mountpoint)
        except (PermissionError, OSError) as exc:
            # Some mountpoints (e.g. CD-ROM with no media, fuse mounts
            # we can't see into) raise. Log debug — the operator can
            # see it in container logs if they're hunting a missing
            # mount, but skip the entry rather than 500 the whole call.
            logger.debug("disk_usage(%s) failed: %s", part.mountpoint, exc)
            continue
        out.append(DiskMount(
            mountpoint=part.mountpoint,
            fstype=part.fstype,
            device=part.device,
            total_bytes=usage.total,
            used_bytes=usage.used,
            free_bytes=usage.free,
            percent=usage.percent,
        ))
    return out


def _network() -> list[NetIface]:
    addrs_by_iface = psutil.net_if_addrs()
    stats_by_iface = psutil.net_if_stats()
    counters_by_iface = psutil.net_io_counters(pernic=True)

    out: list[NetIface] = []
    for name, addrs in addrs_by_iface.items():
        ip_addrs: list[str] = []
        mac: str | None = None
        for a in addrs:
            # psutil.AF_LINK on Windows, socket.AF_PACKET on Linux —
            # both expose the MAC as `a.address`. Test by family value
            # against a name-string check so we don't blow up on the
            # AF that doesn't exist on the current platform.
            family_name = getattr(a.family, "name", str(a.family))
            if family_name in ("AF_PACKET", "AF_LINK"):
                mac = a.address
            elif a.family == socket.AF_INET or a.family == socket.AF_INET6:
                ip_addrs.append(a.address)

        stats = stats_by_iface.get(name)
        counters = counters_by_iface.get(name)
        out.append(NetIface(
            name=name,
            is_up=bool(stats.isup) if stats else False,
            addrs=ip_addrs,
            mac=mac,
            bytes_sent=counters.bytes_sent if counters else 0,
            bytes_recv=counters.bytes_recv if counters else 0,
            packets_sent=counters.packets_sent if counters else 0,
            packets_recv=counters.packets_recv if counters else 0,
            errors_in=counters.errin if counters else 0,
            errors_out=counters.errout if counters else 0,
            drops_in=counters.dropin if counters else 0,
            drops_out=counters.dropout if counters else 0,
        ))
    return out


def _host_info() -> HostInfo:
    boot = psutil.boot_time()
    return HostInfo(
        hostname=socket.gethostname(),
        boot_time_epoch=boot,
        uptime_seconds=max(0.0, time.time() - boot),
        process_count=len(psutil.pids()),
    )


def snapshot() -> SystemSnapshot:
    """Single-shot sample of host telemetry. Cheap (<10ms). Stateless."""
    return SystemSnapshot(
        timestamp=time.time(),
        host=_host_info(),
        cpu=_cpu_info(),
        memory=_mem_info(),
        disks=_disks(),
        network=_network(),
    )


def snapshot_dict() -> dict[str, Any]:
    """Convenience for FastAPI endpoints that prefer plain dicts over
    dataclass-to-pydantic conversion."""
    return asdict(snapshot())
