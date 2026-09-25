"use client";

/**
 * Building systems on the Devices page: BACnet/IP, Modbus TCP, SNMP and
 * KNX/IP devices behind the device gateway (orchestrator `/api/building`).
 *
 * Everyone who can see Devices can read live values. Owners/admins can
 * change a writable point (always through a confirm dialog — the write moves
 * real equipment), add devices and remove them. The gateway enforces the
 * registry's writable flag and bounds; with live writes off it plans the
 * change and sends nothing, which this section says plainly.
 *
 * Renders independently of the Matter controller, so a box with no Matter
 * radio still gets building control.
 */

import { useId, useState } from "react";
import useSWR from "swr";
import { Building2, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import {
  deleteBuildingDevice,
  discoverBuildingDevices,
  listBuildingDevices,
  readBuildingValues,
  saveBuildingDevice,
  writeBuildingPoint,
  type BuildingDevice,
  type BuildingPoint,
  type BuildingProtocol,
  type BuildingReading,
  type BuildingValue,
} from "@/lib/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";

const PROTOCOL_LABEL: Record<BuildingProtocol, string> = {
  bacnet: "BACnet/IP",
  modbus: "Modbus TCP",
  snmp: "SNMP",
  knx: "KNX/IP",
};

function formatValue(point: BuildingPoint, r: BuildingReading | undefined): string {
  if (!r) return "—";
  if (r.error) return "No reading";
  if (r.value === null) return "—";
  if (typeof r.value === "boolean") return r.value ? "On" : "Off";
  return point.unit ? `${r.value} ${point.unit}` : String(r.value);
}

interface PendingWrite {
  device: BuildingDevice;
  point: BuildingPoint;
  value: BuildingValue;
}

export function BuildingSystemsSection({ canAdmin }: { canAdmin: boolean }) {
  const { toast } = useToast();
  const { data: devices, error, mutate } = useSWR<BuildingDevice[]>(
    "building-devices",
    listBuildingDevices,
    { shouldRetryOnError: false },
  );
  const [readings, setReadings] = useState<Record<string, Record<string, BuildingReading>>>({});
  const [reading, setReading] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const [removing, setRemoving] = useState<BuildingDevice | null>(null);
  const [adding, setAdding] = useState(false);

  // Gateway not running on this box: say so to admins, stay out of the way otherwise.
  if (error) {
    if (!canAdmin) return null;
    return (
      <section aria-label="Building systems">
        <h2 className="type-headline mb-2">Building systems</h2>
        <div className="card">
          <p className="type-footnote" style={{ color: "var(--text-muted)" }}>
            Building control (BACnet, Modbus, SNMP, KNX) isn’t available on this box right now.
          </p>
        </div>
      </section>
    );
  }
  if (!devices) return null;
  if (devices.length === 0 && !canAdmin) return null;

  const read = async (d: BuildingDevice) => {
    setReading(d.id);
    try {
      const { values } = await readBuildingValues(d.id);
      setReadings((prev) => ({ ...prev, [d.id]: values }));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn’t read the device.", "error");
    } finally {
      setReading(null);
    }
  };

  const applyWrite = async () => {
    if (!pending) return;
    const { device, point, value } = pending;
    try {
      const res = await writeBuildingPoint(device.id, point.id, value);
      if (!res.applied) {
        toast("Live writes are off on this box, so nothing was sent to the device.", "info");
      } else {
        toast(`${point.name} updated`, "success");
        if (res.readback) {
          setReadings((prev) => ({
            ...prev,
            [device.id]: { ...(prev[device.id] ?? {}), [point.id]: res.readback! },
          }));
        }
      }
      setPending(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn’t change the setting.", "error");
      throw e; // keep the dialog open for a retry
    }
  };

  return (
    <section aria-label="Building systems">
      <div className="flex items-center justify-between mb-2">
        <h2 className="type-headline">Building systems</h2>
        {canAdmin && (
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            <Plus size={14} aria-hidden="true" /> Add device
          </button>
        )}
      </div>

      {devices.length === 0 ? (
        <div className="card">
          <div className="empty">
            <span className="ei"><Building2 size={24} /></span>
            <span className="eh">No building devices yet</span>
            <span>
              Connect HVAC and building controllers, energy meters, printers and UPSes over BACnet,
              Modbus, SNMP or KNX.
            </span>
          </div>
        </div>
      ) : (
        <div className="grid c2">
          {devices.map((d) => (
            <DeviceCard
              key={d.id}
              device={d}
              values={readings[d.id]}
              busy={reading === d.id}
              canAdmin={canAdmin}
              onRead={() => read(d)}
              onWrite={(point, value) => setPending({ device: d, point, value })}
              onRemove={() => setRemoving(d)}
            />
          ))}
        </div>
      )}

      {pending && (
        <ConfirmDialog
          open
          title={`Change ${pending.point.name}?`}
          description={`Set ${pending.point.name} on ${pending.device.name} to ${
            typeof pending.value === "boolean" ? (pending.value ? "on" : "off") : pending.value
          }${pending.point.unit && typeof pending.value === "number" ? ` ${pending.point.unit}` : ""}. This sends the change to the equipment and is logged to Activity.`}
          confirmLabel="Confirm & apply"
          variant="neutral"
          onConfirm={applyWrite}
          onCancel={() => setPending(null)}
        />
      )}

      {removing && (
        <ConfirmDialog
          open
          title={`Remove ${removing.name}?`}
          description="Droplet stops reading and controlling this device. The device itself is not changed."
          confirmLabel="Remove"
          variant="destructive"
          onConfirm={async () => {
            await deleteBuildingDevice(removing.id);
            setRemoving(null);
            await mutate();
            toast("Device removed", "success");
          }}
          onCancel={() => setRemoving(null)}
        />
      )}

      {adding && (
        <AddBuildingDeviceDialog
          takenIds={devices.map((d) => d.id)}
          onClose={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false);
            await mutate();
            toast("Device added", "success");
          }}
        />
      )}
    </section>
  );
}

