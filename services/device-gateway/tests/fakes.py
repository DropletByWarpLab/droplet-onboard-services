"""Test doubles. No test in this suite opens a socket."""

from __future__ import annotations

from drivers.base import DeviceUnreachable, ProtocolDriver, Reading


class FakeDriver(ProtocolDriver):
    """In-memory driver for API tests: values keyed by (device, point)."""

    def __init__(self, protocol: str):
        self.protocol = protocol
        self.values: dict[tuple[str, str], object] = {}
        self.writes: list[tuple[str, str, object]] = []
        self.unreachable = False
        self.discovered: list[dict] = []
        self.started = self.stopped = False

    async def start(self):
        self.started = True

    async def stop(self):
        self.stopped = True

    async def read_points(self, device, points):
        if self.unreachable:
            raise DeviceUnreachable(f"{device.id}: fake unreachable")
        return {
            p.id: Reading(value=self.values[(device.id, p.id)])
            if (device.id, p.id) in self.values
            else Reading(error="no value")
            for p in points
        }

    async def write_point(self, device, point, value):
        if self.unreachable:
            raise DeviceUnreachable(f"{device.id}: fake unreachable")
        self.writes.append((device.id, point.id, value))
        self.values[(device.id, point.id)] = value

    async def discover(self, timeout):
        if self.protocol in ("modbus", "snmp"):
            return await super().discover(timeout)
        return [dict(d) for d in self.discovered]


# --- Modbus -----------------------------------------------------------------

class _Resp:
    def __init__(self, registers=None, bits=None, error=None):
        self.registers, self.bits, self._error = registers or [], bits or [], error

    def isError(self):
        return self._error is not None

    def __str__(self):
        return f"Modbus error {self._error}"


class FakeModbusClient:
    """Mirrors AsyncModbusTcpClient's surface, borrowing its real codecs."""

    from pymodbus.client import AsyncModbusTcpClient as _Real

    DATATYPE = _Real.DATATYPE
    convert_from_registers = _Real.convert_from_registers
    convert_to_registers = _Real.convert_to_registers

    instances: list["FakeModbusClient"] = []

    def __init__(self, host, **kwargs):
        self.host, self.kwargs = host, kwargs
        self.registers: dict[int, int] = {}
        self.coils: dict[int, bool] = {}
        self.errors: set[int] = set()
        self.connect_ok = True
        self.closed = False
        self.writes: list[tuple] = []
        FakeModbusClient.instances.append(self)

    async def connect(self):
        return self.connect_ok

    def close(self):
        self.closed = True

    async def _regs(self, address, count):
        if address in self.errors:
            return _Resp(error=2)
        return _Resp(registers=[self.registers.get(address + i, 0) for i in range(count)])

    async def read_holding_registers(self, address, *, count=1, device_id=1):
        return await self._regs(address, count)

    async def read_input_registers(self, address, *, count=1, device_id=1):
        return await self._regs(address, count)

    async def read_coils(self, address, *, count=1, device_id=1):
        if address in self.errors:
            return _Resp(error=2)
        return _Resp(bits=[self.coils.get(address, False)])

    read_discrete_inputs = read_coils

    async def write_register(self, address, value, *, device_id=1):
        self.writes.append(("register", address, value, device_id))
        self.registers[address] = value
        return _Resp()

    async def write_registers(self, address, values, *, device_id=1):
        self.writes.append(("registers", address, list(values), device_id))
        for i, v in enumerate(values):
            self.registers[address + i] = v
        return _Resp()

    async def write_coil(self, address, value, *, device_id=1):
        self.writes.append(("coil", address, value, device_id))
        self.coils[address] = value
        return _Resp()


# --- BACnet -----------------------------------------------------------------

class FakeBacnetApp:
    def __init__(self):
        self.props: dict[tuple[str, str, str], object] = {}
        self.errors: dict[tuple[str, str, str], Exception] = {}
        self.writes: list[tuple] = []
        self.i_ams: list = []
        self.closed = False

    async def read_property(self, address, objid, prop):
        key = (address, objid, prop)
        if key in self.errors:
            raise self.errors[key]
        return self.props[key]

    async def write_property(self, address, objid, prop, value, priority=None):
        self.writes.append((address, objid, prop, value, priority))

    async def who_is(self, timeout=3.0):
        return self.i_ams

    def close(self):
        self.closed = True


# --- KNX --------------------------------------------------------------------

class FakeXknx:
    def __init__(self, fail_start=False):
        self.fail_start = fail_start
        self.started = self.stopped = False

    async def start(self):
        if self.fail_start:
            raise OSError("no route to KNX interface")
        self.started = True

    async def stop(self):
        self.stopped = True


class FakeTelegram:
    def __init__(self, value):
        class _P:
            pass

        self.payload = _P()
        self.payload.value = value
