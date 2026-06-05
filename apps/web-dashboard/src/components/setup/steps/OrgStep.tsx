"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ChevronDown, ImageUp } from "lucide-react";
import { postOrg, OrgError } from "@/lib/api";
import { StepShell } from "@/components/setup/StepShell";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";

/**
 * Wizard step — Org (PR #380, slots AFTER account:
 * welcome → claim → account → org → internet → …).
 *
 * The customer names the single workspace (the "company brain") and reserves
 * its `droplet.local/<slug>`. Per the #380 spec + #371 handoff §3 +
 * OnbWizard.jsx `WizOrg`.
 *
 * PR #384 — reflowed into the shared aurora-rail `StepShell` (was a bespoke
 * centered column with an in-body CTA). `StepShell current="org"` owns the
 * "Step N" kicker, the "Create your workspace" title + sub, and the footer
 * "Continue" CTA; the body below is just the form. Functional behavior
 * (slug validation, "nothing off-box" footnote, NOT skippable) is unchanged.
 *
 * Structure (mirrors the WizOrg design):
 *   - Logo dropzone (dashed accent tile, OPTIONAL) beside the workspace-name
 *     input.
 *   - URL slug input with a `droplet.local /` prefix.
 *   - Time zone / industry / company size selects.
 *   - A footnote stating industry + size pick LOCAL smart defaults only and
 *     NOTHING is sent off the box (FEATURES §10 privacy guarantee).
 *
 * Edge cases:
 *   - Slug invalid (client-side `[a-z0-9-]` check) → inline error on the URL
 *     field; continue blocked, no network call.
 *   - Slug taken (server 409) → inline error on the URL field; stays on org.
 *   - Logo too large / wrong type → inline error on the logo tile. The logo is
 *     OPTIONAL, so a valid submit without a logo still proceeds.
 *
 * Org is NOT skippable — there is no skip control (it gates the workspace
 * identity everything after hangs off).
 *
 * Token mappings per #371 §3 (no hardcoded hex): dashed tile →
 * `bg-accent-subtle` (--color-accent-subtle) + `text-accent` (--color-accent);
 * inputs → `dp-input`; footnote → `type-caption-1 text-label-tertiary`; CTA →
 * `dp-btn-primary`. Motion: the shipped `animate-in fade-in duration-300` the
 * other steps use — restraint-first, no novel animation.
 */

/** Client-side slug shape — mirrors setup-org.service.isValidSlug so the
 *  wizard blocks an obviously-bad slug before the round-trip. The server is
 *  authoritative (reserved words + uniqueness); this is the fast inline guard. */
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Logo upload bounds — the logo is OPTIONAL; these only gate a chosen file. */
const MAX_LOGO_BYTES = 5 * 1024 * 1024; // 5 MB
const ACCEPTED_LOGO_TYPES = ["image/png", "image/jpeg", "image/svg+xml", "image/webp"];

/**
 * A small, curated set of common IANA time zones for the select. The full
 * tz database is large; the household can refine later in Settings. Kept as a
 * value→label list so the wire value is the canonical IANA id.
 */
const TIME_ZONES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "America/New_York", label: "America / New York (ET)" },
  { value: "America/Chicago", label: "America / Chicago (CT)" },
  { value: "America/Denver", label: "America / Denver (MT)" },
  { value: "America/Los_Angeles", label: "America / Los Angeles (PT)" },
  { value: "Europe/London", label: "Europe / London (GMT)" },
  { value: "Europe/Berlin", label: "Europe / Berlin (CET)" },
  { value: "Asia/Singapore", label: "Asia / Singapore (SGT)" },
  { value: "Australia/Sydney", label: "Australia / Sydney (AET)" },
];

/** Industry options. LOCAL smart-default hints only — never sent off the box. */
const INDUSTRIES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "logistics", label: "Logistics & distribution" },
  { value: "professional_services", label: "Professional services" },
  { value: "creative", label: "Creative & media" },
  { value: "retail", label: "Retail & e-commerce" },
  { value: "healthcare", label: "Healthcare" },
  { value: "construction", label: "Construction & trades" },
  { value: "technology", label: "Technology" },
  { value: "other", label: "Other" },
];

/** Company-size buckets. LOCAL smart-default hints only. */
const COMPANY_SIZES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "1-10", label: "1–10 people" },
  { value: "11-50", label: "11–50 people" },
  { value: "51-200", label: "51–200 people" },
  { value: "201-500", label: "201–500 people" },
  { value: "500+", label: "500+ people" },
];

