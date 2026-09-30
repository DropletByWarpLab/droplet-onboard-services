"use client";

/**
 * WARP-3205 (WARP-2900 H5; PR #2326 decision 2) — the owner's review of
 * each extension tool: the one dashboard caller of
 * `PATCH /api/admin/remote-tools/classifications/:serverId/:toolName`.
 *
 * Every tool an extension brings imports as a confirming write and is
 * refused at dispatch until an owner reviews it as read-only (or blocks it).
 * What the owner decides FROM is what the box can vouch for:
 *
 *   - the tool's name and the ARGUMENTS it takes, read from the schema the
 *     classification row's review hash names (the orchestrator reads it from
 *     the signed manifest and sends it only when it hashes to that row). The
 *     schema is its author's JSON and any string in it can be prose, so the
 *     arguments list is only what the box reads from its structure — each
 *     argument's name when it is a plain identifier, its JSON type, whether
 *     it is required (./tool-arguments.ts). With no schema there is no
 *     review: a decision the box cannot bind to what was shown is not
 *     offered;
 *   - the signed description AND the whole schema, notes included, only
 *     inside a disclosure that says whose words they are. They are shown at
 *     all because the review hash binds both
 *     (`remoteToolReviewHash(description, schemaHash)`): a changed tool is
 *     reset and a review of the old one is STALE_REVIEW, so the owner is
 *     reviewing these words too and must be able to read them. The row's
 *     recorded wire description has no field in this component's types, so
 *     it cannot be rendered.
 *
 * A decision echoes the row's `inputSchemaHash`, so arguments or a
 * description that changed between reading and clicking are a 409
 * STALE_REVIEW (said plainly, and the list is read again) rather than a
 * review of a tool nobody saw. Both decisions ask first. Owner-only in the
 * UI; `requireRole("owner")` on the orchestrator is the boundary.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Puzzle } from "lucide-react";
import { Badge, Card, Row, Sect } from "@/components/shell/primitives";
import { useExtensionToolReview } from "@/lib/hooks/useExtensionToolReview";
import { classificationLabel } from "@/lib/runtime-tools";
import type { ExtensionListItem, ExtensionToolClassification, ExtensionToolDecision } from "@/lib/types";
import { displayVersion } from "./copy";
import { readArguments } from "./tool-arguments";
import {
  ARGUMENT_NAME_WITHHELD,
  ARGUMENTS_LABEL,
  AUTHOR_WORDS_NOTE,
  AUTHOR_WORDS_SUMMARY,
  NO_ARGUMENTS_SHOWN,
  NO_DECLARED_ARGUMENTS,
  NO_TOOLS_YET,
  TOOL_REVIEW_INTRO,
  TOOL_REVIEW_OWNER_ONLY,
  TOOLS_UNREADABLE,
  argumentFacts,
  confirmSentence,
  explainToolReviewError,
  savedSentence,
  type ToolReviewKind,
} from "./tool-review-copy";

const DECISIONS: Record<ToolReviewKind, Omit<ExtensionToolDecision, "inputSchemaHash">> = {
  read: { requiresWrite: false, requiresConfirmation: false, denied: false },
  block: { requiresWrite: true, requiresConfirmation: true, denied: true },
};

const NOTE: CSSProperties = { margin: 0, fontSize: 12.5, lineHeight: 1.5, color: "var(--text-muted)" };
const BLOCK: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, padding: "0 2px 14px" };
const ARGS: CSSProperties = { margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6, color: "var(--text)" };
const SCHEMA: CSSProperties = {
  margin: "8px 0 0",
  maxHeight: 240,
  overflow: "auto",
  padding: "10px 12px",
  borderRadius: 9,
  background: "var(--surface-2)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.45,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};
const QUOTE: CSSProperties = {
  margin: "6px 0 0",
  padding: "2px 0 2px 10px",
  borderLeft: "2px solid var(--card-bd)",
  fontSize: 12.5,
  color: "var(--text-muted)",
  whiteSpace: "pre-wrap",
};
const ACTIONS: CSSProperties = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" };
const MONO: CSSProperties = { fontFamily: "var(--font-mono)" };

export interface ToolReviewsProps {
  extensions: ExtensionListItem[];
  canReview: boolean;
}

/**
 * The section: one review card per extension that has a signed version and
 * is not uninstalled (an uninstalled one's tools are attached nowhere).
 */
