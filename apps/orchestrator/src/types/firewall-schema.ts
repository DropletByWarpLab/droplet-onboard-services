/**
 * WARP-42: zod contract for the routing service's `/firewall/*` wire shape.
 *
 * Kept separate from the interface definitions in `network.ts` so the
 * runtime dependency (zod) is tree-shaken out of bundles that only need
 * the types. `fetchFirewallZones/Rules/Redirects` in `openwrt.client.ts`
 * parses every response through these schemas — schema drift on the
 * routing side becomes a typed error at the boundary instead of a silent
 * break in the dashboard.
 */

import { z } from "zod";

/** string-or-string-list: OpenWrt UCI stores list-typed fields as either. */
const stringOrList = z.union([z.string(), z.array(z.string())]);

// `passthrough()` lets unknown keys (like `.anonymous`, `.type`, `.name`, or
// fields OpenWrt adds in a future version) flow through without validation
// errors. Every field is `.nullish()` (optional + nullable) — OpenWrt omits
// defaults from the on-disk config, and ubus surfaces some omitted fields as
// `null` (e.g. a LAN zone with no `masq`), which `.optional()` alone rejects.

export const FirewallZoneSchema = z
  .object({
    name: z.string().nullish(),
    network: stringOrList.nullish(),
    input: z.string().nullish(),
    output: z.string().nullish(),
    forward: z.string().nullish(),
    masq: z.string().nullish(),
  })
  .passthrough();

export const FirewallRuleSchema = z
  .object({
    name: z.string().nullish(),
    src: z.string().nullish(),
    dest: z.string().nullish(),
    src_mac: z.string().nullish(),
    proto: stringOrList.nullish(),
    src_port: z.string().nullish(),
    dest_port: z.string().nullish(),
    target: z.string().nullish(),
    enabled: z.string().nullish(),
  })
  .passthrough();

export const FirewallRedirectSchema = z
  .object({
    name: z.string().nullish(),
    src: z.string().nullish(),
    dest: z.string().nullish(),
    proto: stringOrList.nullish(),
    src_dport: z.string().nullish(),
    dest_ip: z.string().nullish(),
    dest_port: z.string().nullish(),
    target: z.string().nullish(),
    enabled: z.string().nullish(),
  })
  .passthrough();

export const FirewallZonesSchema = z
  .object({
    values: z.record(z.string(), FirewallZoneSchema).default({}),
  })
  .passthrough();

export const FirewallRulesSchema = z
  .object({
    values: z.record(z.string(), FirewallRuleSchema).default({}),
  })
  .passthrough();

export const FirewallRedirectsSchema = z
  .object({
    values: z.record(z.string(), FirewallRedirectSchema).default({}),
  })
  .passthrough();
