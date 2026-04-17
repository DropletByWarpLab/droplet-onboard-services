/**
 * DeviceRegistryError — structured error for the device-registry surface (WARP-80).
 *
 * Mirrors the shape of RouterError so the same error-handling middleware
 * can branch on `err instanceof DeviceRegistryError` + `err.code` and map
 * to a consistent HTTP status/JSON body. Every failure mode in the
 * device-intelligence path (MAC validation, group CRUD, icon allowlist,
 * foreign-key guard) flows through this class.
 *
 * Codes:
 *   - NOT_FOUND              — requested device or group does not exist (404)
 *   - GROUP_IN_USE           — attempted to delete a group that still has devices (409)
 *   - INVALID_ICON           — icon name is not in the allowlist (400)
 *   - INVALID_MAC            — MAC failed normalization (400)
 *   - DUPLICATE_GROUP_NAME   — unique-constraint violation on DeviceGroup.name (409)
 */

export type DeviceRegistryErrorCode =
  | "NOT_FOUND"
  | "GROUP_IN_USE"
  | "INVALID_ICON"
  | "INVALID_MAC"
  | "DUPLICATE_GROUP_NAME";

export class DeviceRegistryError extends Error {
  readonly code: DeviceRegistryErrorCode;
  readonly status?: number;

  constructor(
    code: DeviceRegistryErrorCode,
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "DeviceRegistryError";
    this.code = code;
    this.status = options?.status;
  }

  static notFound(what: string): DeviceRegistryError {
    return new DeviceRegistryError("NOT_FOUND", `${what} not found`, { status: 404 });
  }

  static invalidMac(raw: string): DeviceRegistryError {
    return new DeviceRegistryError("INVALID_MAC", `Invalid MAC: ${raw}`, { status: 400 });
  }

  static invalidIcon(icon: string): DeviceRegistryError {
    return new DeviceRegistryError("INVALID_ICON", `Icon not in allowlist: ${icon}`, {
      status: 400,
    });
  }

  static duplicateGroupName(name: string): DeviceRegistryError {
    return new DeviceRegistryError("DUPLICATE_GROUP_NAME", `Group "${name}" already exists`, {
      status: 409,
    });
  }

  /** Phase 2 reserve: not currently thrown — WARP-82 lets Prisma cascade
   *  the implicit join table so deleting a group with devices simply
   *  ungroups them. Kept here for a future opt-in "refuse if non-empty"
   *  delete mode. */
  static groupInUse(id: string): DeviceRegistryError {
    return new DeviceRegistryError("GROUP_IN_USE", `Group ${id} still has devices`, {
      status: 409,
    });
  }

  /** Shape sent over the wire. Omits `status` when unset so downstream
   *  wrappers like `{ error: err.toJSON() }` do not leak `status: undefined`. */
  toJSON(): { code: DeviceRegistryErrorCode; message: string; status?: number } {
    const out: { code: DeviceRegistryErrorCode; message: string; status?: number } = {
      code: this.code,
      message: this.message,
    };
    if (this.status !== undefined) out.status = this.status;
    return out;
  }
}
