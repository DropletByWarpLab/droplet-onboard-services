import { describe, it, expect } from "vitest";
import { toastForError, TOAST_COPY } from "./toastForError";

describe("toastForError", () => {
  it("maps a known typed-error code to its friendly copy", () => {
    expect(toastForError({ code: "INVALID_MAC" })).toBe(
      "Device address is invalid",
    );
    expect(toastForError({ code: "DUPLICATE_GROUP_NAME" })).toBe(
      "A group with that name already exists",
    );
    expect(toastForError({ code: "SCHEDULE_NOT_FOUND" })).toBe(
      "Schedule no longer exists",
    );
    expect(toastForError({ code: "OVERRIDE_INVALID_RANGE" })).toBe(
      "End time must be after start time",
    );
  });

  it("preserves the REQUIRES_CONFIRMATION copy the block flow asserts on", () => {
    expect(toastForError({ code: "REQUIRES_CONFIRMATION" })).toBe(
      "This action requires confirmation — not wired yet",
    );
  });

  it("covers every key the ticket enumerates", () => {
    const required = [
      "INVALID_ICON",
      "INVALID_MAC",
      "NOT_FOUND",
      "DUPLICATE_GROUP_NAME",
      "GROUP_IN_USE",
      "REQUIRES_CONFIRMATION",
      "SCHEDULE_NOT_FOUND",
      "SCHEDULE_INVALID_WINDOW",
      "SCHEDULE_SUBJECT_MISMATCH",
      "OVERRIDE_NOT_FOUND",
      "OVERRIDE_INVALID_RANGE",
      "INVALID_DATE",
    ];
    for (const code of required) {
      expect(typeof TOAST_COPY[code]).toBe("string");
      expect(toastForError({ code })).toBe(TOAST_COPY[code]);
    }
  });

  it("falls back to the default message for an unknown code", () => {
    expect(toastForError({ code: "TOTALLY_UNKNOWN" })).toBe(
      "Something went wrong",
    );
  });

  it("honours a caller-supplied fallback", () => {
    expect(toastForError({ code: "TOTALLY_UNKNOWN" }, "Custom fallback")).toBe(
      "Custom fallback",
    );
    expect(toastForError(new Error("boom"), "Custom fallback")).toBe(
      "Custom fallback",
    );
  });

  it("falls back when the error has no string code", () => {
    expect(toastForError(null)).toBe("Something went wrong");
    expect(toastForError(undefined)).toBe("Something went wrong");
    expect(toastForError("plain string")).toBe("Something went wrong");
    expect(toastForError({ code: 42 })).toBe("Something went wrong");
    expect(toastForError({})).toBe("Something went wrong");
  });
});
