"use client";

import { useEffect, useId, useState } from "react";
import { Reorder } from "framer-motion";
import { GripVertical, Plus, Trash2, Loader2, AlertCircle } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { getScene, createScene, updateScene, type SceneActionInput } from "@/lib/api";
import { useSmartHome } from "@/lib/hooks/useSmartHome";
import type { MatterDevice, SmartHomeCategory } from "@/lib/types";

/**
 * Create / edit a routine (Scene, WARP-474). Wired to the existing /api/scenes
 * CRUD (owner/admin). The action list is drag-reorderable (framer Reorder); on
 * save the actions are sent in display order and the server rewrites their idx.
 *
 * HONESTY NOTE: there is no Matter capability-introspection endpoint — the
 * orchestrator forwards commands opaquely to the sidecar. So the command picker
 * offers only the vocabulary the dashboard already proves works (toggle /
 * set_brightness / set_temperature), and devices whose category has no known
 * scene command are not selectable. No fabricated controls.
 */

type ArgKind = "none" | "percent" | "temp";

const SCENE_COMMANDS: Partial<
  Record<SmartHomeCategory, Array<{ command: string; label: string; arg: ArgKind }>>
> = {
  light: [
    { command: "set_brightness", label: "Set brightness", arg: "percent" },
    { command: "toggle", label: "Toggle on/off", arg: "none" },
  ],
  switch: [{ command: "toggle", label: "Toggle on/off", arg: "none" }],
  fan: [{ command: "toggle", label: "Toggle on/off", arg: "none" }],
  cover: [{ command: "toggle", label: "Open / close", arg: "none" }],
  climate: [{ command: "set_temperature", label: "Set temperature", arg: "temp" }],
};

interface DraftAction {
  key: string;
  deviceNodeId: string;
  command: string;
  args: Record<string, unknown>;
}

let _keySeq = 0;
const nextKey = () => `act-${_keySeq++}`;

function argKindFor(category: SmartHomeCategory | undefined, command: string): ArgKind {
  if (!category) return "none";
  return SCENE_COMMANDS[category]?.find((c) => c.command === command)?.arg ?? "none";
}

