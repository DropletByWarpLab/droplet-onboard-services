// Wire types for the CRM surface (WARP-2545). Mirrors the orchestrator's
// Api* shapes in services/crm/crm.service.ts — one vocabulary, no translation
// layer in between.

export type CrmStageKind = "OPEN" | "WON" | "LOST";
export type CrmSubject = "COMPANY" | "CONTACT" | "DEAL";
export type CrmOrigin = "LOCAL" | "EXTERNAL";

export interface CrmStage {
  id: string;
  pipelineId: string;
  name: string;
  kind: CrmStageKind;
  sortOrder: number;
  probability: number | null;
}

export interface CrmPipeline {
  id: string;
  name: string;
  isDefault: boolean;
  sortOrder: number;
  archived: boolean;
  stages: CrmStage[];
}

export interface CrmCompany {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  phone: string | null;
  website: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  note: string | null;
  ownerId: string | null;
  origin: CrmOrigin;
  externalSystem: string | null;
  archived: boolean;
  openDealCount: number;
  contactCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CrmDeal {
  id: string;
  title: string;
  companyId: string | null;
  companyName: string | null;
  pipelineId: string;
  stageId: string;
  stage: CrmStage;
  /**
   * A decimal STRING of minor units, never a number. The orchestrator holds it
   * as a BigInt because a currency figure above 2^53 is a wrong answer rather
   * than an error, and parsing it back into a `number` here would throw that
   * away at the last step. Format it with {@link formatMinor}; do not do
   * arithmetic on it in the browser.
   */
  amountMinor: string | null;
  currency: string | null;
  expectedCloseOn: string | null;
  closedAt: string | null;
  closeReason: string | null;
  ownerId: string | null;
  projectId: string | null;
  origin: CrmOrigin;
  externalSystem: string | null;
  archived: boolean;
  contactIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CrmActivity {
  id: string;
  subjectType: CrmSubject;
  companyId: string | null;
  contactId: string | null;
  dealId: string | null;
  kind: string;
  summary: string;
  actorId: string | null;
  occurredAt: string;
  noteId: string | null;
  emailMessageId: string | null;
  calendarEventId: string | null;
  workItemId: string | null;
  fromStageId: string | null;
  toStageId: string | null;
  createdAt: string;
}

export interface CrmStageSummary {
  stageId: string;
  stageName: string;
  kind: CrmStageKind;
  sortOrder: number;
  dealCount: number;
  amountMinor: string;
  /** Null when the stage holds deals in more than one currency — in which case
   *  `amountMinor` is "0" and must NOT be rendered as a total. */
  currency: string | null;
}

export interface CrmContact {
  id: string;
  origin: CrmOrigin;
  displayName: string;
  givenName: string | null;
  familyName: string | null;
  organization: string | null;
  jobTitle: string | null;
  emails: Array<{ id: string; address: string; label: string | null; isPrimary: boolean }>;
  phones: Array<{ id: string; number: string; label: string | null; isPrimary: boolean }>;
}

/**
 * Minor units → a display string, without ever building a JS number from the
 * whole value.
 *
 * `Intl.NumberFormat` takes a string for exactly this case, so the integer and
 * fraction parts are split with string arithmetic and handed over as one. A
 * `Number(minor) / 100` would be correct for every deal a demo contains and
 * wrong for the one that matters.
 *
 * Assumes a two-decimal currency, which covers every currency this surface can
 * currently receive; a zero-decimal currency (JPY, KRW) would need the exponent
 * from the server rather than a guess here, and there is no path that produces
 * one yet.
 */
export function formatMinor(amountMinor: string | null, currency: string | null): string | null {
  if (amountMinor === null || currency === null) return null;
  const negative = amountMinor.startsWith("-");
  const digits = (negative ? amountMinor.slice(1) : amountMinor).padStart(3, "0");
  const whole = digits.slice(0, -2);
  const cents = digits.slice(-2);
  const plain = `${negative ? "-" : ""}${whole}.${cents}`;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      // @ts-expect-error — `Intl.NumberFormat` accepts a string here at
      // runtime (the ECMA-402 "string numeric literal" path). The lib.d.ts in
      // this TS version still types `format` as (n: number) => string, and
      // coercing to a number is the precision bug this function exists to
      // avoid.
    }).format(plain);
  } catch {
    // An unknown/malformed ISO code: show the number rather than nothing.
    return `${plain} ${currency}`;
  }
}
