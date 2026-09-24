# device-gateway

Commercial and industrial device control for Droplet, over **BACnet/IP**,
**Modbus TCP**, **SNMP v2c/v3**, and **KNX/IP**. It sits beside Matter (which
stays in `services/matter-controller`) under the product's **Device control**
area.

| Protocol | Typical devices | Library (licence) | Discovery |
|---|---|---|---|
| BACnet/IP | HVAC and building-management controllers, VAVs, air handlers, lighting panels | BACpypes3 (MIT) | Who-Is |
| Modbus TCP | energy meters, PLCs, VFDs, inverters, rooftop units | pymodbus (BSD-3) | none, add by address |
| SNMP | printers, UPSes, PDUs, environment sensors | pysnmp (BSD-2) | none, add by address |
| KNX/IP | lighting, blinds, HVAC (tunnelling or routing) | xknx (MIT) | gateway search |

## Placement (foundation)

It runs on the **Vault** side, with `network_mode: host` on the LAN. BACnet
Who-Is is a UDP broadcast and KNX routing is multicast, so it cannot sit
behind the Docker bridge. It is never reachable from the WAN/Edge subsystem.
Only the orchestrator calls it, using a shared bearer (`SERVICE_SECRET`).
Auth **fails closed**: with no secret set, every route except `/health`
returns 403. Internal mTLS works as on the other host services
(`DROPLET_INTERNAL_TLS`, via `_shared.serve`).

## Write safety

A write reaches equipment only if it passes all four gates:

1. **Registry.** A point exists only if an admin registered it, and it is
   writable only when explicitly marked `writable`. A writable number must
   declare `min` and `max`. Some writes are refused at registration: Modbus
   input registers and discrete inputs, and BACnet priorities 1–7 (life
   safety, critical equipment, minimum on/off). BACnet writes default to
   priority 16, the lowest.
2. **Guard** (`guard.py`). The gateway re-checks every write, whatever the
   caller already checked. A bool is never a number; numbers must be finite
   and within bounds; text is limited to 255 characters.
3. **`DEVICE_GATEWAY_LIVE_WRITES`.** This is off by default. While off, a
   write returns its plan (`applied: false`) and nothing is sent. It is an
   explicit boolean, never derived from anything else.
4. **Orchestrator.** Tier-2 human confirmation, plus an audit row that must be
   written before the write is sent.

After a live write, the gateway reads the point back and returns
`readback`, so callers report the value the device holds rather than the
value that was sent.

## API

| Method | Path | |
|---|---|---|
| GET | `/health` | open; `live_writes`, protocols, device count |
| GET | `/templates` | SNMP point templates: `printer`, `ups`, `host` |
| GET | `/devices` · `/devices/{id}` | secrets redacted |
| PUT | `/devices/{id}` | create (201) or replace (200); a `template` fills empty `points`; an omitted secret keeps the stored one |
| DELETE | `/devices/{id}` | |
| GET | `/devices/{id}/values` | one reading per point (`value` or `error`); 502 if the device is unreachable |
| POST | `/devices/{id}/points/{point}/write` | `{"value": …}` → plan (plan-only mode) or applied + readback |
| POST | `/discover` | `{"protocol": "bacnet" \| "knx", "timeout": 3}` |

Requests to a single device are serialised, because many field devices accept
only one client at a time. Modbus connections open per request, so the
building's own BMS is not locked out.

## Environment

| Variable | Default | |
|---|---|---|
| `SERVICE_SECRET` | — | required; bearer the orchestrator presents |
| `DEVICE_GATEWAY_LIVE_WRITES` | off | `1` sends writes to equipment |
| `DEVICE_GATEWAY_REGISTRY_PATH` | `/var/lib/droplet/device-gateway/registry.json` | written atomically, mode 0600 |
| `DEVICE_GATEWAY_TIMEOUT_S` | `3` | per request to a device |
| `DEVICE_GATEWAY_BACNET_INSTANCE` | `4194000` | the gateway's own BACnet device instance; must be unique on site |
| `DEVICE_GATEWAY_BACNET_ADDRESS` | host | `<ip>/<prefix>` of the LAN interface |
| `DEVICE_GATEWAY_ALLOW_NO_AUTH` | off | local dev only |

## Tests

```bash
cd services/device-gateway && python -m pytest
```

The unit tests use fake transports. `test_modbus_loopback.py` and
`test_bacnet_loopback.py` run the real pymodbus and BACpypes3 stacks against
each other on 127.0.0.1, so they exercise the actual protocol wiring without
any hardware.
