/**
 * WARP-3538 (D13) — the cloud providers the file store knows, and how each is
 * spelled on the wire.
 *
 * The store is provider-agnostic: Microsoft 365 lands into it today, and Google
 * Drive and Dropbox land into the SAME tables and are found by the SAME search
 * right after. Two vocabularies cross a boundary here and must not drift:
 *
 *   - the Prisma enum `CloudFileProvider` (`M365`) — what the database holds; and
 *   - the wire spelling (`m365`) — what `GET /api/cloud-files` accepts in
 *     `?provider=` and returns in each result, what the assistant's tool offers
 *     the model, and what the dashboard reads.
 *
 * They are kept as ONE table so that adding a provider is one edit that the
 * compiler checks: `Record<CloudFileProvider, string>` has no entry to forget
 * and no extra one to leave behind — a value added to the schema enum that has no
 * wire name here fails to compile, which is the point. (Same two-way
 * construction as `NOTIFICATION_KINDS` in routes/notifications.ts.)
 *
 * The wire names are lower-case ASCII with no punctuation, because they are
 * also an enum the model chooses from (`search_cloud_files`'s `provider` arg):
 * a spelling it can mis-case is a spelling it will.
 */
import type { CloudFileProvider } from "@prisma/client";

export const PROVIDER_WIRE_NAMES: Readonly<Record<CloudFileProvider, string>> = {
  M365: "m365",
};

/**
 * How a provider is named to a person — the place a file is said to be when its
 * source is not known (a transient state: see `cloud-file-search.service.ts`). A
 * `Record` over the enum, so a new provider cannot ship without a name.
 */
export const PROVIDER_DISPLAY_NAMES: Readonly<Record<CloudFileProvider, string>> = {
  M365: "Microsoft 365",
};

/** Every provider the database can hold, in declaration order. */
export const CLOUD_FILE_PROVIDERS = Object.keys(PROVIDER_WIRE_NAMES) as CloudFileProvider[];

/** Every wire spelling, for validators and for the tool's enum. */
export const CLOUD_FILE_WIRE_PROVIDERS = Object.values(PROVIDER_WIRE_NAMES);

/** The wire spelling of a stored provider. */
export function providerToWire(provider: CloudFileProvider): string {
  return PROVIDER_WIRE_NAMES[provider];
}

/**
 * The stored provider for a wire spelling, or `null` for anything else.
 *
 * Exact match, no case folding: the set is closed and tiny, and a lenient
 * parser here is a second spelling every consumer has to keep accepting.
 */
export function providerFromWire(raw: string): CloudFileProvider | null {
  return CLOUD_FILE_PROVIDERS.find((p) => PROVIDER_WIRE_NAMES[p] === raw) ?? null;
}
