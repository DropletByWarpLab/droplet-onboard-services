"use client";

/**
 * WARP-2738 — the role-template gallery.
 *
 * ADR-032 shipped the RBAC engine and nothing to start from: an operator
 * opening Access & Roles on a fresh box got an empty list and a blank builder.
 * This renders the box's code-resident catalogue
 * (`GET /api/access/role-templates`) as cards, each of which either
 * instantiates a real, ordinary AccessRole in one click or seeds the builder
 * for editing first.
 *
 * THE HONESTY SPLIT IS THE POINT OF THE TICKET.
 *
 * Per-person feature enforcement is UNEVEN and this surface must not paper
 * over it. The response's `enforcedModuleIds` is the live layer-2 gate roster
 * (`FEATURE_GATED_MODULES` on the server), and it is read from the payload
 * rather than restated here — the set has moved twice already, and a
 * dashboard-side copy would go stale silently, labelling a grant "enforced"
 * that isn't. A grant on a module IN that set genuinely withholds: the route
 * answers `404 module_disabled`. A grant on a module NOT in it is nav-only —
 * the menu entry hides and the API still answers whoever asks.
 *
 * The refusal is BYTE-IDENTICAL to the response when the whole box has the
 * module switched off, so nothing here may claim the person is told they lack
 * permission. No such screen exists. The verb is "will not see it".
 *
 * Two facts the payload cannot carry, and the copy therefore supplies (see
 * `copy.ts`): every registry-driven gate mounts at level `view`, so levels
 * above view are close to decorative outside three camera routes; and no
 * template ships a connector grant or a usage cap, which the operator adds
 * afterwards in the builder or not at all.
 *
 * This component owns its own read (§10 trio: skeletons → cards / honest empty
 * / error with Retry) rather than taking rows as a prop: it is mounted in two
 * places with different lifetimes — inline in the §4.1 empty state, and inside
 * the "Start from a template" dialog — and a panel-level fetch would have to
 * guess which. Every MUTATION stays with the panel.
 */

import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, EyeOff, KeyRound, LayoutTemplate, RefreshCw, ShieldCheck, Wrench } from "lucide-react";
import { listRoleTemplates } from "@/lib/api";
import type { RoleTemplate, RoleTemplateFeatureGrant } from "@/lib/types";
import { featureDef, tierLabel } from "@/lib/access";
import { ACCESS_COPY } from "./copy";
import { AccessChip, GuardNote } from "./bits";
import "./access.css";

type GalleryState = "loading" | "ready" | "error";

export interface RoleTemplateGalleryProps {
  /** One-click instantiate — the panel owns the confirm + POST. */
  onUse: (template: RoleTemplate) => void;
  /** Seed the builder from this template and open it. */
  onCustomize: (template: RoleTemplate) => void;
  /** Template whose create is in flight; its actions go disabled. */
  busyTemplateId?: string | null;
  /** `id` for the section heading. Supplied when a <Dialog> needs to point
   *  `labelledBy` at it; self-generated when the gallery renders inline. */
  headingId?: string;
}

/** One chip's worth of a feature grant.
 *
 *  `known: false` marks a moduleId this build's ACCESS_FEATURES does not
 *  carry — a box newer than this dashboard. It renders as its raw id in a
 *  mono chip rather than being dropped: a grant the operator cannot see is
 *  exactly the dishonesty this component exists to avoid. (`templateToDraft`
 *  has the opposite behaviour by necessity — see its doc comment — which is
 *  another reason the card must show it.) */
interface GrantChip {
  key: string;
  label: string;
  known: boolean;
}

function grantChip(grant: RoleTemplateFeatureGrant): GrantChip {
  const def = featureDef(grant.moduleId);
  if (!def) return { key: grant.moduleId, label: `${grant.moduleId} · ${grant.level}`, known: false };
  const level = def.levels.find((l) => l.value === grant.level);
  const suffix = def.levels.length > 1 && level ? ` · ${level.label.toLowerCase()}` : "";
  return { key: grant.moduleId, label: `${def.label}${suffix}`, known: true };
}

