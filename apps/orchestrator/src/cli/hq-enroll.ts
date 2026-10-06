/**
 * WARP-3503 — `npm run hq-enroll`: enroll this box's device key in the HQ
 * registry on demand, so it can get HQ device tokens (private OTA pulls,
 * telemetry; fleet contract v1 §1).
 *
 * Registry enrollment is explicit through this command and the provisioning
 * token. It is independent of the internal DNS name and WireGuard setup.
 * Idempotent: it first tries to mint a token, and only provisions when HQ says `not_enrolled`.
 * HQ's provision endpoint is itself idempotent for the same key and token.
 *
 * Run it through scripts/hq-enroll.sh. The last stdout line is
 * `hq-enroll: result=<HqEnrollResult>`; exit 0 only for an enrolled box (or
 * HQ not configured), so an operator's shell sees a failure.
 */
import fs from "node:fs";
import pino from "pino";
import { config } from "../config.js";
import { createDeviceIdentityClient } from "../services/device-identity.client.js";
import {
  createHqTokenService,
  HqTokenError,
  type HqTokenFailure,
  type HqTokenService,
} from "../services/hq-token.service.js";
import {
  createFleetRegistrationClient,
  provisionWithHq,
  type FleetLogger,
} from "../services/fleet-registration.service.js";

export type HqEnrollResult =
  | "already_enrolled"
  | "enrolled"
  | "revoked"
  | "no_provision_token"
  | "skipped"
  | "failed";

const OK_RESULTS: readonly HqEnrollResult[] = ["already_enrolled", "enrolled", "skipped"];

export function hqEnrollSentinelLine(result: HqEnrollResult): string {
  return `hq-enroll: result=${result}`;
}

export interface HqEnrollDeps {
  /** `!!config.HQ_ISSUANCE_URL`. */
  hqConfigured: boolean;
  /** `config.DROPLET_PROVISION_TOKEN` (may be empty). */
  provisionToken: string;
  tokens: Pick<HqTokenService, "getToken">;
  /** POST /api/issuance/provision with the token; throws on any HQ refusal. */
  provision: (provisionToken: string) => Promise<unknown>;
  logger: FleetLogger;
}

export async function runHqEnroll(deps: HqEnrollDeps): Promise<HqEnrollResult> {
  const { logger } = deps;
  if (!deps.hqConfigured) {
    logger.info({}, "hq-enroll: HQ_ISSUANCE_URL not configured, nothing to enroll with");
    return "skipped";
  }

  // Probing with a real token mint also proves the box can reach HQ and sign.
  // null = HQ issued a token, otherwise why it did not.
  const probe = async (): Promise<HqTokenFailure | null> => {
    try {
      await deps.tokens.getToken(["registry:pull"]);
      return null;
    } catch (err) {
      if (!(err instanceof HqTokenError)) throw err;
      logger.warn({ reason: err.reason, detail: err.detail }, "hq-enroll: HQ issued no token");
      return err.reason;
    }
  };

  const first = await probe();
  if (first === null) return "already_enrolled";
  if (first === "revoked") return "revoked";
  if (first !== "not_enrolled") return "failed";

  const token = deps.provisionToken.trim();
  if (token === "") {
    logger.warn({}, "hq-enroll: not enrolled and DROPLET_PROVISION_TOKEN is empty; mint one at HQ (POST /api/admin/provision-token)");
    return "no_provision_token";
  }
  try {
    await deps.provision(token);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "hq-enroll: HQ refused the enrollment");
    return "failed";
  }
  return (await probe()) === null ? "enrolled" : "failed";
}

async function main(): Promise<HqEnrollResult> {
  const logger = pino({ name: "hq-enroll-cli" });
  const identity = createDeviceIdentityClient();
  return runHqEnroll({
    hqConfigured: !!config.HQ_ISSUANCE_URL,
    provisionToken: config.DROPLET_PROVISION_TOKEN,
    tokens: createHqTokenService({ baseUrl: config.HQ_ISSUANCE_URL, identity }),
    provision: (provisionToken) =>
      provisionWithHq({
        deviceId: config.DROPLET_DEVICE_ID,
        hq: createFleetRegistrationClient(),
        identity,
        provisionToken,
      }),
    logger,
  });
}

// Only when invoked directly (`node dist/cli/hq-enroll.js`), not on import
// from the test. `process.exit` is deliberate: the device-identity gRPC channel
// can keep the event loop alive. The sentinel goes out with a synchronous
// write so exit cannot truncate it.
if ((process.argv[1] ?? "").includes("hq-enroll")) {
  void main()
    .catch((err: unknown): HqEnrollResult => {
      pino({ name: "hq-enroll-cli" }).error({ err }, "hq-enroll: unexpected error");
      return "failed";
    })
    .then((result) => {
      fs.writeSync(1, `${hqEnrollSentinelLine(result)}\n`);
      process.exit(OK_RESULTS.includes(result) ? 0 : 1);
    });
}
