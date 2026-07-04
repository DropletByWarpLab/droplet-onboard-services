"""WARP-268 — egress-audit collector: pipeline core + async runners + main().

The Pipeline is pure and fully unit-tested (tests/test_pipeline.py). The
async runners at the bottom are the only code that touches subprocesses
(conntrack, tcpdump, docker, ip) and are exercised on hardware only — see
docs/security/egress-audit.md "Stack verification".

Supervision loops here are event-driven dispatch (await readline / restart
after child exit), NOT timer scheduling — explicitly outside the CLAUDE.md
"no `while True` for scheduling" rule's scope (its carve-out list).
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable, Optional

from allowlist import Allowlist, AllowlistError, load_allowlist, match
from attribution import Attributor
from conntrack_parse import FlowEvent, parse_conntrack_line
from dns_wire import DnsCache, PcapDecoder, UdpDatagram, parse_dns_message, parse_ip_udp
from events import Anomaly, AnomalyGate, EgressRecord, proto_class
from sink import NdjsonSink, OrchestratorClient

logger = logging.getLogger("droplet-egress-audit")

CONNTRACK_CMD = ("conntrack", "-E", "-e", "NEW,DESTROY", "-o", "timestamp")
TCPDUMP_CMD = ("tcpdump", "-i", "any", "-U", "-n", "-s", "512", "-w", "-",
               "udp", "port", "53")
RESPAWN_DELAY_SEC = 5.0


def _is_global(ip_text: str) -> bool:
    try:
        return ipaddress.ip_address(ip_text).is_global
    except ValueError:
        return False


class FileAllowlistProvider:
    def __init__(self, path: Path) -> None:
        self._path = Path(path)
        self._mtime: Optional[float] = None
        self._cached: Optional[Allowlist] = None
        self._error_logged = False

    def __call__(self) -> Optional[Allowlist]:
        try:
            mtime = self._path.stat().st_mtime
        except OSError:
            mtime = None
        if mtime is not None and mtime == self._mtime and self._cached is not None:
            return self._cached
        self._mtime = mtime
        if mtime is None:
            if not self._error_logged:
                logger.warning("allowlist %s missing — flows unclassified until "
                               "WARP-269's file lands", self._path)
                self._error_logged = True
            self._cached = None
            return None
        try:
            self._cached = load_allowlist(self._path.read_text())
            self._error_logged = False
            for problem in self._cached.problems:
                logger.warning("allowlist entry skipped: %s", problem)
        except (OSError, AllowlistError) as exc:
            if not self._error_logged:
                logger.warning("allowlist %s unusable (%s) — flows unclassified",
                               self._path, exc)
                self._error_logged = True
            self._cached = None
        return self._cached


class Pipeline:
    def __init__(self, *, attributor: Attributor,
                 allowlist_provider: Callable[[], Optional[Allowlist]],
                 dns_cache: DnsCache, gate: AnomalyGate, sink, orchestrator,
                 clock: Callable[[], float] = time.time) -> None:
        self._attributor = attributor
        self._allowlist_provider = allowlist_provider
        self._dns_cache = dns_cache
        self._gate = gate
        self._sink = sink
        self._orchestrator = orchestrator
        self._clock = clock

    def _emit_anomaly(self, anomaly: Anomaly) -> None:
        if self._gate.admit(anomaly):
            self._orchestrator.post_anomaly(anomaly.to_payload())

    def handle_conntrack_line(self, line: str) -> None:
        event = parse_conntrack_line(line)
        if event is None:
            return
        service = self._attributor.resolve(event.src)
        if service is None or not _is_global(event.dst):
            return
        ts = event.ts if event.ts is not None else self._clock()
        names = self._dns_cache.names_for(event.dst)
        dst_name = sorted(names)[0] if names else None
        allowlist = self._allowlist_provider()
        if allowlist is None:
            allowed: Optional[bool] = None
            policy: Optional[str] = "allowlist-unavailable"
            self._emit_anomaly(Anomaly(kind="allowlist_unavailable",
                                       service="_collector", ts=ts))
        else:
            rule = match(allowlist, service=service, dst_ip=event.dst,
                         port=event.dport, protocol=proto_class(event.proto),
                         dst_names=names)
            allowed = rule is not None
            policy = rule.key if rule else None
        record = EgressRecord(
            event="flow_start" if event.event == "new" else "flow_end",
            ts=ts, service=service, src=event.src, dst=event.dst,
            proto=event.proto, port=event.dport,
            bytes_out=event.bytes_out, bytes_in=event.bytes_in,
            allowed=allowed, policy=policy, dst_name=dst_name,
        )
        self._sink.write(record.to_json_line())
        if allowed is False:
            self._emit_anomaly(Anomaly(
                kind="unlisted_destination", service=service, ts=ts,
                dst=event.dst, dst_name=dst_name, port=event.dport,
                proto=event.proto,
            ))

    def handle_dns_packet(self, ts: float, datagram: Optional[UdpDatagram]) -> None:
        if datagram is None:
            return
        message = parse_dns_message(datagram.payload)
        if message is None:
            return
        if message.is_response:
            self._dns_cache.observe(message)
            return
        if datagram.dport != 53:
            return
        service = self._attributor.resolve(datagram.src)
        if service is None:
            return
        record = EgressRecord(
            event="dns_query", ts=ts, service=service, src=datagram.src,
            dst=datagram.dst, proto="udp", port=53, bytes_out=None,
            bytes_in=None, allowed=None, policy=None, qname=message.qname,
        )
        self._sink.write(record.to_json_line())


# --- host-only plumbing below (verified on the box, not unit-tested) --------

def _docker_network_json() -> str:
    network = os.environ.get("DROPLET_EGRESS_NETWORK", "droplet_default")
    return subprocess.run(
        ["docker", "network", "inspect", network],
        check=True, capture_output=True, text=True, timeout=10,
    ).stdout


def _ip_addr_json() -> str:
    return subprocess.run(
        ["ip", "-j", "addr"],
        check=True, capture_output=True, text=True, timeout=10,
    ).stdout


async def _run_conntrack(pipeline: Pipeline) -> None:
    while True:  # supervision (respawn on child exit), not scheduling
        proc = await asyncio.create_subprocess_exec(
            *CONNTRACK_CMD, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL)
        assert proc.stdout is not None
        while True:
            raw = await proc.stdout.readline()
            if not raw:
                break
            pipeline.handle_conntrack_line(raw.decode("utf-8", "replace"))
        code = await proc.wait()
        logger.warning("conntrack exited (%s) — respawning in %ss",
                       code, RESPAWN_DELAY_SEC)
        await asyncio.sleep(RESPAWN_DELAY_SEC)


async def _run_tcpdump(pipeline: Pipeline) -> None:
    while True:  # supervision, not scheduling
        proc = await asyncio.create_subprocess_exec(
            *TCPDUMP_CMD, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL)
        assert proc.stdout is not None
        decoder = PcapDecoder()
        while True:
            chunk = await proc.stdout.read(65536)
            if not chunk:
                break
            for ts, l3 in decoder.feed(chunk):
                pipeline.handle_dns_packet(ts, parse_ip_udp(l3))
        code = await proc.wait()
        logger.warning("tcpdump exited (%s) — respawning in %ss",
                       code, RESPAWN_DELAY_SEC)
        await asyncio.sleep(RESPAWN_DELAY_SEC)


def build_pipeline() -> Pipeline:
    log_dir = Path(os.environ.get("DROPLET_EGRESS_LOG_DIR",
                                  "/var/lib/droplet/egress-audit"))
    allowlist_path = Path(os.environ["DROPLET_EGRESS_ALLOWLIST"])
    return Pipeline(
        attributor=Attributor(_docker_network_json, _ip_addr_json),
        allowlist_provider=FileAllowlistProvider(allowlist_path),
        dns_cache=DnsCache(),
        gate=AnomalyGate(),
        sink=NdjsonSink(log_dir),
        orchestrator=OrchestratorClient(
            os.environ.get("DROPLET_EGRESS_ORCHESTRATOR_URL",
                           "http://127.0.0.1:3000"),
            os.environ.get("SERVICE_TOKEN_EGRESS_AUDIT", ""),
        ),
    )


async def _main_async() -> None:
    pipeline = build_pipeline()
    logger.info("egress-audit collector starting (conntrack + port-53 capture)")
    await asyncio.gather(_run_conntrack(pipeline), _run_tcpdump(pipeline))


def main() -> None:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(name)s %(levelname)s %(message)s")
    try:
        asyncio.run(_main_async())
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