export function ToolReviews({ extensions, canReview }: ToolReviewsProps) {
  const shown = extensions.filter((e) => e.version !== null && e.status !== "uninstalled");
  if (shown.length === 0) return null;
  return (
    <>
      <Sect title="Tool reviews" />
      <Card>
        <p style={NOTE}>{TOOL_REVIEW_INTRO}</p>
        {canReview ? null : <p style={{ ...NOTE, marginTop: 8 }}>{TOOL_REVIEW_OWNER_ONLY}</p>}
      </Card>
      {shown.map((e) => (
        <ToolReview key={e.id} extension={e} canReview={canReview} />
      ))}
    </>
  );
}

function reviewedLine(row: ExtensionToolClassification): string {
  if (!row.reviewedBy) return "Not reviewed yet";
  const at = row.reviewedAt ? new Date(row.reviewedAt) : null;
  return at && !Number.isNaN(at.getTime())
    ? `Reviewed by ${row.reviewedBy} · ${at.toLocaleDateString()}`
    : `Reviewed by ${row.reviewedBy}`;
}

/** The box's reading of a tool's arguments: names, JSON types, required. Never a string of the author's prose. */
function ArgumentList({ schema, tool }: { schema: Record<string, unknown>; tool: string }) {
  const args = readArguments(schema);
  if (args.length === 0) return <p style={NOTE}>{NO_DECLARED_ARGUMENTS}</p>;
  return (
    <ul style={ARGS} aria-label={`Arguments ${tool} takes`}>
      {args.map((a, i) => (
        // An argument name need not be shown (or unique once withheld); the order is the schema's.
        <li key={i}>
          {a.name !== null ? <code style={MONO}>{a.name}</code> : ARGUMENT_NAME_WITHHELD}
          {" · "}
          {argumentFacts(a.types, a.required)}
        </li>
      ))}
    </ul>
  );
}

