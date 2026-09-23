"use client";

/**
 * WARP-2900 (ADR-056 slice H4) — the promote readback and its confirm step.
 *
 * 🔴 RENDERS ONLY WHAT THE ORCHESTRATOR DERIVED FROM `provides`, `resources`
 * AND `egress`. The props are the readback object, the preflight and the
 * identity of the bytes being signed — there is no prop through which the
 * manifest's name, summary or any tool description could arrive, so an
 * author who writes "read-only, harmless" on a tool that deletes things
 * cannot put those words in front of the owner at the moment they decide.
 * The count of tools, and that every one of them starts as a change that
 * asks first, comes from what the manifest PROVIDES.
 *
 * Confirming is the write: the owner's click signs the code with this box's
 * key. The step says so, carries the write chip, and cannot be clicked while
 * the preflight blocks.
 */
import { useState } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { Badge, Card, Row } from "@/components/shell/primitives";
import type { ExtensionPreflight, ExtensionReadback } from "@/lib/types";
import { labelForDomain } from "@/lib/tool-domains";
import { TOOLS_START_BLOCKED } from "./copy";

export interface PromoteReadbackProps {
  slug: string;
  version: string;
  /** Absent when phase 1 was refused: nothing was read back to sign. */
  commit?: string;
  manifestSha256?: string;
  readback: ExtensionReadback;
  preflight: ExtensionPreflight;
  /** False when phase 1 was refused (the preflight blocks): read-only view. */
  confirmable: boolean;
  /** Areas the owner may file the tools under; `data` is the box default. */
  domains: readonly string[];
  busy: boolean;
  error: string | null;
  onConfirm: (operatorDomain: string) => void;
  onCancel: () => void;
}

const DEFAULT_DOMAIN = "data";

export function PromoteReadback(props: PromoteReadbackProps) {
  const { readback, preflight } = props;
  const [domain, setDomain] = useState(DEFAULT_DOMAIN);
  const areas = props.domains.includes(DEFAULT_DOMAIN) ? props.domains : [DEFAULT_DOMAIN, ...props.domains];
  const blocked = preflight.blocking.length > 0;

  return (
    <Card
      icon={<ShieldCheck size={15} />}
      title={`Before you promote ${props.slug} ${props.version}`}
      meta={<Badge kind="warn">Write · confirm to apply</Badge>}
    >
      <p className="sub" style={{ marginTop: 0 }}>What this extension gets:</p>
      <ul aria-label="What this extension gets" style={{ margin: "0 0 12px", paddingLeft: 18 }}>
        {readback.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="sub">{TOOLS_START_BLOCKED}</p>

      {blocked ? (
        <div role="alert" style={{ margin: "12px 0" }}>
          <p style={{ margin: "0 0 4px", fontWeight: 600, display: "flex", gap: 6, alignItems: "center" }}>
            <AlertTriangle size={15} aria-hidden /> This cannot be promoted yet
          </p>
          <ul aria-label="What blocks it" style={{ margin: 0, paddingLeft: 18 }}>
            {preflight.blocking.map((f) => (
              <li key={`${f.code}:${f.detail}`}>{f.detail}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {preflight.advisory.length > 0 ? (
        <div style={{ margin: "12px 0" }}>
          <p style={{ margin: "0 0 4px", fontWeight: 600 }}>Worth knowing</p>
          <ul aria-label="Worth knowing" style={{ margin: 0, paddingLeft: 18 }}>
            {preflight.advisory.map((f) => (
              <li key={`${f.code}:${f.detail}`}>{f.detail}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="rows">
        {props.commit && props.manifestSha256 ? (
          <Row
            title="What gets signed"
            sub={`commit ${props.commit.slice(0, 12)} · manifest ${props.manifestSha256.slice(0, 12)}`}
            subMono
          />
        ) : null}
        {props.confirmable ? (
          <Row
            title="Area"
            sub="Where the assistant looks for its tools when a message is about that area."
            right={
              <select aria-label="Area" value={domain} onChange={(e) => setDomain(e.target.value)}>
                {areas.map((d) => (
                  <option key={d} value={d}>
                    {labelForDomain(d)}
                  </option>
                ))}
              </select>
            }
          />
        ) : null}
      </div>

      {props.error ? (
        <p className="sub" role="alert" style={{ color: "var(--danger)" }}>
          {props.error}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        {props.confirmable ? (
          <button
            type="button"
            className="btn primary"
            disabled={blocked || props.busy}
            onClick={() => props.onConfirm(domain)}
          >
            {props.busy ? "Signing…" : "Sign and install"}
          </button>
        ) : null}
        <button type="button" className="btn ghost" onClick={props.onCancel} disabled={props.busy}>
          {props.confirmable ? "Cancel" : "Close"}
        </button>
      </div>
    </Card>
  );
}
