"""WARP-268 — minimal stdlib pcap-stream + DNS wire-format parsing.

Feeds: `tcpdump -i any -U -w - -s 512 udp port 53` (see collector.py).
Handles the three link types tcpdump emits on this box: Ethernet (1),
Linux cooked SLL (113) and SLL2 (276 — default for `-i any` on modern
libpcap). UDP only in v1 — the stub resolvers and dockerd's forwarder use
UDP; DNS-over-TCP fallback is rare enough to defer (documented in
docs/security/egress-audit.md).
"""
from __future__ import annotations

import ipaddress
import struct
import time
from dataclasses import dataclass
from typing import Callable, Optional

LINKTYPE_ETHERNET = 1
LINKTYPE_LINUX_SLL = 113
LINKTYPE_LINUX_SLL2 = 276

_GLOBAL_HEADER_LEN = 24
_RECORD_HEADER_LEN = 16
_ETHERTYPES_IP = (0x0800, 0x86DD)


class PcapFormatError(ValueError):
    pass


def _strip_link_header(linktype: int, data: bytes) -> Optional[bytes]:
    if linktype == LINKTYPE_ETHERNET:
        if len(data) < 14:
            return None
        ethertype = struct.unpack("!H", data[12:14])[0]
        return data[14:] if ethertype in _ETHERTYPES_IP else None
    if linktype == LINKTYPE_LINUX_SLL:
        if len(data) < 16:
            return None
        ethertype = struct.unpack("!H", data[14:16])[0]
        return data[16:] if ethertype in _ETHERTYPES_IP else None
    if linktype == LINKTYPE_LINUX_SLL2:
        if len(data) < 20:
            return None
        ethertype = struct.unpack("!H", data[0:2])[0]
        return data[20:] if ethertype in _ETHERTYPES_IP else None
    return None


class PcapDecoder:
    """Sans-IO incremental pcap decoder. feed() buffers partial records so
    callers can push arbitrarily-sized chunks straight off a pipe."""

    def __init__(self) -> None:
        self._buf = bytearray()
        self._endian: Optional[str] = None
        self._linktype: Optional[int] = None

    def feed(self, data: bytes) -> list[tuple[float, bytes]]:
        self._buf.extend(data)
        out: list[tuple[float, bytes]] = []
        if self._linktype is None:
            if len(self._buf) < _GLOBAL_HEADER_LEN:
                return out
            magic = struct.unpack("<I", bytes(self._buf[:4]))[0]
            if magic == 0xA1B2C3D4:
                self._endian = "<"
            elif magic == 0xD4C3B2A1:
                self._endian = ">"
            else:
                raise PcapFormatError(f"unknown pcap magic {magic:#010x}")
            self._linktype = struct.unpack(
                self._endian + "IHHiIII", bytes(self._buf[:_GLOBAL_HEADER_LEN])
            )[6]
            del self._buf[:_GLOBAL_HEADER_LEN]
        while len(self._buf) >= _RECORD_HEADER_LEN:
            ts_sec, ts_usec, incl_len, _orig = struct.unpack(
                self._endian + "IIII", bytes(self._buf[:_RECORD_HEADER_LEN])
            )
            if len(self._buf) < _RECORD_HEADER_LEN + incl_len:
                return out
            frame = bytes(self._buf[_RECORD_HEADER_LEN:_RECORD_HEADER_LEN + incl_len])
            del self._buf[:_RECORD_HEADER_LEN + incl_len]
            l3 = _strip_link_header(self._linktype, frame)
            if l3 is not None:
                out.append((ts_sec + ts_usec / 1e6, l3))
        return out


@dataclass(frozen=True)
class UdpDatagram:
    src: str
    dst: str
    sport: int
    dport: int
    payload: bytes


def parse_ip_udp(l3: bytes) -> Optional[UdpDatagram]:
    if not l3:
        return None
    version = l3[0] >> 4
    if version == 4:
        if len(l3) < 20:
            return None
        ihl = (l3[0] & 0x0F) * 4
        if l3[9] != 17 or len(l3) < ihl + 8:
            return None
        src = str(ipaddress.IPv4Address(l3[12:16]))
        dst = str(ipaddress.IPv4Address(l3[16:20]))
        udp = l3[ihl:]
    elif version == 6:
        if len(l3) < 48 or l3[6] != 17:
            return None
        src = str(ipaddress.IPv6Address(l3[8:24]))
        dst = str(ipaddress.IPv6Address(l3[24:40]))
        udp = l3[40:]
    else:
        return None
    sport, dport = struct.unpack("!HH", udp[:4])
    return UdpDatagram(src=src, dst=dst, sport=sport, dport=dport, payload=udp[8:])


