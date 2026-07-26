"use client";

/**
 * WARP-1532 (RBAC v2 T8) — Surface B: the role builder.
 *
 * One right-side sheet (the canonical <Dialog placement="right"> primitive —
 * focus trap, Escape, scroll-lock, reduced-motion slide→fade for free), four
 * clearly-sectioned axes in the §5 order: identity & starting point →
 * features & what they can do → usage → AI tools & connectors. The starting
 * point IS the enforcement tier the role's people receive; every axis below
 * only narrows within that floor. Over-floor controls render disabled with
 * the real reason — never hidden (§5.2). Save is disabled until dirty and
 * emits the ADR-032 §5 payload; the server re-clamps everything (the client
 * is never trusted).
 */

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import {
  BookOpen,
  Cable,
  Calendar,
  Camera,
  Cloud,
  ClipboardList,
  FileText,
  Folder,
  Home,
  KeyRound,
  Lightbulb,
  Mail,
  MessageSquare,
  Mic,
  Network,
  Plug,
  Settings,
  Wrench,
  X,
} from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SafetyChip } from "@/components/integrations/SafetyChip";
import type {
  AccessRolePayload,
  AccessStartingPoint,
  AccessTier,
  ConnectorAccessLevel,
  FeatureAccessLevel,
  ToolAccessLevel,
} from "@/lib/types";
import {
  ACCESS_FEATURES,
  CONNECTOR_LEVELS,
  TIER_RANK,
  TOOL_DOMAIN_GROUPS,
  connectorAxisBlocked,
  connectorFloorReason,
  connectorLevelsFor,
  dependencyBlockedReason,
  draftToRolePayload,
  refloorFeatures,
  slugifyRoleName,
  tierLabel,
  tierPlural,
  featureDef,
  type RoleDraft,
} from "@/lib/access";
import { ACCESS_COPY } from "./copy";
import { AccessToggle, GuardNote, LevelPills } from "./bits";
import { AlertTriangle, Lock } from "lucide-react";
import "./access.css";

const FEATURE_ICON: Record<string, typeof Home> = {
  home: Home,
  chat: MessageSquare,
  files: Folder,
  email: Mail,
  cameras: Camera,
  network: Network,
  smart_home: Lightbulb,
  calendar: Calendar,
  docs: FileText,
  knowledge: BookOpen,
  projects: ClipboardList,
  voice: Mic,
  managed_switch: Cable,
  settings: Settings,
};

const STARTING_POINTS: Array<{ tier: AccessStartingPoint; caption: string }> = [
  { tier: "admin", caption: ACCESS_COPY.startAdmin },
  { tier: "family", caption: ACCESS_COPY.startStaff },
  { tier: "guest", caption: ACCESS_COPY.startGuest },
];

const CONNECTOR_LEVEL_LABEL: Record<ConnectorAccessLevel | "none", string> = {
  none: "None",
  read: "Read",
  read_write: "Read & write",
};

export interface ConnectorOption {
  /** IntegrationConnection.provider ("eaglesoft"). */
  provider: string;
  /** Display label ("Eaglesoft"). */
  label: string;
  note?: string;
}

export interface RoleBuilderSheetProps {
  open: boolean;
  mode: "create" | "edit";
  /** Draft seed — blankRoleDraft() for create, roleToDraft(role) for edit. */
  base: RoleDraft;
  /** Acting admin's tier — drives the WARP-623 rank cap rendering. */
  actingTier: AccessTier;
  /** Configured connectors; empty renders the §10 empty state. */
  connectors: ConnectorOption[];
  /** Disables Save while a request is in flight. */
  busy?: boolean;
  onSave: (payload: AccessRolePayload) => void | Promise<void>;
  onClose: () => void;
  /** Files row deep-link → the Departments & teams tab (ADR-029 owns it). */
  onOpenDepartments: () => void;
}

