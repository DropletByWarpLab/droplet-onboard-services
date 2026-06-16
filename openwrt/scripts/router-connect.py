#!/usr/bin/env python3
"""
Droplet inference host -> OpenWrt router connection script
==========================================================
Runs on the inference host (the appliance) to discover and verify
connectivity to the router host.
Can be used standalone or as a systemd service for persistent connection.

Uses the same env vars as the routing service and SDK:
  OPENWRT_HOST      Router IP (default: 192.168.50.1)
  OPENWRT_USERNAME  RPC username (default: droplet-ai)
  OPENWRT_PASSWORD  RPC password (required)

Usage:
    python3 router-connect.py              # One-shot test
    python3 router-connect.py --daemon      # Persistent monitor
    python3 router-connect.py --discover    # mDNS discovery only
"""

import argparse
import json
import os
import socket
import sys
import time
import logging
from urllib.request import Request, urlopen
from urllib.error import URLError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("droplet.router-connect")

# Use the same env vars as the routing service (services/routing/main.py)
DEFAULT_ROUTER_IP = os.environ.get("OPENWRT_HOST", "192.168.50.1")
DEFAULT_USER = os.environ.get("OPENWRT_USERNAME", "droplet-ai")
DEFAULT_PASS = os.environ.get("OPENWRT_PASSWORD", "")

UBUS_PATH = "/ubus"
NULL_SESSION = "00000000000000000000000000000000"


