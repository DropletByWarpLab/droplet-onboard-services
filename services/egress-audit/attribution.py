"""WARP-268 — attribute a flow's source IP to a compose service.

Sources of truth (fetched via injectable callables so tests never touch
docker): `docker network inspect droplet_default` for container IPs and the
bridge subnet, `ip -j addr` for host-owned IPs. Container names reduce to
service names via the pinned compose project prefix (`droplet-<service>-<n>`,
docker-compose.yml:10) and the explicit container_names (droplet-openwrt,
droplet-cloudflared).

Attribution classes returned by Attributor.resolve():
  "<service>"          bridge container (per-service — the normal case)
  "host"               host-owned source IP: host daemons, dockerd's DNS
                       forwarder, and the network_mode:host services
                       (routing, matter-controller, switch, camera-discovery,
                       oled-display, cloudflared) — aggregate in v1
  "unknown-container"  inside the bridge subnet but not in the (just
                       refreshed) map — race with container churn
  None                 out of audit scope (LAN clients, inbound remotes)
"""
from __future__ import annotations

import ipaddress
import json
import logging
import re
import time
from dataclasses import dataclass
from typing import Callable, Optional

logger = logging.getLogger(__name__)

_REPLICA_SUFFIX = re.compile(r"-\d+$")


def service_from_container_name(name: str) -> str:
    name = name.lstrip("/")
    if name.startswith("droplet-"):
        name = name[len("droplet-"):]
    return _REPLICA_SUFFIX.sub("", name)


@dataclass(frozen=True)
class IpMap:
    by_ip: dict[str, str]
    host_ips: frozenset[str]
    subnets: tuple


def build_ip_map(network_inspect_json: str, ip_addr_json: str) -> IpMap:
    by_ip: dict[str, str] = {}
    subnets = []
    for net in json.loads(network_inspect_json):
        for cfg in (net.get("IPAM") or {}).get("Config") or []:
            if cfg.get("Subnet"):
                subnets.append(ipaddress.ip_network(cfg["Subnet"]))
        for container in (net.get("Containers") or {}).values():
            addr = (container.get("IPv4Address") or "").split("/")[0]
            if addr and container.get("Name"):
                by_ip[addr] = service_from_container_name(container["Name"])
    host_ips: set[str] = set()
    for iface in json.loads(ip_addr_json):
        if iface.get("ifname") == "lo":
            continue
        for addr in iface.get("addr_info") or []:
            if addr.get("local"):
                host_ips.add(addr["local"])
    return IpMap(by_ip=by_ip, host_ips=frozenset(host_ips), subnets=tuple(subnets))


class Attributor:
    def __init__(
        self,
        fetch_network_json: Callable[[], str],
        fetch_ip_addr_json: Callable[[], str],
        clock: Callable[[], float] = time.monotonic,
        refresh_sec: float = 60.0,
        miss_refresh_min_sec: float = 10.0,
    ) -> None:
        self._fetch_network = fetch_network_json
        self._fetch_ip_addr = fetch_ip_addr_json
        self._clock = clock
        self._refresh_sec = refresh_sec
        self._miss_min = miss_refresh_min_sec
        self._map: Optional[IpMap] = None
        self._loaded_at = float("-inf")
        self._last_miss_refresh = float("-inf")
        self._fetch_warned = False

    def _refresh(self) -> None:
        try:
            new_map = build_ip_map(self._fetch_network(), self._fetch_ip_addr())
        except Exception as exc:  # docker down / malformed JSON — keep stale map
            if not self._fetch_warned:
                logger.warning("attribution refresh failed (%s) — keeping stale map", exc)
                self._fetch_warned = True
            return
        self._fetch_warned = False
        self._map = new_map
        self._loaded_at = self._clock()

    def _ensure_fresh(self) -> None:
        if self._map is None or self._clock() - self._loaded_at >= self._refresh_sec:
            self._refresh()

    def resolve(self, src_ip: str) -> Optional[str]:
        self._ensure_fresh()
        m = self._map
        if m is None:
            return None
        if src_ip in m.by_ip:
            return m.by_ip[src_ip]
        if src_ip in m.host_ips:
            return "host"
        try:
            ip = ipaddress.ip_address(src_ip)
        except ValueError:
            return None
        if not any(ip in subnet for subnet in m.subnets):
            return None
        now = self._clock()
        if now - self._last_miss_refresh >= self._miss_min:
            self._last_miss_refresh = now
            self._refresh()
            m = self._map
        return m.by_ip.get(src_ip, "unknown-container") if m else "unknown-container"