function DeviceCard({
  device,
  values,
  busy,
  canAdmin,
  onRead,
  onWrite,
  onRemove,
}: {
  device: BuildingDevice;
  values: Record<string, BuildingReading> | undefined;
  busy: boolean;
  canAdmin: boolean;
  onRead: () => void;
  onWrite: (point: BuildingPoint, value: BuildingValue) => void;
  onRemove: () => void;
}) {
  return (
    <div className="card" data-testid={`building-device-${device.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="type-subheadline font-medium" style={{ color: "var(--text)" }}>{device.name}</p>
          <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
            {PROTOCOL_LABEL[device.protocol]}
            {device.room ? ` · ${device.room}` : ""}
          </p>
        </div>
        <div className="flex gap-1">
          <button type="button" className="btn" onClick={onRead} disabled={busy} aria-label={`Read ${device.name}`}>
            <RefreshCw size={14} aria-hidden="true" /> {values ? "Refresh" : "Read"}
          </button>
          {canAdmin && (
            <button type="button" className="btn" onClick={onRemove} aria-label={`Remove ${device.name}`}>
              <Trash2 size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {device.points.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {device.points.map((p) => (
            <PointRow
              key={p.id}
              point={p}
              reading={values?.[p.id]}
              canWrite={canAdmin && p.writable}
              onWrite={(v) => onWrite(p, v)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function PointRow({
  point,
  reading,
  canWrite,
  onWrite,
}: {
  point: BuildingPoint;
  reading: BuildingReading | undefined;
  canWrite: boolean;
  onWrite: (value: BuildingValue) => void;
}) {
  const [draft, setDraft] = useState("");
  const inputId = useId();
  const numeric = point.kind === "number";
  const draftNumber = Number(draft);
  const inRange =
    !numeric ||
    (draft.trim() !== "" &&
      Number.isFinite(draftNumber) &&
      (point.min == null || draftNumber >= point.min) &&
      (point.max == null || draftNumber <= point.max));

  return (
    <li className="flex items-center justify-between gap-2">
      <span className="type-footnote" style={{ color: "var(--text-muted)" }}>{point.name}</span>
      <span className="flex items-center gap-2">
        <span
          className="type-footnote tabular-nums"
          title={reading?.error ?? undefined}
          style={{ color: reading?.error ? "var(--color-system-orange)" : "var(--text)" }}
        >
          {formatValue(point, reading)}
        </span>
        {canWrite && point.kind === "boolean" && (
          <>
            <button type="button" className="btn" onClick={() => onWrite(true)}>On</button>
            <button type="button" className="btn" onClick={() => onWrite(false)}>Off</button>
          </>
        )}
        {canWrite && point.kind !== "boolean" && (
          <>
            <label htmlFor={inputId} className="sr-only">New {point.name}</label>
            <input
              id={inputId}
              className="w-20 rounded px-2 py-1 type-footnote bg-[var(--card-inner)] border border-[var(--card-bd)]"
              inputMode={numeric ? "decimal" : "text"}
              placeholder={numeric && point.min != null && point.max != null ? `${point.min}–${point.max}` : ""}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              disabled={!inRange || draft.trim() === ""}
              onClick={() => onWrite(numeric ? draftNumber : draft)}
            >
              Set
            </button>
          </>
        )}
      </span>
    </li>
  );
}

const SLUG_MAX = 64;

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "") // drop the accents NFKD split off
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SLUG_MAX) || "device"
  );
}

const POINTS_HINT: Record<BuildingProtocol, string> = {
  bacnet: '[{"id":"zone_temp","name":"Zone temp","object":"analog-input,1","unit":"°C"}]',
  modbus: '[{"id":"power","name":"Power","table":"input","address":0,"data_type":"float32","unit":"kW"}]',
  snmp: "Leave empty to use the template's points",
  knx: '[{"id":"lights","name":"Lights","kind":"boolean","group_address":"1/1/1","dpt":"1.001"}]',
};

function AddBuildingDeviceDialog({
  takenIds,
  onClose,
  onSaved,
}: {
  takenIds: string[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const headingId = useId();
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<BuildingProtocol>("bacnet");
  const [address, setAddress] = useState("");
  const [room, setRoom] = useState("");
  const [community, setCommunity] = useState("public");
  const [template, setTemplate] = useState("printer");
  const [unitId, setUnitId] = useState("1");
  const [points, setPoints] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [found, setFound] = useState<Record<string, unknown>[] | null>(null);
  const [scanning, setScanning] = useState(false);

  const id = slugify(name);

  const scan = async () => {
    if (protocol !== "bacnet" && protocol !== "knx") return;
    setScanning(true);
    setError(null);
    try {
      setFound(await discoverBuildingDevices(protocol));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Discovery failed");
    } finally {
      setScanning(false);
    }
  };

  const save = async () => {
    setError(null);
    if (!name.trim() || !address.trim()) {
      setError("Name and address are required.");
      return;
    }
    if (takenIds.includes(id)) {
      setError("A device with that name already exists.");
      return;
    }
    let parsedPoints: unknown[] = [];
    if (points.trim()) {
      try {
        const p = JSON.parse(points);
        if (!Array.isArray(p)) throw new Error();
        parsedPoints = p;
      } catch {
        setError("Points must be a JSON list.");
        return;
      }
    }
    const body: Record<string, unknown> = {
      name: name.trim(),
      protocol,
      address: address.trim(),
      points: parsedPoints,
      ...(room.trim() ? { room: room.trim() } : {}),
    };
    if (protocol === "modbus") body.unit_id = Number(unitId) || 1;
    if (protocol === "snmp") {
      body.community = community;
      if (template) body.template = template;
    }
    setSaving(true);
    try {
      await saveBuildingDevice(id, body);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t save the device.");
    } finally {
      setSaving(false);
    }
  };

  const field = "w-full rounded-lg px-3 py-2 type-body bg-[var(--card-inner)] text-[var(--text)] border border-[var(--card-bd)]";
  const label = "type-caption-1 mb-1 block";

  return (
    <Dialog open onClose={onClose} labelledBy={headingId} maxWidth="lg">
      <div className="p-5 space-y-3">
        <h2 id={headingId} className="type-title-3" style={{ color: "var(--text)" }}>Add a building device</h2>

        <div>
          <label className={label} htmlFor={`${headingId}-protocol`}>Protocol</label>
          <select
            id={`${headingId}-protocol`}
            className={field}
            value={protocol}
            onChange={(e) => {
              setProtocol(e.target.value as BuildingProtocol);
              setFound(null);
            }}
          >
            {(Object.keys(PROTOCOL_LABEL) as BuildingProtocol[]).map((p) => (
              <option key={p} value={p}>{PROTOCOL_LABEL[p]}</option>
            ))}
          </select>
        </div>

        {(protocol === "bacnet" || protocol === "knx") && (
          <div>
            <button type="button" className="btn" onClick={scan} disabled={scanning}>
              <Search size={14} aria-hidden="true" /> {scanning ? "Searching…" : "Search the network"}
            </button>
            {found && (
              <ul className="mt-2 flex flex-col gap-1" aria-label="Found devices">
                {found.length === 0 && <li className="type-footnote">Nothing answered.</li>}
                {found.map((f) => (
                  <li key={`${f.address}-${f.device_instance ?? f.port}`} className="flex items-center justify-between type-footnote">
                    <span>
                      {String(f.name ?? `Device ${f.device_instance ?? ""}`)} · {String(f.address)}
                      {f.registered ? " (added)" : ""}
                    </span>
                    {!f.registered && (
                      <button type="button" className="btn" onClick={() => setAddress(String(f.address))}>Use</button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div>
          <label className={label} htmlFor={`${headingId}-name`}>Name</label>
          <input id={`${headingId}-name`} className={field} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor={`${headingId}-address`}>Address</label>
          <input id={`${headingId}-address`} className={field} value={address} placeholder="192.168.1.50" onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor={`${headingId}-room`}>Room (optional)</label>
          <input id={`${headingId}-room`} className={field} value={room} maxLength={64} onChange={(e) => setRoom(e.target.value)} />
        </div>

        {protocol === "modbus" && (
          <div>
            <label className={label} htmlFor={`${headingId}-unit`}>Unit id</label>
            <input id={`${headingId}-unit`} className={field} inputMode="numeric" value={unitId} onChange={(e) => setUnitId(e.target.value)} />
          </div>
        )}
        {protocol === "snmp" && (
          <>
            <div>
              <label className={label} htmlFor={`${headingId}-community`}>Community</label>
              <input id={`${headingId}-community`} className={field} value={community} onChange={(e) => setCommunity(e.target.value)} />
            </div>
            <div>
              <label className={label} htmlFor={`${headingId}-template`}>Device type</label>
              <select id={`${headingId}-template`} className={field} value={template} onChange={(e) => setTemplate(e.target.value)}>
                <option value="printer">Network printer</option>
                <option value="ups">UPS</option>
                <option value="host">Any SNMP device</option>
                <option value="">Custom points</option>
              </select>
            </div>
          </>
        )}

        <div>
          <label className={label} htmlFor={`${headingId}-points`}>Points (JSON)</label>
          <textarea
            id={`${headingId}-points`}
            className={`${field} font-mono`}
            rows={4}
            value={points}
            placeholder={POINTS_HINT[protocol]}
            onChange={(e) => setPoints(e.target.value)}
          />
          <p className="type-caption-1 mt-1" style={{ color: "var(--text-muted)" }}>
            A point is read-only unless it has <code>&quot;writable&quot;: true</code>; writable numbers
            need <code>min</code> and <code>max</code>.
          </p>
        </div>

        {error && (
          <p role="alert" className="type-footnote" style={{ color: "var(--color-system-red)" }}>{error}</p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save device"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
