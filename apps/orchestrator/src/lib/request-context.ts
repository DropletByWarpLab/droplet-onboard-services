import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

interface RequestStore {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestStore>();

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function newRequestId(): string {
  return randomUUID();
}

export function sanitizeRequestId(
  raw: string | undefined | null,
): string | undefined {
  if (typeof raw !== "string") return undefined;
  return REQUEST_ID_RE.test(raw) ? raw : undefined;
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function runWithRequestId<T>(id: string, fn: () => T): T {
  return storage.run({ requestId: id }, fn);
}