export function ToolReview({ extension, canReview }: { extension: ExtensionListItem; canReview: boolean }) {
  const review = useExtensionToolReview(extension.id);
  const [confirming, setConfirming] = useState<{ tool: string; kind: ToolReviewKind } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ tool: string; ok: boolean; text: string } | null>(null);
  // Focus follows the decision: to the confirm step when it opens, back to
  // the action that opened it on cancel — never dropped on <body>.
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const actionRefs = useRef(new Map<string, HTMLButtonElement>());
  const [returnFocus, setReturnFocus] = useState<string | null>(null);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);
  useEffect(() => {
    if (returnFocus) {
      actionRefs.current.get(returnFocus)?.focus();
      setReturnFocus(null);
    }
  }, [returnFocus]);

  const decide = async (row: ExtensionToolClassification, kind: ToolReviewKind) => {
    if (!row.inputSchemaHash) return;
    setConfirming(null);
    setBusy(row.toolName);
    setOutcome(null);
    try {
      await review.classify(row.toolName, { ...DECISIONS[kind], inputSchemaHash: row.inputSchemaHash });
      setOutcome({ tool: row.toolName, ok: true, text: savedSentence(kind, row.toolName) });
    } catch (err) {
      setOutcome({ tool: row.toolName, ok: false, text: explainToolReviewError(err, row.toolName) });
    } finally {
      setBusy(null);
    }
  };

  // `<id>@<version>`, the source format the inspector and /tools use.
  const title = extension.version ? `${extension.id}@${displayVersion(extension.version.version)}` : extension.id;

  return (
    <Card icon={<Puzzle size={15} />} title={<span style={MONO}>{title}</span>}>
      {review.error ? (
        <p style={NOTE} role="alert">
          {TOOLS_UNREADABLE}
        </p>
      ) : review.isLoading ? (
        <p style={NOTE}>Loading…</p>
      ) : review.tools.length === 0 ? (
        <p style={NOTE}>{NO_TOOLS_YET}</p>
      ) : (
        <div className="rows">
          {review.tools.map((row) => {
            const name = row.toolName;
            const label = classificationLabel(row.decision);
            const reviewable = canReview && row.inputSchema !== null && !!row.inputSchemaHash;
            const open = confirming?.tool === name ? confirming.kind : null;
            const actionRef = (kind: ToolReviewKind) => (el: HTMLButtonElement | null) => {
              if (el) actionRefs.current.set(`${kind}:${name}`, el);
              else actionRefs.current.delete(`${kind}:${name}`);
            };
            return (
              <div key={name} role="group" aria-label={`Tool ${name}`}>
                <Row
                  title={<span style={MONO}>{name}</span>}
                  sub={reviewedLine(row)}
                  right={<Badge kind={label.kind}>{label.label}</Badge>}
                />
                <div style={BLOCK}>
                  {row.inputSchema === null ? (
                    <p style={NOTE}>{NO_ARGUMENTS_SHOWN}</p>
                  ) : (
                    <>
                      <p style={NOTE}>{ARGUMENTS_LABEL}</p>
                      <ArgumentList schema={row.inputSchema} tool={name} />
                      <details>
                        <summary style={NOTE}>{AUTHOR_WORDS_SUMMARY}</summary>
                        <p style={{ ...NOTE, marginTop: 6 }}>{AUTHOR_WORDS_NOTE}</p>
                        {row.declaredDescription ? (
                          <blockquote style={QUOTE} aria-label={`What its author says ${name} does`}>
                            {row.declaredDescription}
                          </blockquote>
                        ) : null}
                        <pre style={SCHEMA} aria-label={`The input schema its author wrote for ${name}`}>
                          {JSON.stringify(row.inputSchema, null, 2)}
                        </pre>
                      </details>
                    </>
                  )}

                  {reviewable && open ? (
                    <>
                      <p style={{ ...NOTE, color: "var(--text)" }}>{confirmSentence(open, name, extension.id)}</p>
                      <div style={ACTIONS}>
                        <button
                          ref={confirmRef}
                          type="button"
                          className={open === "block" ? "btn danger sm" : "btn primary sm"}
                          aria-label={open === "read" ? `Confirm: treat ${name} as read-only` : `Confirm: block ${name}`}
                          onClick={() => void decide(row, open)}
                        >
                          {open === "read" ? "Treat as read-only" : "Block"}
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm"
                          aria-label={`Cancel: keep ${name} as it is`}
                          onClick={() => {
                            setConfirming(null);
                            setReturnFocus(`${open}:${name}`);
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : reviewable ? (
                    <div style={ACTIONS}>
                      {row.decision.decision !== "allow" ? (
                        <button
                          ref={actionRef("read")}
                          type="button"
                          className="btn sm"
                          disabled={busy === name}
                          aria-label={`Treat ${name} as read-only`}
                          onClick={() => setConfirming({ tool: name, kind: "read" })}
                        >
                          Treat as read-only…
                        </button>
                      ) : null}
                      {!row.denied ? (
                        <button
                          ref={actionRef("block")}
                          type="button"
                          className="btn ghost sm"
                          disabled={busy === name}
                          aria-label={`Block ${name}`}
                          onClick={() => setConfirming({ tool: name, kind: "block" })}
                        >
                          Block…
                        </button>
                      ) : null}
                    </div>
                  ) : null}

                  {outcome?.tool === name ? (
                    <p style={{ ...NOTE, color: "var(--text)" }} role={outcome.ok ? "status" : "alert"}>
                      {outcome.text}
                    </p>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
