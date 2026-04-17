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
 *   - NOT_FOUND                — requested device or group does not exist (404)
 *   - GROUP_IN_USE             — attempted to delete a group that still has devices (409)
 *   - INVALID_ICON             — icon name is not in the allowlist (400)
 *   - INVALID_MAC              — MAC failed normalization (400)
 *   - DUPLICATE_GROUP_NAME     — unique-constraint violation on DeviceGroup.name (409)
 *   - SCHEDULE_NOT_FOUND       — schedule id does not exist (404)
 *   - SCHEDULE_INVALID_WINDOW  — window payload rejected (bad mask / minute range / wrap) (400)
 *   - SCHEDULE_SUBJECT_MISMATCH — schedule subject (device vs group) does not match target (400)
 *   - OVERRIDE_NOT_FOUND       — override id does not exist (404)
 *   - OVERRIDE_INVALID_RANGE   — override start/end range is invalid (400)
 *   - INVALID_DATE             — ISO-date input failed Date parsing (400)
 */

export type DeviceRegistryErrorCode =
  | "NOT_FOUND"
  | "GROUP_IN_USE"
  | "INVALID_ICON"
  | "INVALID_MAC"
  | "DUPLICATE_GROUP_NAME"
  | "SCHEDULE_NOT_FOUND"
  | "SCHEDULE_INVALID_WINDOW"
  | "SCHEDULE_SUBJECT_MISMATCH"
  | "OVERRIDE_NOT_FOUND"
  | "OVERRIDE_INVALID_RANGE"
  | "INVALID_DATE";

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

  static scheduleNotFound(id: string): DeviceRegistryError {
    return new DeviceRegistryError("SCHEDULE_NOT_FOUND", `Schedule ${id} not found`, {
      status: 404,
    });
  }

  static scheduleInvalidWindow(detail: string): DeviceRegistryError {
    return new DeviceRegistryError(
      "SCHEDULE_INVALID_WINDOW",
      `Invalid schedule window: ${detail}`,
      { status: 400 },
    );
  }

  static scheduleSubjectMismatch(detail: string): DeviceRegistryError {
    return new DeviceRegistryError(
      "SCHEDULE_SUBJECT_MISMATCH",
      `Schedule subject mismatch: ${detail}`,
      { status: 400 },
    );
  }

  static overrideNotFound(id: string): DeviceRegistryError {
    return new DeviceRegistryError("OVERRIDE_NOT_FOUND", `Override ${id} not found`, {
      status: 404,
    });
  }

  static overrideInvalidRange(detail: string): DeviceRegistryError {
    return new DeviceRegistryError(
      "OVERRIDE_INVALID_RANGE",
      `Invalid override range: ${detail}`,
      { status: 400 },
    );
  }

  static invalidDate(field: string, value: string): DeviceRegistryError {
    return new DeviceRegistryError(
      "INVALID_DATE",
      `Invalid ISO date for ${field}: ${value}`,
      { status: 400 },
    );
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