export function RoleBuilderSheet({
  open,
  mode,
  base,
  actingTier,
  connectors,
  busy = false,
  onSave,
  onClose,
  onOpenDepartments,
}: RoleBuilderSheetProps) {
  const headingId = useId();
  const floorNoteId = `${headingId}-connector-floor`;
  const [draft, setDraft] = useState<RoleDraft>(base);
  const [refloorNotice, setRefloorNotice] = useState<string | null>(null);
  const [cloudConfirm, setCloudConfirm] = useState(false);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(base), [draft, base]);
  const canSave = dirty && draft.name.trim().length > 0 && !busy;
  const slugPreview = mode === "edit" && draft.slug ? draft.slug : slugifyRoleName(draft.name);

  const patch = (p: Partial<RoleDraft>) => setDraft((d) => ({ ...d, ...p }));

  /** Usage edits mark the axis touched — untouched usage re-emits the
   *  server's raw values verbatim on save (review F2; lossy GB/TB input). */
  const patchUsage = (p: Partial<RoleDraft["usage"]>) =>
    setDraft((d) => ({ ...d, usage: { ...d.usage, ...p }, usageTouched: true }));

  const setStartingPoint = (tier: AccessStartingPoint) => {
    if (TIER_RANK[tier] > TIER_RANK[actingTier]) return;
    // Review F5a: compute OUTSIDE the setState updater — updaters must stay
    // pure (StrictMode double-invokes them) and the notice is a side effect.
    const { features, notice } = refloorFeatures(draft.features, tier);
    // Review F3: the O-2 cap shrinks the connector options on a downgrade —
    // clamp the draft value too (the select would otherwise sit valueless)
    // and say so in the same §5.1 notice; connectors are never silent.
    //
    // WARP-1578 adds the harder downgrade: a GUEST-based role holds no
    // connector grant at all, so the level is not capped but CLEARED. It gets
    // the §12 re-floor sentence verbatim rather than the cap sentence — the
    // grant is turned off, not narrowed, and the copy has to say which.
    const allowedLevels = new Set(connectorLevelsFor(tier));
    const axisBlocked = connectorAxisBlocked(tier);
    const nextConnectors = { ...draft.connectors };
    let connectorNotice: string | null = null;
    for (const [provider, level] of Object.entries(nextConnectors)) {
      if (level === "none" || allowedLevels.has(level)) continue;
      const label = connectors.find((c) => c.provider === provider)?.label ?? provider;
      nextConnectors[provider] = axisBlocked ? "none" : "read";
      if (!connectorNotice) {
        connectorNotice = axisBlocked
          ? `Switching to ${tierLabel(tier)} turns off ${label} — ${tierPlural(tier)} can't reach connectors.`
          : `Switching to ${tierLabel(tier)} caps ${label} at Read — Read & write is available on Admin-based roles.`;
      }
    }
    const combined = [notice, connectorNotice].filter(Boolean).join(" ");
    setRefloorNotice(combined || null);
    setDraft((d) => ({ ...d, startingPoint: tier, features, connectors: nextConnectors }));
  };

  const setFeatureOn = (moduleId: string, on: boolean) =>
    setDraft((d) => ({
      ...d,
      features: { ...d.features, [moduleId]: { ...d.features[moduleId]!, on } },
    }));

  const setFeatureLevel = (moduleId: string, level: FeatureAccessLevel) =>
    setDraft((d) => ({
      ...d,
      features: { ...d.features, [moduleId]: { ...d.features[moduleId]!, level } },
    }));

  const setToolLevel = (groupId: string, level: ToolAccessLevel) =>
    setDraft((d) => ({
      ...d,
      tools: { ...d.tools, [groupId]: level },
      // Explicit intent is what authorizes a fan-out on save — untouched
      // groups re-emit the server's per-domain rows verbatim (QA send-back:
      // a name-only edit must never widen or invent tool grants).
      touchedToolGroups: d.touchedToolGroups.includes(groupId)
        ? d.touchedToolGroups
        : [...d.touchedToolGroups, groupId],
    }));

  const setConnector = (provider: string, level: ConnectorAccessLevel | "none") =>
    setDraft((d) => ({ ...d, connectors: { ...d.connectors, [provider]: level } }));

  const handleCloudToggle = () => {
    if (draft.cloud) {
      patch({ cloud: false });
      return;
    }
    setCloudConfirm(true);
  };

  // WARP-1578 — §5.2 for the connectors axis: every level RENDERS, the ones
  // this starting point can't hold render disabled with the reason. Hiding
  // them taught an operator nothing about the ceiling and let a Guest-based
  // role save a grant that can never take effect.
  const connectorAllowed = new Set(connectorLevelsFor(draft.startingPoint));
  const connectorsBlocked = connectorAxisBlocked(draft.startingPoint);
  const connectorReason = connectorFloorReason(draft.startingPoint);
  // A grant held over from before the floor existed. The value stays visible
  // — hiding it would be the same dishonesty in reverse — and the sheet says
  // what Save will do to it, up front, rather than dropping it quietly.
  const blockedGrantHeldOver =
    connectorsBlocked &&
    connectors.some((c) => (draft.connectors[c.provider] ?? "none") !== "none");

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy={headingId}
      placement="right"
      // Packet §17 locks the builder at min(520px, 100vw) — 448 squeezes
      // the feature rows (QA-2/UX-9). Explicit opt-in; other side panels
      // keep the legacy width.
      sideWidth="sheet"
      flush
    >
      <div className="flex h-full flex-col">
        {/* ── Sheet head ── */}
        <div
          className="flex items-center gap-3 px-5 py-4"
          style={{ borderBottom: "1px solid var(--card-bd)" }}
        >
          <span className="acc-glyph" style={{ width: 36, height: 36, borderRadius: 10, background: "var(--brand-subtle)", color: "var(--brand)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <KeyRound size={19} aria-hidden="true" />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id={headingId} className="sr-only">
              {mode === "create" ? "New role" : `Edit ${draft.name}`}
            </h2>
            {mode === "create" ? (
              <input
                aria-label="Role name"
                placeholder="Name this role"
                value={draft.name}
                autoFocus
                onChange={(e) => patch({ name: e.target.value })}
                className="outline-none focus:ring-2 focus:ring-[var(--brand)] transition-shadow rounded-sm"
                style={{
                  font: "inherit",
                  fontSize: 16,
                  fontWeight: 700,
                  color: "var(--text)",
                  background: "none",
                  border: "none",
                  borderBottom: "1.5px dashed var(--card-bd)",
                  padding: "2px 0",
                  width: "100%",
                }}
              />
            ) : (
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{draft.name}</div>
            )}
            <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 2 }}>
              {ACCESS_COPY.builderSubline}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close role builder"
            className="p-2 rounded-sm"
            style={{ color: "var(--text-muted)" }}
          >
            <X size={17} />
          </button>
        </div>

        {/* ── Sheet body: the four axes ── */}
        <div className="flex-1 overflow-y-auto px-5 py-4" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {/* Axis 1 — identity & starting point */}
          <section className="acc-axis" aria-label="Identity and starting point">
            <div className="acc-axis-title">
              <span className="n">1</span>Identity &amp; starting point
            </div>
            {mode === "edit" && (
              <div>
                <label className="type-caption-1 mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                  Role name
                </label>
                <input
                  aria-label="Role name"
                  value={draft.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  className="w-full px-3 py-2.5 outline-none focus:ring-2 focus:ring-[var(--brand)] transition-shadow"
                  style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-input)", color: "var(--text)" }}
                />
              </div>
            )}
            <div>
              <label className="type-caption-1 mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                Slug
              </label>
              <input
                aria-label="Slug"
                value={slugPreview}
                disabled
                className="w-full px-3 py-2.5 outline-none focus:ring-2 focus:ring-[var(--brand)] transition-shadow"
                style={{ background: "var(--inset)", border: "1px solid var(--card-bd)", borderRadius: "var(--radius-input)", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 13 }}
              />
            </div>
            <div>
              <label className="type-caption-1 mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                Description
              </label>
              <input
                aria-label="Description"
                placeholder="Optional — what this role is for"
                value={draft.description}
                onChange={(e) => patch({ description: e.target.value })}
                className="w-full px-3 py-2.5 outline-none focus:ring-2 focus:ring-[var(--brand)] transition-shadow"
                style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-input)", color: "var(--text)" }}
              />
            </div>
            <div>
              <label className="type-caption-1 mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                Starting point
              </label>
              {/* Plain aria-pressed buttons (the tools-segment idiom) — an
                  honest contract for a button group; the ARIA radio pattern
                  demands roving tabindex + arrow keys we don't implement. */}
              <div className="acc-seg grow" role="group" aria-label="Starting point">
                {STARTING_POINTS.map(({ tier }) => {
                  const blocked = TIER_RANK[tier] > TIER_RANK[actingTier];
                  return (
                    <button
                      key={tier}
                      type="button"
                      aria-pressed={draft.startingPoint === tier}
                      className={draft.startingPoint === tier ? "on" : ""}
                      disabled={blocked}
                      title={blocked ? ACCESS_COPY.rankCap : undefined}
                      onClick={() => setStartingPoint(tier)}
                    >
                      {tierLabel(tier)}
                    </button>
                  );
                })}
              </div>
              <div className="acc-seg-caption">
                {STARTING_POINTS.map(({ tier, caption }) => (
                  <span key={tier}>{caption}</span>
                ))}
              </div>
              <p className="type-caption-1 mt-2" style={{ color: "var(--text-muted)", lineHeight: 1.5 }}>
                The starting point <b>is the enforcement tier</b> people in this role receive — an
                Admin-based role makes them admins (then narrowed below). Owner isn&apos;t a starting
                point, and you can&apos;t pick a tier above your own.
              </p>
              {refloorNotice && (
                <div className="mt-2">
                  <GuardNote warn icon={<AlertTriangle size={15} aria-hidden="true" />} role="status">
                    {refloorNotice}
                  </GuardNote>
                </div>
              )}
            </div>
          </section>

          {/* Axis 2 — features & what they can do */}
          <section className="acc-axis" aria-label="Features and what they can do">
            <div className="acc-axis-title">
              <span className="n">2</span>Features &amp; what they can do
            </div>
            {ACCESS_FEATURES.map((feature) => {
              const entry = draft.features[feature.moduleId] ?? { on: false, level: "view" as const };
              // WARP-1585 — a feature whose declared parent is off reads as OFF
              // and says why, because that is what the box will enforce: the §3
              // resolver drops it from the person's effective set. The DRAFT is
              // untouched (see `dependencyBlockedReason`), so the operator's
              // intent survives and restoring the parent restores the row.
              const blockedReason = dependencyBlockedReason(draft.features, feature);
              const on = feature.alwaysOn ? true : entry.on && !blockedReason;
              const Icon = FEATURE_ICON[feature.moduleId] ?? Home;
              return (
                <div key={feature.moduleId} className="acc-feat" data-testid={`access-feature-${feature.moduleId}`}>
                  <div className="acc-feat-top">
                    <span className="acc-glyph">
                      <Icon size={16} aria-hidden="true" />
                    </span>
                    <span className="tx">
                      <span className="fname">{feature.label}</span>
                      <span className="fdesc">{feature.description}</span>
                    </span>
                    <AccessToggle
                      on={on}
                      disabled={!!feature.alwaysOn || !!blockedReason}
                      title={feature.alwaysOn ? feature.alwaysOnReason : blockedReason ?? undefined}
                      ariaLabel={`Turn ${feature.label} ${on ? "off" : "on"}`}
                      onChange={() => setFeatureOn(feature.moduleId, !entry.on)}
                    />
                  </div>
                  {/* Shown, never hidden — the packet's rule for every ceiling
                      (§5.2: "the level is visible so the admin understands the
                      ceiling, never hidden").
                      Deliberately WITHOUT a padlock: the packet's icon
                      vocabulary (§1) assigns `Lock` to "a floor-blocked
                      control", and §13 asks for an icon + reason on exactly
                      the floor-blocked and off-box cases. A dependency is
                      neither — it is not a tier ceiling and the operator can
                      clear it themselves by turning Files on. The matching
                      precedent is §5.4's tool auto-off ("Turned off with
                      {feature}."), which is text-only for the same reason, so
                      this takes that treatment one level up.
                      Source: shared_brain content/brand/handoffs/access/
                      DESIGN-BRIEF.md §1 / §5.2 / §5.4 / §13. */}
                  {blockedReason && (
                    <p className="acc-feat-reason">{blockedReason}</p>
                  )}
                  {on && !feature.alwaysOn && (
                    feature.filesReference ? (
                      <button type="button" className="acc-files-ref" onClick={onOpenDepartments}>
                        <Folder size={14} aria-hidden="true" />
                        {ACCESS_COPY.filesRow}
                      </button>
                    ) : (
                      <>
                        <LevelPills
                          feature={feature}
                          startingPoint={draft.startingPoint}
                          value={entry.level}
                          onChange={(level) => setFeatureLevel(feature.moduleId, level)}
                        />
                        {feature.locks && (
                          <div className="acc-locks">
                            <AccessToggle
                              small
                              on={draft.locks}
                              ariaLabel={ACCESS_COPY.locksToggle}
                              onChange={() => patch({ locks: !draft.locks })}
                            />
                            {ACCESS_COPY.locksToggle}
                          </div>
                        )}
                      </>
                    )
                  )}
                </div>
              );
            })}
          </section>

          {/* Axis 3 — usage limits */}
          <section className="acc-axis" aria-label="Usage limits">
            <div className="acc-axis-title">
              <span className="n">3</span>Usage limits
            </div>
            <div className="flex gap-2.5">
              <div style={{ flex: 1 }}>
                <label htmlFor={`${headingId}-storage`} className="type-caption-1 mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                  Storage limit
                </label>
                <div className="flex gap-1.5">
                  <input
                    id={`${headingId}-storage`}
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    placeholder="No limit"
                    value={draft.usage.storageValue}
                    onChange={(e) => patchUsage({ storageValue: e.target.value })}
                    className="flex-1 px-3 py-2.5 outline-none focus:ring-2 focus:ring-[var(--brand)] transition-shadow"
                    style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-input)", color: "var(--text)", fontFamily: "var(--font-mono)", minWidth: 0 }}
                  />
                  <select
                    aria-label="Storage limit unit"
                    value={draft.usage.storageUnit}
                    onChange={(e) => patchUsage({ storageUnit: e.target.value as "GB" | "TB" })}
                    className="px-2.5 py-2.5 outline-none focus:ring-2 focus:ring-[var(--brand)] transition-shadow"
                    style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-input)", color: "var(--text)" }}
                  >
                    <option value="GB">GB</option>
                    <option value="TB">TB</option>
                  </select>
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <label htmlFor={`${headingId}-upload`} className="type-caption-1 mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                  Largest upload
                </label>
                <input
                  id={`${headingId}-upload`}
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  placeholder="Box default"
                  value={draft.usage.uploadMb}
                  onChange={(e) => patchUsage({ uploadMb: e.target.value })}
                  className="w-full px-3 py-2.5 outline-none focus:ring-2 focus:ring-[var(--brand)] transition-shadow"
                  style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-input)", color: "var(--text)", fontFamily: "var(--font-mono)" }}
                />
              </div>
            </div>
            <div>
              <label htmlFor={`${headingId}-llm`} className="type-caption-1 mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                Daily AI messages <span style={{ color: "var(--text-faint)" }}>· optional, v1 may not enforce</span>
              </label>
              <input
                id={`${headingId}-llm`}
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                placeholder="No limit"
                value={draft.usage.llmDaily}
                onChange={(e) => patchUsage({ llmDaily: e.target.value })}
                className="w-full px-3 py-2.5 outline-none focus:ring-2 focus:ring-[var(--brand)] transition-shadow"
                style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-input)", color: "var(--text)", fontFamily: "var(--font-mono)" }}
              />
            </div>
            <p className="type-caption-1" style={{ color: "var(--text-muted)", lineHeight: 1.5 }}>
              {ACCESS_COPY.usageDefaults}
            </p>
          </section>

          {/* Axis 4 — AI tools & connectors */}
          <section className="acc-axis" aria-label="AI tools and connectors">
            <div className="acc-axis-title">
              <span className="n">4</span>AI tools &amp; connectors
            </div>
            <div>
              <div className="type-caption-1 mb-1" style={{ color: "var(--text-muted)", fontWeight: 600 }}>
                On-box tools
              </div>
              <div>
                {TOOL_DOMAIN_GROUPS.map((group) => {
                  const gate = group.feature ? featureDef(group.feature) : null;
                  const featureOff = !!group.feature && !draft.features[group.feature]?.on;
                  const level = featureOff ? null : draft.tools[group.id] ?? "view";
                  return (
                    <div
                      key={group.id}
                      className={`acc-tooldomain${featureOff ? " off" : ""}`}
                      data-testid={`access-tools-${group.id}`}
                    >
                      <Wrench size={16} aria-hidden="true" />
                      <span className="tx">
                        {group.label}
                        {featureOff && gate && <small>{ACCESS_COPY.toolAutoOff(gate.label)}</small>}
                        {group.locks && !featureOff && (
                          <small>Controls lights &amp; scenes — locks gated on the Devices row.</small>
                        )}
                      </span>
                      <div className="acc-seg" aria-label={`${group.label} tools`}>
                        <button
                          type="button"
                          className={level === "view" ? "on" : ""}
                          aria-pressed={level === "view"}
                          disabled={featureOff}
                          onClick={() => setToolLevel(group.id, "view")}
                        >
                          View
                        </button>
                        <button
                          type="button"
                          className={level === "use" ? "on" : ""}
                          aria-pressed={level === "use"}
                          disabled={featureOff}
                          onClick={() => setToolLevel(group.id, "use")}
                        >
                          Use
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Off the box — the caution block */}
            <div className="acc-caution">
              <div className="acc-caution-h">
                <Cloud size={16} aria-hidden="true" />
                {ACCESS_COPY.offBoxHeader}
              </div>
              <div className="acc-conn-row">
                <span className="tx">{ACCESS_COPY.cloudModelsToggle}</span>
                <AccessToggle
                  on={draft.cloud}
                  ariaLabel={ACCESS_COPY.cloudModelsToggle}
                  onChange={handleCloudToggle}
                />
              </div>
              <div className="acc-consequence">{ACCESS_COPY.cloudConsequence}</div>
              <div className="acc-hairline" />
              <div className="acc-caution-h" style={{ fontSize: 12.5 }}>
                <Plug size={15} aria-hidden="true" />
                Data connectors
              </div>
              <div className="acc-consequence">{ACCESS_COPY.connectorsPHI}</div>
              {connectors.length > 0 ? (
                <>
                  {connectors.map((connector) => {
                    const value = draft.connectors[connector.provider] ?? "none";
                    return (
                      <div key={connector.provider} className="acc-conn-row">
                        <span className="tx">
                          {connector.label}
                          {connector.note && <small>{connector.note}</small>}
                        </span>
                        <select
                          aria-label={`${connector.label} access`}
                          // The reason travels WITH the control, not just
                          // beside it — a floor is not decoration (§13).
                          aria-describedby={connectorReason ? floorNoteId : undefined}
                          value={value}
                          disabled={connectorsBlocked}
                          onChange={(e) =>
                            setConnector(connector.provider, e.target.value as ConnectorAccessLevel | "none")
                          }
                          className="px-2.5 py-2 outline-none focus:ring-2 focus:ring-[var(--brand)] transition-shadow disabled:cursor-not-allowed"
                          style={{
                            background: connectorsBlocked ? "var(--inset)" : "var(--surface)",
                            border: `1px solid ${connectorsBlocked ? "var(--card-bd)" : "var(--border)"}`,
                            borderRadius: "var(--radius-input)",
                            color: connectorsBlocked ? "var(--text-muted)" : "var(--text)",
                            fontSize: 13,
                          }}
                        >
                          {CONNECTOR_LEVELS.map((lvl) => (
                            <option key={lvl} value={lvl} disabled={!connectorAllowed.has(lvl)}>
                              {CONNECTOR_LEVEL_LABEL[lvl]}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                  {/* Floor reason — the same Lock + sentence recipe the
                      feature-level pills use, so both floors read as one
                      idea. Text-first and neutral: never the --role-* ramp.
                      Placed control → reason → caption, matching LevelPills:
                      the ceiling is stated before the copy explaining levels
                      this role may not be able to pick. */}
                  {connectorReason && (
                    <div className="acc-floor-note" id={floorNoteId}>
                      <Lock size={12} aria-hidden="true" />
                      <span>
                        {blockedGrantHeldOver
                          ? `${connectorReason.replace(/\.$/, "")} — saving removes this.`
                          : connectorReason}
                      </span>
                    </div>
                  )}
                  <div className="acc-consequence">{ACCESS_COPY.connectorHint}</div>
                </>
              ) : (
                <div className="acc-consequence" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <span>{ACCESS_COPY.emptyConnectors}</span>
                  <Link href="/integrations" style={{ color: "var(--brand)", fontWeight: 600, whiteSpace: "nowrap" }}>
                    {ACCESS_COPY.openIntegrations}
                  </Link>
                </div>
              )}
            </div>
          </section>
        </div>

        {/* ── Sticky footer ── */}
        <div
          className="flex items-center gap-3 px-5 py-3.5"
          style={{ borderTop: "1px solid var(--card-bd)", background: "var(--card-bg)" }}
        >
          <SafetyChip variant="write" />
          <span style={{ flex: 1 }} />
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!canSave}
            onClick={() => onSave(draftToRolePayload(draft))}
          >
            {busy ? "Saving…" : "Save role"}
          </button>
        </div>
      </div>

      {/* §8 cloud-enable confirm — the grant is gated, the use-time internet
          moment stays disclosed on Chat/Models (design note in §5.4). */}
      <ConfirmDialog
        open={cloudConfirm}
        onConfirm={() => {
          patch({ cloud: true });
          setCloudConfirm(false);
        }}
        onCancel={() => setCloudConfirm(false)}
        title="Use cloud models?"
        description={ACCESS_COPY.cloudConfirm(draft.name.trim() || "this role")}
        confirmLabel="Turn on"
        cancelLabel="Keep off"
        variant="neutral"
      />
    </Dialog>
  );
}
