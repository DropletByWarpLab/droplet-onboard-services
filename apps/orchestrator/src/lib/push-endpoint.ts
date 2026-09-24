/**
 * WARP-2904: vet a Web Push subscription endpoint before the orchestrator
 * stores it or dials it.
 *
 * WHY THIS IS NOT JUST `assertOutboundUrlAllowed`: web-push 3.6.7 does not dial
 * the WHATWG-parsed host. It dials Node's LEGACY `url.parse(endpoint).hostname`
 * (web-push-lib.js:348-349), and the two parsers disagree:
 *
 *   https://127.0.0.1;.evil.example/push/abc
 *     new URL(..).hostname  → "127.0.0.1;.evil.example"  (passed the old guard)
 *     url.parse(..).hostname → "127.0.0.1"               (what web-push dialled)
 *
 * So this module never lets the two parsers disagree:
 *   1. It parses with BOTH, and both must produce the same hostname.
 *   2. The host must be plain `^[a-z0-9.-]+$`. That refuses `;`, `@`, `\`,
 *      `%`, whitespace and IP-literal brackets.
 *   3. The host must belong to a real push service (PUSH_SERVICE_HOSTS). An
 *      arbitrary public host is refused, so the admin-facing promise ("a push
 *      service run by Google, Apple, Mozilla or Microsoft") is literally true.
 *   4. It is https on the default port, with no userinfo.
 *   5. It returns a NORMALISED URL rebuilt from the vetted parts, and the
 *      caller dials that URL, never the raw row. The legacy parser is re-run
 *      on the rebuilt URL as a final agreement check.
 * The host it returns is exactly the host web-push connects to, so the audit
 * row names the real destination.
 *
 * DNS is checked separately, at dial time only (`assertPushDestination`), so
 * that subscribing still works while the box is offline.
 */
import { parse as legacyParse } from "node:url";
import { assertOutboundDestinationAllowed } from "./outbound-url-guard.js";

/**
 * The push services browsers actually hand out: Chrome/Chromium-based Edge
 * (FCM), Firefox (Mozilla autopush), Safari (Apple) and legacy Edge (Windows
 * Notification Service, per-region subdomains). Registered in
 * docs/security/allowed-egress.yaml as `web-push-services`.
 */
export const PUSH_SERVICE_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
] as const;
/** WNS hands out region-specific hosts, e.g. `wns2-by3p.notify.windows.com`. */
const PUSH_SERVICE_SUFFIX = ".notify.windows.com";

const PLAIN_HOST = /^[a-z0-9.-]+$/;

export type PushEndpointRejection =
  | "malformed"
  | "https_required"
  | "bad_host"
  | "not_a_push_service";

export class PushEndpointRejected extends Error {
  constructor(readonly reason: PushEndpointRejection) {
    super(reason);
    this.name = "PushEndpointRejected";
  }
}

export interface VettedPushEndpoint {
  /** Exactly the host web-push will connect to. */
  host: string;
  /** Rebuilt from the vetted parts. This is the URL that gets dialled. */
  url: string;
}

function isPushServiceHost(host: string): boolean {
  if ((PUSH_SERVICE_HOSTS as readonly string[]).includes(host)) return true;
  return host.endsWith(PUSH_SERVICE_SUFFIX) && host.length > PUSH_SERVICE_SUFFIX.length;
}

/** Synchronous structural vetting, used at registration AND at dial time. */
export function vetPushEndpoint(raw: string): VettedPushEndpoint {
  let whatwg: URL;
  try {
    whatwg = new URL(raw);
  } catch {
    throw new PushEndpointRejected("malformed");
  }
  if (whatwg.protocol !== "https:") throw new PushEndpointRejected("https_required");
  const legacy = legacyParse(raw);
  const host = whatwg.hostname;
  if (
    !PLAIN_HOST.test(host) ||
    legacy.hostname !== host ||
    whatwg.username !== "" ||
    whatwg.password !== "" ||
    legacy.auth ||
    whatwg.port !== "" ||
    legacy.port
  ) {
    throw new PushEndpointRejected("bad_host");
  }
  if (!isPushServiceHost(host)) throw new PushEndpointRejected("not_a_push_service");

  const url = `https://${host}${whatwg.pathname}${whatwg.search}`;
  // Belt and braces: the URL we hand web-push must parse back to the same
  // host under web-push's own parser.
  if (legacyParse(url).hostname !== host) throw new PushEndpointRejected("bad_host");
  return { host, url };
}

/**
 * Dial-time DNS check: refuse if the vetted host resolves inside the
 * boundary (RFC1918, loopback, link-local, …). The DNS-rebind residual
 * documented in outbound-url-guard.ts still applies, because web-push
 * resolves again when it connects. The host pin above is what bounds that
 * residual.
 */
export async function assertPushDestination(vetted: VettedPushEndpoint): Promise<void> {
  await assertOutboundDestinationAllowed(vetted.url);
}
