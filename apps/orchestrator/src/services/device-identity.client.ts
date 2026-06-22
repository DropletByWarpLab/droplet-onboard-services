/**
 * WARP-230 — gRPC client wrapping the `device-identity-svc` sidecar.
 *
 * Talks to the sidecar over a Unix domain socket
 * (`/var/run/droplet/device-identity.sock`). The grpc-js library treats a
 * `unix://<path>` URL natively — no extra socket wrangling.
 *
 * The four orchestrator-facing methods unwrap the proto types into
 * camelCase TS interfaces so callers never see protobuf.
 *
 * The `stubFactory` option follows the WARP-202 EmbeddingClient pattern
 * (see `embedding.client.ts`): production callers pass `{ socketPath }`
 * only; tests inject a tiny mock that satisfies `DeviceIdentityStub`.
 */
import { credentials, type ServiceError } from "@grpc/grpc-js";
import {
  DeviceIdentityServiceClient,
  type SignRequest,
  type SignResponse,
  type GetCertRequest,
  type GetCertResponse,
  type GetStatusRequest,
  type GetStatusResponse,
  type ResealRequest,
  type ResealResponse,
} from "../grpc-generated/device_identity.js";

const DEFAULT_SOCKET = "/var/run/droplet/device-identity.sock";

/**
 * Per-call gRPC deadline (ms). The sidecar can be present-but-wedged (e.g. a
 * stuck TPM op); without a deadline a single unary call hangs forever and any
 * caller awaiting it (factory-reset's `tls-deregister`, the order flow) blocks
 * indefinitely. 15s is generous for a TPM sign/seal yet bounded.
 */
const DEFAULT_CALL_DEADLINE_MS = 15_000;

export interface DeviceIdentityStatus {
  provisioned: boolean;
  backend: "real" | "mock";
  certSubject: string;
  certFingerprint: string;
  certExpiresAt: string;
  sealingPcrs: number[];
  sealValid: boolean;
  lastResealAt: string;
  currentPcrSnapshot: Record<string, string>;
}

export interface SignResult {
  signature: Uint8Array;
  algorithm: string;
}

export interface ResealResult {
  resealed: boolean;
  sealedAt: string;
  newPcrSnapshotIndices: number[];
}

/**
 * Minimal stub shape the client depends on. Tests pass a hand-rolled
 * object satisfying this; production wires the ts-proto-generated
 * `DeviceIdentityServiceClient`.
 */
export interface DeviceIdentityStub {
  sign(
    req: SignRequest,
    cb: (err: ServiceError | null, res: SignResponse | null) => void,
  ): unknown;
  getCert(
    req: GetCertRequest,
    cb: (err: ServiceError | null, res: GetCertResponse | null) => void,
  ): unknown;
  getStatus(
    req: GetStatusRequest,
    cb: (err: ServiceError | null, res: GetStatusResponse | null) => void,
  ): unknown;
  reseal(
    req: ResealRequest,
    cb: (err: ServiceError | null, res: ResealResponse | null) => void,
  ): unknown;
}

export interface DeviceIdentityClientOptions {
  /** Unix socket path. Defaults to `/var/run/droplet/device-identity.sock`. */
  socketPath?: string;
  /** Test seam — production paths construct the gRPC client directly. */
  stubFactory?: (target: string) => DeviceIdentityStub;
}

export interface DeviceIdentityClient {
  getDeviceIdentityStatus(): Promise<DeviceIdentityStatus>;
  signWithDeviceKey(payload: Uint8Array): Promise<SignResult>;
  getDeviceCert(): Promise<string>;
  requestReseal(operatorAuthNonce: string): Promise<ResealResult>;
}

function callUnary<Req, Res>(
  call: (
    req: Req,
    cb: (err: ServiceError | null, res: Res | null) => void,
  ) => unknown,
  req: Req,
  deadlineMs: number = DEFAULT_CALL_DEADLINE_MS,
): Promise<Res> {
  return new Promise<Res>((resolve, reject) => {
    // Race the gRPC callback against a deadline so a wedged sidecar can never
    // hang the caller. `settle()` guards against a late callback firing after
    // the deadline already rejected (and vice-versa); the timer is `unref`'d so
    // it never keeps the event loop / process alive on its own.
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error(`gRPC call timed out after ${deadlineMs}ms`), { code: "ETIMEDOUT" }));
    }, deadlineMs);
    if (typeof timer.unref === "function") timer.unref();

    call(req, (err, res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
        return;
      }
      if (!res) {
        reject(new Error("empty gRPC response"));
        return;
      }
      resolve(res);
    });
  });
}

export function createDeviceIdentityClient(
  opts: DeviceIdentityClientOptions = {},
): DeviceIdentityClient {
  const socketPath =
    opts.socketPath ?? process.env.DROPLET_DI_SOCKET ?? DEFAULT_SOCKET;
  const target = `unix://${socketPath}`;
  const stub: DeviceIdentityStub = opts.stubFactory
    ? opts.stubFactory(target)
    : (new DeviceIdentityServiceClient(
        target,
        credentials.createInsecure(),
      ) as unknown as DeviceIdentityStub);

  return {
    async getDeviceIdentityStatus() {
      const r = await callUnary<GetStatusRequest, GetStatusResponse>(
        stub.getStatus.bind(stub),
        {},
      );
      return {
        provisioned: r.provisioned,
        backend: r.backend as "real" | "mock",
        certSubject: r.certSubject,
        certFingerprint: r.certFingerprint,
        certExpiresAt: r.certExpiresAt,
        sealingPcrs: r.sealingPcrs,
        sealValid: r.sealValid,
        lastResealAt: r.lastResealAt,
        // Re-key the snapshot map so caller-facing keys are strings
        // regardless of how ts-proto materializes the map (number-keyed
        // object vs. string-keyed). Either form decays to string keys
        // when iterated in JS.
        currentPcrSnapshot: Object.fromEntries(
          Object.entries(r.currentPcrSnapshot ?? {}).map(([k, v]) => [
            String(k),
            v,
          ]),
        ),
      };
    },

    async signWithDeviceKey(payload) {
      const r = await callUnary<SignRequest, SignResponse>(
        stub.sign.bind(stub),
        { payload },
      );
      return { signature: r.signature, algorithm: r.algorithm };
    },

    async getDeviceCert() {
      const r = await callUnary<GetCertRequest, GetCertResponse>(
        stub.getCert.bind(stub),
        {},
      );
      return r.certPem;
    },

    async requestReseal(operatorAuthNonce) {
      const r = await callUnary<ResealRequest, ResealResponse>(
        stub.reseal.bind(stub),
        { operatorAuthNonce },
      );
      return {
        resealed: r.resealed,
        sealedAt: r.sealedAt,
        newPcrSnapshotIndices: r.newPcrSnapshotIndices,
      };
    },
  };
}