/** Reusable labelled `<select>` matching the dp-input field treatment, with a
 *  chevron affordance (the native arrow is hidden via appearance-none). */
function SelectField({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <label htmlFor={id} className="block flex-1 min-w-0">
      <span className="type-footnote font-medium text-label-secondary mb-1.5 block">
        {label}
      </span>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="dp-input appearance-none pr-9"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown
          size={15}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-label-tertiary"
        />
      </div>
    </label>
  );
}

export function OrgStep({ onComplete }: { onComplete: () => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [tz, setTz] = useState(TIME_ZONES[0].value);
  const [industry, setIndustry] = useState(INDUSTRIES[0].value);
  const [size, setSize] = useState(COMPANY_SIZES[1].value);

  const [logoName, setLogoName] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  // Object URL for the chosen logo's live thumbnail. Kept in a ref too so the
  // unmount cleanup can revoke the latest value without re-subscribing.
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const logoPreviewRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Revoke the outstanding object URL on unmount so a half-finished setup never
  // leaks one. Replacement is revoked inline in handleLogoChange.
  useEffect(() => {
    return () => {
      if (logoPreviewRef.current) {
        URL.revokeObjectURL(logoPreviewRef.current);
      }
    };
  }, []);

  const [slugError, setSlugError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Normalize as the customer types so the previewed host matches what the
  // server will reserve. We don't strip characters (validation rejects bad
  // input) — only trim + lowercase, same as the service.
  const normalizedSlug = useMemo(() => slug.trim().toLowerCase(), [slug]);

  // Drop the current preview (revoke its object URL) and clear both the ref and
  // the state. Used before showing a new preview and on every invalid select so
  // a stale thumbnail never lingers behind an error.
  const clearLogoPreview = useCallback(() => {
    if (logoPreviewRef.current) {
      URL.revokeObjectURL(logoPreviewRef.current);
      logoPreviewRef.current = null;
    }
    setLogoPreview(null);
  }, []);

  const handleLogoChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!ACCEPTED_LOGO_TYPES.includes(file.type)) {
        setLogoError("That file type isn't supported. Use a PNG, JPG, SVG, or WebP.");
        setLogoName(null);
        clearLogoPreview();
        return;
      }
      if (file.size > MAX_LOGO_BYTES) {
        setLogoError("That image is too large. Keep the logo under 5 MB.");
        setLogoName(null);
        clearLogoPreview();
        return;
      }
      setLogoError(null);
      setLogoName(file.name);
      // Swap in a fresh thumbnail, revoking the previous URL first.
      clearLogoPreview();
      const nextPreview = URL.createObjectURL(file);
      logoPreviewRef.current = nextPreview;
      setLogoPreview(nextPreview);
    },
    [clearLogoPreview],
  );

  const handleContinue = useCallback(async () => {
    setFormError(null);
    setSlugError(null);

    if (!name.trim()) {
      setFormError("Give your workspace a name.");
      return;
    }
    if (!normalizedSlug || !SLUG_SHAPE.test(normalizedSlug)) {
      setSlugError(
        "Use lowercase letters, numbers, and hyphens (e.g. “acme-hq”).",
      );
      return;
    }

    setSubmitting(true);
    try {
      await postOrg({
        name: name.trim(),
        slug: normalizedSlug,
        tz,
        industry,
        size,
      });
      onComplete();
    } catch (err) {
      if (err instanceof OrgError && (err.slugTaken || err.slugInvalid)) {
        // Surface the server's slug verdict on the URL field.
        setSlugError(err.message);
      } else {
        setFormError(
          err instanceof Error
            ? err.message
            : "Couldn't save your workspace. Try again in a moment.",
        );
      }
      setSubmitting(false);
    }
  }, [name, normalizedSlug, tz, industry, size, onComplete]);

  return (
    <StepShell
      current="org"
      title="Create your workspace"
      subtitle="This names your company brain. Everyone you invite joins this single workspace."
      primary={{
        label: "Continue",
        loadingLabel: "Creating workspace…",
        onClick: () => void handleContinue(),
        isLoading: submitting,
      }}
    >
      {/* Logo tile + workspace name */}
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label={
              logoPreview && !logoError
                ? "Change workspace logo"
                : "Upload workspace logo"
            }
            className={[
              "flex h-[68px] w-[68px] items-center justify-center overflow-hidden rounded-2xl transition duration-200 ease-smooth",
              logoPreview && !logoError
                ? "border border-separator hover:opacity-90"
                : "flex-col gap-1 border-2 border-dashed border-accent/40 bg-accent-subtle text-accent hover:bg-accent-subtle/70",
            ].join(" ")}
          >
            {logoPreview && !logoError ? (
              <img
                src={logoPreview}
                alt="Workspace logo preview"
                className="h-full w-full object-cover"
              />
            ) : (
              <>
                <ImageUp size={18} />
                <span className="type-caption-2 font-semibold">Logo</span>
              </>
            )}
          </button>
          <input
            ref={fileInputRef}
            data-testid="org-logo-input"
            type="file"
            accept={ACCEPTED_LOGO_TYPES.join(",")}
            className="hidden"
            onChange={handleLogoChange}
          />
        </div>
        <div className="min-w-0 flex-1">
          <label htmlFor="org-name" className="block">
            <span className="type-footnote font-medium text-label-secondary mb-1.5 block">
              Workspace name
            </span>
            <input
              id="org-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme HQ"
              autoComplete="organization"
              className="dp-input"
              autoFocus
            />
          </label>
          {logoName && !logoError && (
            <p className="type-caption-1 text-label-tertiary mt-1.5 truncate">
              {logoName}
            </p>
          )}
          {logoError && (
            <p
              role="alert"
              className="type-caption-1 text-system-red mt-1.5 flex items-start gap-1.5"
            >
              <AlertCircle size={13} className="mt-px flex-shrink-0" />
              <span>{logoError}</span>
            </p>
          )}
        </div>
      </div>

      {/* Workspace URL (slug) with the droplet.local / prefix */}
      {/* WARP-820: fluid inter-section gaps so the form fits without scroll. */}
      <label htmlFor="org-slug" className="mt-[clamp(10px,2vh,16px)] block">
        <span className="type-footnote font-medium text-label-secondary mb-1.5 block">
          Workspace URL
        </span>
        <div
          className={[
            "dp-input flex items-center gap-1 px-3",
            slugError ? "ring-2 ring-system-red/40" : "",
          ].join(" ")}
        >
          <span className="type-subheadline whitespace-nowrap text-label-tertiary">
            droplet.local /
          </span>
          <input
            id="org-slug"
            type="text"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              if (slugError) setSlugError(null);
            }}
            placeholder="acme"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={slugError !== null}
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-label-primary placeholder:text-label-tertiary focus:outline-none focus:ring-0"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !submitting) void handleContinue();
            }}
          />
        </div>
        {slugError && (
          <p
            role="alert"
            className="type-caption-1 text-system-red mt-1.5 flex items-start gap-1.5"
          >
            <AlertCircle size={13} className="mt-px flex-shrink-0" />
            <span>{slugError}</span>
          </p>
        )}
      </label>

      {/* Time zone + industry + company size */}
      <div className="mt-[clamp(10px,2vh,16px)] flex gap-3">
        <SelectField
          id="org-tz"
          label="Time zone"
          value={tz}
          onChange={setTz}
          options={TIME_ZONES}
        />
        <SelectField
          id="org-industry"
          label="Industry"
          value={industry}
          onChange={setIndustry}
          options={INDUSTRIES}
        />
      </div>
      <div className="mt-[clamp(10px,2vh,16px)]">
        <SelectField
          id="org-size"
          label="Company size"
          value={size}
          onChange={setSize}
          options={COMPANY_SIZES}
        />
      </div>

      {/* Privacy footnote — the "nothing off the box" guarantee. */}
      <p className="type-caption-1 text-label-tertiary mt-[clamp(12px,2.4vh,20px)] leading-relaxed">
        We use industry and size only to pick smart defaults — example tools,
        folder structure, and camera policies. Nothing is sent off the box.
      </p>

      {formError && (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
        >
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <span>{formError}</span>
        </div>
      )}

      {/* Primary CTA lives in the StepShell footer — NOT skippable, so no
          skip control is passed. */}
      <LearnMoreCard helpAnchor="workspace">
        <p>
          Your workspace is the single &ldquo;company brain&rdquo; everyone you
          invite shares. The URL — <span className="font-mono">droplet.local
          /your-workspace</span> — only resolves on your own network.
        </p>
        <p>
          Industry and company size never leave the appliance. They just let
          Droplet pre-pick sensible folders, example tools, and camera
          policies you can change anytime.
        </p>
      </LearnMoreCard>
    </StepShell>
  );
}