export function SceneEditorModal({
  mode,
  sceneId,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  sceneId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const headingId = useId();
  const { grouped } = useSmartHome();

  // Only devices with a known scene command are selectable (honest picker).
  const devices: MatterDevice[] = grouped
    ? (Object.values(grouped).flat() as MatterDevice[]).filter(
        (d) => SCENE_COMMANDS[d.category],
      )
    : [];
  const deviceById = new Map(devices.map((d) => [d.nodeId, d]));

  const [name, setName] = useState("");
  const [actions, setActions] = useState<DraftAction[]>([]);
  const [hydrating, setHydrating] = useState(mode === "edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hydrate on edit.
  useEffect(() => {
    if (mode !== "edit" || !sceneId) return;
    let cancelled = false;
    getScene(sceneId)
      .then((scene) => {
        if (cancelled) return;
        setName(scene.name);
        setActions(
          scene.actions.map((a) => ({
            key: nextKey(),
            deviceNodeId: a.deviceNodeId,
            command: a.command,
            args: (a.args as Record<string, unknown>) ?? {},
          })),
        );
        setHydrating(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Couldn't load this routine.");
        setHydrating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, sceneId]);

  function addAction() {
    const first = devices[0];
    if (!first) return;
    const cmd = SCENE_COMMANDS[first.category]![0];
    setActions((a) => [
      ...a,
      { key: nextKey(), deviceNodeId: first.nodeId, command: cmd.command, args: defaultArgs(cmd.arg) },
    ]);
  }

  function defaultArgs(kind: ArgKind): Record<string, unknown> {
    if (kind === "percent") return { brightness: 100 };
    if (kind === "temp") return { temperature: 21 };
    return {};
  }

  function patchAction(key: string, patch: Partial<DraftAction>) {
    setActions((a) => a.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  }

  function onDeviceChange(key: string, nodeId: string) {
    const dev = deviceById.get(nodeId);
    const cmd = dev ? SCENE_COMMANDS[dev.category]![0] : undefined;
    patchAction(key, {
      deviceNodeId: nodeId,
      command: cmd?.command ?? "toggle",
      args: defaultArgs(cmd?.arg ?? "none"),
    });
  }

  function onCommandChange(key: string, command: string) {
    const dev = deviceById.get(actions.find((a) => a.key === key)?.deviceNodeId ?? "");
    patchAction(key, { command, args: defaultArgs(argKindFor(dev?.category, command)) });
  }

  const trimmed = name.trim();
  const canSave =
    !saving && !hydrating && trimmed.length > 0 && actions.length > 0 && actions.length <= 64;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const payload: SceneActionInput[] = actions.map((a) => ({
      deviceNodeId: a.deviceNodeId,
      command: a.command,
      args: Object.keys(a.args).length ? a.args : undefined,
    }));
    try {
      if (mode === "create") {
        await createScene({ name: trimmed, actions: payload });
      } else if (sceneId) {
        await updateScene(sceneId, { name: trimmed, actions: payload });
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save this routine.");
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} labelledBy={headingId} maxWidth="lg">
      {/* Body padding comes from the <Dialog> primitive (WARP-1153). */}
      <div>
        <h2 id={headingId} className="type-title-3 mb-1" style={{ color: "var(--text)" }}>
          {mode === "create" ? "New routine" : "Edit routine"}
        </h2>
        <p className="type-subheadline mb-4" style={{ color: "var(--text-muted)" }}>
          A routine runs several devices at once. Drag to reorder — actions run top
          to bottom.
        </p>

        {hydrating ? (
          <div className="flex items-center gap-2 py-8 justify-center" style={{ color: "var(--text-muted)" }}>
            <Loader2 size={18} className="animate-spin" />
            <span className="type-subheadline">Loading…</span>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label htmlFor="routine-name" className="type-subheadline block mb-1.5" style={{ color: "var(--text-muted)" }}>
                Name
              </label>
              <input
                id="routine-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Good night"
                className="w-full px-3 py-2.5 rounded-[var(--radius-input)] outline-none transition-colors bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--brand)]"
                maxLength={120}
                autoComplete="off"
              />
            </div>

            {devices.length === 0 ? (
              <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>
                No controllable devices are paired yet. Add a device first, then
                build a routine.
              </p>
            ) : (
              <Reorder.Group axis="y" values={actions} onReorder={setActions} className="space-y-2">
                {actions.map((a) => {
                  const dev = deviceById.get(a.deviceNodeId);
                  const cmds = dev ? SCENE_COMMANDS[dev.category]! : [];
                  const kind = argKindFor(dev?.category, a.command);
                  return (
                    <Reorder.Item
                      key={a.key}
                      value={a}
                      className="flex items-center gap-2 rounded-lg px-2 py-2"
                      style={{ background: "var(--card-inner)" }}
                    >
                      <span
                        className="cursor-grab active:cursor-grabbing"
                        style={{ color: "var(--text-faint)" }}
                        aria-hidden
                      >
                        <GripVertical size={16} />
                      </span>
                      <select
                        aria-label="Device"
                        value={a.deviceNodeId}
                        onChange={(e) => onDeviceChange(a.key, e.target.value)}
                        className="flex-1 min-w-0 px-3 py-2.5 rounded-[var(--radius-input)] outline-none transition-colors bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] focus:border-[var(--brand)]"
                      >
                        {devices.map((d) => (
                          <option key={d.nodeId} value={d.nodeId}>
                            {d.name}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label="Action"
                        value={a.command}
                        onChange={(e) => onCommandChange(a.key, e.target.value)}
                        className="px-3 py-2.5 rounded-[var(--radius-input)] outline-none transition-colors bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] focus:border-[var(--brand)]"
                      >
                        {cmds.map((c) => (
                          <option key={c.command} value={c.command}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                      {kind === "percent" && (
                        <input
                          aria-label="Brightness percent"
                          type="number"
                          min={0}
                          max={100}
                          value={Number(a.args.brightness ?? 0)}
                          onChange={(e) =>
                            patchAction(a.key, { args: { brightness: Number(e.target.value) } })
                          }
                          className="w-20 px-3 py-2.5 rounded-[var(--radius-input)] outline-none transition-colors bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] focus:border-[var(--brand)]"
                        />
                      )}
                      {kind === "temp" && (
                        <input
                          aria-label="Target temperature"
                          type="number"
                          min={5}
                          max={35}
                          value={Number(a.args.temperature ?? 21)}
                          onChange={(e) =>
                            patchAction(a.key, { args: { temperature: Number(e.target.value) } })
                          }
                          className="w-20 px-3 py-2.5 rounded-[var(--radius-input)] outline-none transition-colors bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] focus:border-[var(--brand)]"
                        />
                      )}
                      <button
                        type="button"
                        onClick={() => setActions((x) => x.filter((y) => y.key !== a.key))}
                        aria-label="Remove action"
                        className="transition-colors p-1 text-[var(--text-muted)] hover:text-system-red"
                      >
                        <Trash2 size={16} />
                      </button>
                    </Reorder.Item>
                  );
                })}
              </Reorder.Group>
            )}

            {devices.length > 0 && (
              <button type="button" onClick={addAction} className="btn ghost sm">
                <Plus size={14} /> Add action
              </button>
            )}

            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
              >
                <AlertCircle size={14} className="mt-0.5 flex-shrink-0" aria-hidden />
                <span>{error}</span>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={onClose} className="btn ghost" disabled={saving}>
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!canSave}
                className="btn primary"
              >
                {saving && <Loader2 size={16} className="animate-spin" />}
                {mode === "create" ? "Create routine" : "Save changes"}
              </button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
