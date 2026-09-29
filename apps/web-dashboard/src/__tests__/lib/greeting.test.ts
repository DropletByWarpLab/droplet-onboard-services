/**
 * WARP-3043 — one greeting for every surface that greets.
 *
 * The Home board, the Home "Ask AI" tile and the workspace shell each carried
 * their own copy of the same buckets, and /chat is about to greet too. One
 * function means the bento and the chat can never disagree about the hour.
 */
import { describe, it, expect } from "vitest";
import { greetingLine, greetingNow } from "@/lib/greeting";

const at = (h: number, m: number) => new Date(2026, 8, 25, h, m, 0);

describe("greetingNow", () => {
  it.each([
    [4, 59, "Still up"],
    [5, 0, "Good morning"],
    [11, 59, "Good morning"],
    [12, 0, "Good afternoon"],
    [17, 59, "Good afternoon"],
    [18, 0, "Good evening"],
    [21, 59, "Good evening"],
    [22, 0, "Working late"],
  ])("%i:%i is %s", (h, m, expected) => {
    expect(greetingNow(at(h, m))).toBe(expected);
  });

  it("defaults to the current time", () => {
    expect(greetingNow()).toBe(greetingNow(new Date()));
  });
});

describe("greetingLine", () => {
  it("uses the first name of a full name", () => {
    expect(greetingLine("Alex Rivera", at(9, 0))).toBe("Good morning, Alex.");
  });

  it("uses a single name as it is", () => {
    expect(greetingLine("alex", at(13, 0))).toBe("Good afternoon, alex.");
  });

  it("drops the name when there is none", () => {
    expect(greetingLine(null, at(23, 0))).toBe("Working late.");
    expect(greetingLine("", at(19, 0))).toBe("Good evening.");
  });
});