def discover_router_mdns(timeout: float = 5.0) -> str | None:
    """Attempt to discover the Droplet router via mDNS (Droplet.local)."""
    try:
        import subprocess

        result = subprocess.run(
            ["avahi-resolve", "-n", "Droplet.local"],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if result.returncode == 0 and result.stdout.strip():
            ip = result.stdout.strip().split()[-1]
            log.info(f"mDNS discovery: found router at {ip}")
            return ip
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    # Fallback: try direct socket resolution
    try:
        ip = socket.gethostbyname("Droplet.local")
        log.info(f"DNS resolution: found router at {ip}")
        return ip
    except socket.gaierror:
        pass

    log.warning("mDNS discovery failed, using default IP")
    return None


def ubus_call(router_ip: str, session: str, obj: str, method: str, params: dict = None) -> dict:
    """Make a ubus JSON-RPC call to the router."""
    url = f"http://{router_ip}{UBUS_PATH}"
    payload = {
        "jsonrpc": "2.0",
        "id": int(time.time() * 1000),
        "method": "call",
        "params": [session, obj, method, params or {}],
    }
    req = Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def login(router_ip: str, username: str, password: str) -> str:
    """Authenticate and return session token."""
    result = ubus_call(
        router_ip,
        NULL_SESSION,
        "session",
        "login",
        {"username": username, "password": password},
    )
    if result.get("result") and result["result"][0] == 0:
        token = result["result"][1]["ubus_rpc_session"]
        log.info(f"Authenticated as '{username}', session: {token[:8]}...")
        return token
    else:
        raise RuntimeError(f"Login failed: {result}")


def verify_connectivity(router_ip: str, session: str) -> dict:
    """Run a suite of verification calls to confirm full API access."""
    checks = {}

    # System board info
    try:
        result = ubus_call(router_ip, session, "system", "board")
        board = result.get("result", [None, {}])[1]
        checks["system_board"] = {
            "status": "OK",
            "hostname": board.get("hostname", "unknown"),
            "model": board.get("model", "unknown"),
            "release": board.get("release", {}).get("description", "unknown"),
        }
    except Exception as e:
        checks["system_board"] = {"status": "FAIL", "error": str(e)}

    # WAN interface status
    try:
        result = ubus_call(router_ip, session, "network.interface.wan", "status")
        wan = result.get("result", [None, {}])[1]
        checks["wan_interface"] = {
            "status": "OK",
            "up": wan.get("up", False),
            "ipv4": [a["address"] for a in wan.get("ipv4-address", [])],
            "device": wan.get("device", "unknown"),
        }
    except Exception as e:
        checks["wan_interface"] = {"status": "FAIL", "error": str(e)}

    # LAN interface status
    try:
        result = ubus_call(router_ip, session, "network.interface.lan", "status")
        lan = result.get("result", [None, {}])[1]
        checks["lan_interface"] = {
            "status": "OK",
            "up": lan.get("up", False),
            "ipv4": [a["address"] for a in lan.get("ipv4-address", [])],
            "device": lan.get("device", "unknown"),
        }
    except Exception as e:
        checks["lan_interface"] = {"status": "FAIL", "error": str(e)}

    # WiFi status
    try:
        result = ubus_call(router_ip, session, "network.wireless", "status")
        wifi = result.get("result", [None, {}])[1]
        radios = {}
        for radio_name, radio_data in wifi.items():
            radios[radio_name] = {
                "up": radio_data.get("up", False),
                "config": radio_data.get("config", {}).get("band", "unknown"),
            }
        checks["wireless"] = {"status": "OK", "radios": radios}
    except Exception as e:
        checks["wireless"] = {"status": "FAIL", "error": str(e)}

    # UCI read access
    try:
        ubus_call(
            router_ip,
            session,
            "uci",
            "get",
            {"config": "system", "section": "system", "option": "hostname"},
        )
        checks["uci_read"] = {"status": "OK"}
    except Exception as e:
        checks["uci_read"] = {"status": "FAIL", "error": str(e)}

    # DHCP leases
    try:
        ubus_call(router_ip, session, "dhcp", "ipv4leases")
        checks["dhcp_leases"] = {"status": "OK"}
    except Exception as e:
        checks["dhcp_leases"] = {"status": "FAIL", "error": str(e)}

    return checks


def daemon_loop(router_ip: str, username: str, password: str, interval: int = 30):
    """Persistent monitoring loop -- reconnects on failure."""
    session = None
    while True:
        try:
            if session is None:
                session = login(router_ip, username, password)

            checks = verify_connectivity(router_ip, session)
            failed = [k for k, v in checks.items() if v.get("status") != "OK"]
            if failed:
                log.warning(f"Degraded: {failed}")
            else:
                log.info("All systems nominal")

        except (URLError, ConnectionError, TimeoutError) as e:
            log.error(f"Connection lost: {e}")
            session = None
        except Exception as e:
            log.error(f"Unexpected error: {e}")
            session = None

        time.sleep(interval)


def main():
    parser = argparse.ArgumentParser(description="Droplet appliance <-> router connector")
    parser.add_argument("--router", default=DEFAULT_ROUTER_IP, help="Router IP address")
    parser.add_argument("--user", default=DEFAULT_USER, help="RPC username")
    parser.add_argument("--password", default=DEFAULT_PASS, help="RPC password")
    parser.add_argument("--daemon", action="store_true", help="Run as persistent monitor")
    parser.add_argument("--discover", action="store_true", help="mDNS discovery only")
    parser.add_argument("--interval", type=int, default=30, help="Daemon check interval (seconds)")
    args = parser.parse_args()

    if not args.password:
        log.error("OPENWRT_PASSWORD env var or --password flag is required")
        sys.exit(1)

    if args.discover:
        ip = discover_router_mdns()
        if ip:
            print(f"Router found at: {ip}")
        else:
            print("Router not found via mDNS")
            sys.exit(1)
        return

    # Try mDNS first, fall back to provided IP
    router_ip = discover_router_mdns() or args.router
    log.info(f"Connecting to router at {router_ip}")

    if args.daemon:
        log.info("Starting daemon mode...")
        daemon_loop(router_ip, args.user, args.password, args.interval)
    else:
        # One-shot verification
        try:
            session = login(router_ip, args.user, args.password)
            checks = verify_connectivity(router_ip, session)

            print("\n" + "=" * 60)
            print(" Droplet Router Connectivity Report")
            print("=" * 60)
            for check_name, check_result in checks.items():
                status = check_result["status"]
                icon = "+" if status == "OK" else "x"
                print(f"\n  {icon} {check_name}: {status}")
                for k, v in check_result.items():
                    if k != "status":
                        print(f"    {k}: {v}")
            print("\n" + "=" * 60)

            failed = [k for k, v in checks.items() if v.get("status") != "OK"]
            if failed:
                print(f"\n  {len(failed)} check(s) failed")
                sys.exit(1)
            else:
                print("\n  All systems nominal -- appliance <-> router link healthy")

        except Exception as e:
            log.error(f"Connection failed: {e}")
            sys.exit(1)


if __name__ == "__main__":
    main()
