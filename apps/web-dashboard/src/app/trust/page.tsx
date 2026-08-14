/**
 * WARP-246 — /trust: Trust Center placeholder.
 *
 * Placeholder structure for the full Trust Center (WARP-272):
 * attestations, policies, SBOMs, pen-test summaries, and incident
 * response, each with an honest roadmap status. Statuses are grounded
 * in docs/compliance-progress.md — nothing on this page is a
 * compliance CLAIM until the tracker marks it done, and artifact links
 * stay disabled until the artifacts exist.
 *
 * Visible to any authenticated household member (AuthGate handles the
 * login wall; there is deliberately no role gate here). The ticket
 * says "public"; a LAN appliance has no anonymous web surface, so
 * "signed-in household" is the closest honest reading — revisit for
 * WARP-272 if a truly unauthenticated page is wanted.
 */

"use client";

import type { ReactNode } from "react";
import {
  Award,
  FileText,
  Flame,
  PackageSearch,
  ShieldCheck,
  Siren,
} from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { Badge, Card, Sect, type BadgeKind } from "@/components/shell/primitives";

type Status = "shipped" | "in-progress" | "planned";

const STATUS_BADGE: Record<Status, { kind: BadgeKind; label: string }> = {
  shipped: { kind: "ok", label: "Shipped" },
  "in-progress": { kind: "info", label: "In progress" },
  planned: { kind: "muted", label: "Planned" },
};

interface TrustItem {
  name: string;
  detail: string;
  status: Status;
  /** Label for the (disabled) artifact link, once one will exist. */
  artifact?: string;
  /** When set, the artifact control renders as a real link. */
  artifactHref?: string;
}

interface TrustSection {
  title: string;
  icon: ReactNode;
  blurb: string;
  items: TrustItem[];
}

/** Statuses mirror docs/compliance-progress.md — update both together. */
const SECTIONS: TrustSection[] = [
  {
    title: "Attestations",
    icon: <Award size={16} />,
    blurb: "Independent audits of how Droplet protects your data.",
    items: [
      {
        name: "SOC 2 Type I",
        detail:
          "A point-in-time audit of our security controls by an independent firm. Scheduled once the engineering controls program completes.",
        status: "planned",
        artifact: "Report",
      },
      {
        name: "SOC 2 Type II",
        detail:
          "The stronger version: the same controls observed over 6–12 months of real operation.",
        status: "planned",
        artifact: "Report",
      },
      {
        name: "HIPAA readiness",
        detail:
          "Architecture review, Business Associate Agreement template, and processes for businesses and practices handling health data.",
        status: "planned",
      },
    ],
  },
  {
    title: "Platform security",
    icon: <Flame size={16} />,
    blurb: "Security engineering that is already on the box.",
    items: [
      {
        name: "Tamper-evident activity log",
        detail:
          "Important actions are signed and hash-chained on the device. Admins can verify the chain any time from the Audit log page.",
        status: "shipped",
      },
      {
        name: "TPM-sealed device identity",
        detail:
          "Each Droplet's identity key is sealed inside its TPM security chip and never leaves it.",
        status: "shipped",
      },
      {
        name: "FIPS 140-3 cryptography",
        detail:
          "Migrating every service onto validated cryptographic modules; the activation apparatus and CI enforcement are in place.",
        status: "in-progress",
      },
    ],
  },
  {
    title: "Policies",
    icon: <FileText size={16} />,
    blurb: "The written rules we hold ourselves to.",
    items: [
      {
        name: "Information security policy library",
        detail:
          "The full policy set (access control, change management, vendor risk, and more), published here when ratified.",
        status: "planned",
        artifact: "View policies",
      },
    ],
  },
  {
    title: "Software bill of materials",
    icon: <PackageSearch size={16} />,
    blurb: "Exactly what software ships on your box, component by component.",
    items: [
      {
        name: "Per-service SBOMs (CycloneDX 1.5)",
        detail:
          "A machine-readable inventory for every service image, plus one aggregated device SBOM, generated and schema-validated in CI and attached to every OTA release.",
        status: "in-progress",
        artifact: "Releases",
        artifactHref:
          "https://github.com/DropletByWarpLab/droplet-onboard-services/releases",
      },
    ],
  },
  {
    title: "Penetration testing",
    icon: <ShieldCheck size={16} />,
    blurb: "Paying professionals to break in before anyone else tries.",
    items: [
      {
        name: "Third-party penetration test",
        detail:
          "Vendor selection first, then a full test of the appliance and its remote-access path. Summaries will be published here.",
        status: "planned",
        artifact: "Summary",
      },
    ],
  },
  {
    title: "Incident response",
    icon: <Siren size={16} />,
    blurb: "What we do, and what we tell you, if something goes wrong.",
    items: [
      {
        name: "Response process & disclosures",
        detail:
          "A documented breach-notification runbook and a public disclosure log for any security incident that affects customers.",
        status: "planned",
        artifact: "Disclosures",
      },
    ],
  },
];

export default function TrustPage() {
  return (
    <ShellPage
      icon={<ShieldCheck size={15} />}
      label="Trust Center"
      title="Trust Center"
      sub="How Droplet earns the right to sit on your network, and where that work stands."
    >
      <div className="card" style={{ marginBottom: 22 }}>
        <p style={{ fontSize: 13.5, color: "var(--text)", lineHeight: 1.55, maxWidth: "68ch" }}>
          Droplet is built local-first: your data lives on your box, not on our
          servers. This page is our compliance roadmap in the open. Items marked{" "}
          <Badge kind="muted">Planned</Badge> or <Badge kind="info">In progress</Badge>{" "}
          are commitments, not certifications: each becomes a download here the
          day it is real, and never before.
        </p>
      </div>

      {SECTIONS.map((section) => (
        <section key={section.title} style={{ marginBottom: 26 }}>
          <Sect title={section.title} extra={section.blurb} />
          <Card>
            {section.items.map((item) => {
              const badge = STATUS_BADGE[item.status];
              return (
                <div key={item.name} className="lrow" style={{ alignItems: "flex-start" }}>
                  <span className="ri brand" aria-hidden>
                    {section.icon}
                  </span>
                  <span className="rt" style={{ whiteSpace: "normal" }}>
                    <span className="nm">{item.name}</span>
                    <span className="sub" style={{ whiteSpace: "normal" }}>
                      {item.detail}
                    </span>
                  </span>
                  <Badge kind={badge.kind}>{badge.label}</Badge>
                  {item.artifact && item.artifactHref ? (
                    <a
                      className="btn sm ghost"
                      href={item.artifactHref}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {item.artifact}
                    </a>
                  ) : item.artifact ? (
                    <button
                      type="button"
                      className="btn sm ghost"
                      disabled
                      title="Available once published"
                    >
                      {item.artifact}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </Card>
        </section>
      ))}
    </ShellPage>
  );
}