function GrantRow({
  icon,
  label,
  chips,
  testId,
}: {
  icon: ReactNode;
  label: string;
  chips: GrantChip[];
  testId: string;
}) {
  return (
    <div className="acc-tplrow" data-testid={testId}>
      <span className="lbl">
        {icon}
        {label}
      </span>
      <div className="chips">
        {chips.map((chip) => (
          <AccessChip key={chip.key} mono={!chip.known}>
            {chip.label}
          </AccessChip>
        ))}
        {/* An empty half of the split is information, not an empty state:
            "this template withholds nothing that is actually checked" is
            precisely what an operator needs to know before assigning it. */}
        {chips.length === 0 && <AccessChip tone="muted">{ACCESS_COPY.templatesNoneGranted}</AccessChip>}
      </div>
    </div>
  );
}

function TemplateCard({
  template,
  enforced,
  busy,
  onUse,
  onCustomize,
}: {
  template: RoleTemplate;
  /** The live layer-2 gate roster, straight from the response. */
  enforced: ReadonlySet<string>;
  busy: boolean;
  onUse: (t: RoleTemplate) => void;
  onCustomize: (t: RoleTemplate) => void;
}) {
  // Grant order is the catalogue's order — product order, preserved on both
  // sides of the split. Never sorted: a template's own emphasis is data.
  const checked: GrantChip[] = [];
  const navOnly: GrantChip[] = [];
  for (const grant of template.featureGrants) {
    (enforced.has(grant.moduleId) ? checked : navOnly).push(grantChip(grant));
  }

  return (
    <div className="acc-tplcard" data-testid={`access-template-${template.id}`}>
      <div className="hd">
        <span
          className="acc-glyph"
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: "var(--brand-subtle)",
            color: "var(--brand)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <KeyRound size={15} aria-hidden="true" />
        </span>
        <span className="nm">{template.name}</span>
        {/* `family` displays as "Staff" — the O-1 relabel lives in
            tierLabel() and nowhere else. */}
        <AccessChip>Based on {tierLabel(template.startingPoint)}</AccessChip>
      </div>

      <p className="desc">{template.description}</p>

      <GrantRow
        testId={`access-template-${template.id}-checked`}
        icon={<ShieldCheck size={12} aria-hidden="true" />}
        label={ACCESS_COPY.templatesEnforcedLegend}
        chips={checked}
      />
      <GrantRow
        testId={`access-template-${template.id}-navonly`}
        icon={<EyeOff size={12} aria-hidden="true" />}
        label={ACCESS_COPY.templatesNavOnlyLegend}
        chips={navOnly}
      />
      <GrantRow
        testId={`access-template-${template.id}-tools`}
        icon={<Wrench size={12} aria-hidden="true" />}
        label={ACCESS_COPY.toolsAxis}
        chips={template.toolGrants.map((t) => ({
          key: t.domain,
          label: `${t.domain} · ${t.level}`,
          known: false,
        }))}
      />
      {/* The one axis that is genuinely fail-closed, and the one place a level
          silently means nothing below admin: `tierKeepsWriteTools` admits
          owner and admin only, so `use` and `view` are the same grant here. */}
      {template.startingPoint !== "admin" && template.toolGrants.length > 0 && (
        <div className="acc-lvl-reason">
          <Wrench size={12} aria-hidden="true" />
          {ACCESS_COPY.toolsReadOnlyBelowAdmin}
        </div>
      )}

      <div className="ft">
        <button
          type="button"
          className="btn primary sm"
          disabled={busy}
          onClick={() => onUse(template)}
        >
          {ACCESS_COPY.templatesUse}
        </button>
        <button
          type="button"
          className="btn ghost sm"
          disabled={busy}
          onClick={() => onCustomize(template)}
        >
          {ACCESS_COPY.templatesCustomize}
        </button>
      </div>
    </div>
  );
}

