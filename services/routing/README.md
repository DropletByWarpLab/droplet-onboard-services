# Routing Service

FastAPI wrapper around the Droplet OpenWrt SDK. Exposes the OpenWrt router's ubus JSON-RPC API as REST endpoints for the orchestrator and AI gateway.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENWRT_HOST` | `10.0.0.1` | OpenWrt router IP |
| `OPENWRT_PORT` | `80` | OpenWrt uhttpd port |
| `OPENWRT_USERNAME` | `droplet-ai` | rpcd user |
| `OPENWRT_PASSWORD` | (empty) | rpcd password |
| `PORT` | `8080` | Service listen port |

## Local Development

```bash
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8080 --reload
```

## Endpoints

- `GET /health` -- Router connectivity check
- `GET /network/*` -- Interface status
- `GET /wireless/*` -- WiFi status, scan, clients
- `POST /wireless/*` -- Set SSID, password, channel
- `GET /dhcp/*` -- DHCP leases
- `POST /dhcp/*` -- Static leases, DNS
- `GET /firewall/*` -- Zones, rules, redirects
- `POST /firewall/*` -- Block/unblock, port forwards
- `GET /system/info` -- Board + resources
- `POST /system/reboot` -- Reboot device
