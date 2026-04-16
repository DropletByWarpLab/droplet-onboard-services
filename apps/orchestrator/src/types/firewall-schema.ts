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
// errors. Every field is optional — OpenWrt omits defaults from the on-disk
// config.

export const FirewallZoneSchema = z
  .object({
    name: z.string().optional(),
    network: stringOrList.optional(),
    input: z.string().optional(),
    output: z.string().optional(),
    forward: z.string().optional(),
    masq: z.string().optional(),
  })
  .passthrough();

export const FirewallRuleSchema = z
  .object({
    name: z.string().optional(),
    src: z.string().optional(),
    dest: z.string().optional(),
    src_mac: z.string().optional(),
    proto: stringOrList.optional(),
    src_port: z.string().optional(),
    dest_port: z.string().optional(),
    target: z.string().optional(),
    enabled: z.string().optional(),
  })
  .passthrough();

export const FirewallRedirectSchema = z
  .object({
    name: z.string().optional(),
    src: z.string().optional(),
    dest: z.string().optional(),
    proto: stringOrList.optional(),
    src_dport: z.string().optional(),
    dest_ip: z.string().optional(),
    dest_port: z.string().optional(),
    target: z.string().optional(),
    enabled: z.string().optional(),
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