export function RoleTemplateGallery({
  onUse,
  onCustomize,
  busyTemplateId = null,
  headingId,
}: RoleTemplateGalleryProps) {
  const autoId = useId();
  const hid = headingId ?? autoId;
  const [state, setState] = useState<GalleryState>("loading");
  const [templates, setTemplates] = useState<RoleTemplate[]>([]);
  const [enforcedIds, setEnforcedIds] = useState<string[]>([]);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const data = await listRoleTemplates();
      setTemplates(data.roleTemplates ?? []);
      setEnforcedIds(data.enforcedModuleIds ?? []);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const enforced = useMemo(() => new Set<string>(enforcedIds), [enforcedIds]);

  return (
    <section aria-labelledby={hid} data-testid="access-template-gallery">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <LayoutTemplate size={15} aria-hidden="true" style={{ color: "var(--text-faint)", flexShrink: 0 }} />
        <h3 id={hid} style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
          {ACCESS_COPY.templatesTitle}
        </h3>
      </div>
      <p
        style={{
          margin: "0 0 12px",
          fontSize: 12.5,
          lineHeight: 1.55,
          color: "var(--text-muted)",
        }}
      >
        {ACCESS_COPY.templatesLead}
      </p>

      {/* The disclosures live ONCE, above the grid, and the cards carry only
          the two legend keys. Repeating four caveats on eight cards would
          bury the thing they explain. */}
      <div className="acc-tpl-legend" style={{ marginBottom: 12 }}>
        <GuardNote icon={<KeyRound size={15} aria-hidden="true" />}>
          {ACCESS_COPY.templatesNarrowing}
        </GuardNote>
        <GuardNote icon={<ShieldCheck size={15} aria-hidden="true" />}>
          <b>{ACCESS_COPY.templatesEnforcedLegend}</b> — {ACCESS_COPY.templatesEnforcedLegendBody}
        </GuardNote>
        <GuardNote icon={<EyeOff size={15} aria-hidden="true" />}>
          <b>{ACCESS_COPY.templatesNavOnlyLegend}</b> — {ACCESS_COPY.templatesNavOnlyLegendBody}
        </GuardNote>
        <GuardNote icon={<Wrench size={15} aria-hidden="true" />}>
          {ACCESS_COPY.templatesLevelsNote} {ACCESS_COPY.templatesNoExtras}
        </GuardNote>
      </div>

      {state === "loading" && (
        <div className="acc-tplgrid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="acc-skel" data-testid="access-templates-skeleton" />
          ))}
        </div>
      )}

      {state === "error" && (
        <div className="card">
          <div className="empty">
            <span className="ei">
              <AlertTriangle size={24} />
            </span>
            <span className="eh">{ACCESS_COPY.rolesErrorTitle}</span>
            <span style={{ maxWidth: "40ch" }}>{ACCESS_COPY.templatesErrorBody}</span>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => void load()}
              style={{ marginTop: 8 }}
            >
              <RefreshCw size={13} /> {ACCESS_COPY.retry}
            </button>
          </div>
        </div>
      )}

      {state === "ready" && templates.length === 0 && (
        <div className="card">
          <div className="empty">
            <span className="ei">
              <LayoutTemplate size={24} />
            </span>
            <span style={{ maxWidth: "42ch" }}>{ACCESS_COPY.templatesEmpty}</span>
          </div>
        </div>
      )}

      {state === "ready" && templates.length > 0 && (
        // Rendered in the order the box served them — the array order IS the
        // product order, so this never sorts and never groups by tier.
        <div className="acc-tplgrid">
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              enforced={enforced}
              busy={busyTemplateId === template.id}
              onUse={onUse}
              onCustomize={onCustomize}
            />
          ))}
        </div>
      )}
    </section>
  );
}
