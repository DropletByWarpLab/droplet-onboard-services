"""WARP-268 — pcap stream + DNS wire parsing + resolution cache."""
from __future__ import annotations

import pytest

from dns_wire import (
    DnsCache,
    PcapDecoder,
    PcapFormatError,
    parse_dns_message,
    parse_ip_udp,
)
from pcap_builder import (
    LINKTYPE_ETHERNET,
    LINKTYPE_LINUX_SLL2,
    dns_name,
    dns_query,
    dns_response_a,
    eth_frame,
    ipv4_udp,
    pcap,
    sll2_frame,
)


class TestKnownAnswerBytes:
    def test_dns_name_encoding_is_wire_exact(self):
        # Byte-level anchor so pcap_builder and dns_wire can't share a bug.
        assert dns_name("api.anthropic.com") == b"\x03api\x09anthropic\x03com\x00"

    def test_response_a_record_bytes(self):
        msg = dns_response_a(0x1234, "api.anthropic.com", ["160.79.104.10"], ttl=300)
        assert msg.endswith(
            b"\xc0\x0c\x00\x01\x00\x01\x00\x00\x01\x2c\x00\x04\xa0\x4f\x68\x0a"
        )


class TestDnsMessage:
    def test_parse_query(self):
        msg = parse_dns_message(dns_query(0x1234, "API.Anthropic.Com"))
        assert msg is not None
        assert (msg.txid, msg.is_response) == (0x1234, False)
        assert msg.qname == "api.anthropic.com"
        assert msg.answers == ()

    def test_parse_response_follows_compression_pointer(self):
        msg = parse_dns_message(
            dns_response_a(0x1234, "api.anthropic.com", ["160.79.104.10", "160.79.104.11"])
        )
        assert msg.is_response
        assert msg.answers == (("160.79.104.10", 300), ("160.79.104.11", 300))

    def test_malformed_returns_none(self):
        assert parse_dns_message(b"\x00\x01") is None
        # forward compression pointer (offset >= its own position) is malformed
        bad = dns_query(1, "a.example")[:12] + b"\xc0\x20\x00\x01\x00\x01"
        assert parse_dns_message(bad) is None


class TestPcapDecoder:
    def _stream(self, linktype, framer):
        query = ipv4_udp("192.168.1.87", "1.1.1.1", 40000, 53, dns_query(7, "example.com"))
        reply = ipv4_udp("1.1.1.1", "192.168.1.87", 53, 40000,
                         dns_response_a(7, "example.com", ["93.184.216.34"]))
        return pcap(linktype, [(1751600000.25, framer(query)), (1751600000.5, framer(reply))])

    def test_sll2_stream_roundtrip(self):
        dec = PcapDecoder()
        pkts = dec.feed(self._stream(LINKTYPE_LINUX_SLL2, sll2_frame))
        assert len(pkts) == 2
        ts, l3 = pkts[0]
        assert ts == pytest.approx(1751600000.25)
        d = parse_ip_udp(l3)
        assert (d.src, d.dst, d.sport, d.dport) == ("192.168.1.87", "1.1.1.1", 40000, 53)

    def test_ethernet_stream_roundtrip(self):
        pkts = PcapDecoder().feed(self._stream(LINKTYPE_ETHERNET, eth_frame))
        assert len(pkts) == 2

    def test_incremental_single_byte_feeds(self):
        data = self._stream(LINKTYPE_LINUX_SLL2, sll2_frame)
        dec = PcapDecoder()
        pkts = []
        for i in range(len(data)):
            pkts.extend(dec.feed(data[i:i + 1]))
        assert len(pkts) == 2

    def test_bad_magic_raises(self):
        with pytest.raises(PcapFormatError):
            PcapDecoder().feed(b"\x00" * 24)


class TestDnsCache:
    def test_observe_then_names_for(self):
        now = [1000.0]
        cache = DnsCache(clock=lambda: now[0])
        cache.observe(parse_dns_message(
            dns_response_a(1, "api.anthropic.com", ["160.79.104.10"], ttl=600)))
        assert cache.names_for("160.79.104.10") == frozenset({"api.anthropic.com"})
        assert cache.names_for("8.8.8.8") == frozenset()

    def test_ttl_expiry_with_min_floor(self):
        now = [1000.0]
        cache = DnsCache(clock=lambda: now[0])
        cache.observe(parse_dns_message(
            dns_response_a(1, "cdn.example", ["1.2.3.4"], ttl=1)))  # floored to 300
        now[0] = 1299.0
        assert cache.names_for("1.2.3.4") == frozenset({"cdn.example"})
        now[0] = 1301.0
        assert cache.names_for("1.2.3.4") == frozenset()

    def test_queries_never_populate_cache(self):
        cache = DnsCache(clock=lambda: 0.0)
        cache.observe(parse_dns_message(dns_query(1, "example.com")))
        assert cache.names_for("93.184.216.34") == frozenset()