def _read_name(buf: bytes, off: int, depth: int = 0) -> tuple[Optional[str], int]:
    """(name, offset_after_field). Compression pointers must point backwards;
    depth guard kills pointer loops."""
    if depth > 10:
        return None, off
    labels: list[str] = []
    while True:
        if off >= len(buf):
            return None, off
        length = buf[off]
        if length == 0:
            off += 1
            break
        if length & 0xC0 == 0xC0:
            if off + 1 >= len(buf):
                return None, off
            ptr = ((length & 0x3F) << 8) | buf[off + 1]
            if ptr >= off:
                return None, off
            tail, _ = _read_name(buf, ptr, depth + 1)
            if tail is None:
                return None, off
            labels.append(tail)
            return ".".join(labels).lower(), off + 2
        off += 1
        if off + length > len(buf):
            return None, off
        try:
            labels.append(buf[off:off + length].decode("ascii"))
        except UnicodeDecodeError:
            return None, off
        off += length
    return ".".join(labels).lower(), off


@dataclass(frozen=True)
class DnsMessage:
    txid: int
    is_response: bool
    qname: str
    answers: tuple[tuple[str, int], ...]


def parse_dns_message(payload: bytes) -> Optional[DnsMessage]:
    if len(payload) < 12:
        return None
    txid, flags, qdcount, ancount, _ns, _ar = struct.unpack("!HHHHHH", payload[:12])
    if qdcount < 1:
        return None
    qname, off = _read_name(payload, 12)
    if qname is None:
        return None
    off += 4  # QTYPE + QCLASS
    for _ in range(qdcount - 1):
        name, off = _read_name(payload, off)
        if name is None:
            return None
        off += 4
    answers: list[tuple[str, int]] = []
    for _ in range(ancount):
        name, off = _read_name(payload, off)
        if name is None or len(payload) < off + 10:
            break
        rtype, _rclass, ttl, rdlen = struct.unpack("!HHIH", payload[off:off + 10])
        off += 10
        rdata = payload[off:off + rdlen]
        off += rdlen
        if rtype == 1 and rdlen == 4:
            answers.append((str(ipaddress.IPv4Address(rdata)), ttl))
        elif rtype == 28 and rdlen == 16:
            answers.append((str(ipaddress.IPv6Address(rdata)), ttl))
    return DnsMessage(
        txid=txid,
        is_response=bool(flags & 0x8000),
        qname=qname,
        answers=tuple(answers),
    )


class DnsCache:
    """IP → hostnames observed in DNS answers. Answers are keyed to the
    QUESTION name, which collapses CNAME chains onto the name the client
    asked for — exactly what allowed-egress.yaml lists."""

    MIN_TTL = 300.0

    def __init__(self, clock: Callable[[], float] = time.time,
                 max_entries: int = 4096) -> None:
        self._clock = clock
        self._max = max_entries
        self._by_ip: dict[str, dict[str, float]] = {}

    def observe(self, msg: Optional[DnsMessage]) -> None:
        if msg is None or not msg.is_response or not msg.qname:
            return
        now = self._clock()
        for ip, ttl in msg.answers:
            expiry = now + max(float(ttl), self.MIN_TTL)
            names = self._by_ip.setdefault(ip, {})
            names[msg.qname] = max(names.get(msg.qname, 0.0), expiry)
        while len(self._by_ip) > self._max:
            self._by_ip.pop(next(iter(self._by_ip)))

    def names_for(self, ip: str) -> frozenset[str]:
        now = self._clock()
        names = self._by_ip.get(ip)
        if not names:
            return frozenset()
        live = {n: e for n, e in names.items() if e > now}
        if not live:
            del self._by_ip[ip]
            return frozenset()
        self._by_ip[ip] = live
        return frozenset(live)
