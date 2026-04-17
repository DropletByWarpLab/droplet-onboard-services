/**
 * WARP-80: tests for DeviceRegistryError — the typed error class backing
 * every failure mode in the device-registry surface (groups, devices, MAC
 * normalization). Mirrors the shape established by RouterError so error
 * handlers downstream can treat both uniformly via `err instanceof` checks
 * and branch on `err.code`.
 */

import { describe, it, expect } from "vitest";
import { DeviceRegistryError } from "./device-registry-error.js";

describe("DeviceRegistryError", () => {
  it("is an Error subclass with a stable name", () => {
    const err = DeviceRegistryError.notFound("Device");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DeviceRegistryError);
    expect(err.name).toBe("DeviceRegistryError");
  });

  describe("notFound", () => {
    it("produces code NOT_FOUND, status 404, and a JSON envelope with code/message/status", () => {
      const err = DeviceRegistryError.notFound("Device");
      expect(err.code).toBe("NOT_FOUND");
      expect(err.status).toBe(404);
      expect(err.message).toContain("Device");
      expect(err.toJSON()).toEqual({
        code: "NOT_FOUND",
        message: err.message,
        status: 404,
      });
    });
  });

  describe("invalidMac", () => {
    it("produces code INVALID_MAC, status 400, and includes the raw input in the message", () => {
      const err = DeviceRegistryError.invalidMac("zz");
      expect(err.code).toBe("INVALID_MAC");
      expect(err.status).toBe(400);
      expect(err.message).toContain("zz");
    });
  });

  describe("invalidIcon", () => {
    it("produces code INVALID_ICON, status 400, and includes the icon in the message", () => {
      const err = DeviceRegistryError.invalidIcon("skull");
      expect(err.code).toBe("INVALID_ICON");
      expect(err.status).toBe(400);
      expect(err.message).toContain("skull");
    });
  });

  describe("duplicateGroupName", () => {
    it("produces code DUPLICATE_GROUP_NAME and status 409", () => {
      const err = DeviceRegistryError.duplicateGroupName("Living Room");
      expect(err.code).toBe("DUPLICATE_GROUP_NAME");
      expect(err.status).toBe(409);
      expect(err.message).toContain("Living Room");
    });
  });

  describe("groupInUse", () => {
    it("produces code GROUP_IN_USE and status 409", () => {
      const err = DeviceRegistryError.groupInUse("grp_abc");
      expect(err.code).toBe("GROUP_IN_USE");
      expect(err.status).toBe(409);
      expect(err.message).toContain("grp_abc");
    });
  });

  it("toJSON omits status when unset", () => {
    const e = new DeviceRegistryError("NOT_FOUND", "missing");
    const json = e.toJSON();
    expect(json).toEqual({ code: "NOT_FOUND", message: "missing" });
    expect("status" in json).toBe(false);
  });
});
