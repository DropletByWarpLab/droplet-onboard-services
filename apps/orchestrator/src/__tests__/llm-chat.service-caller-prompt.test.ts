/**
 * WARP-3125 — the two pure helpers behind a service caller's chat turn.
 *
 *   • `isServicePrincipal` decides who gets the per-turn `explicit` tool
 *     selection and the system-message fold. It must match a machine
 *     principal (`_service:*` minted by middleware/auth.ts) and nothing else:
 *     `service` is also a value of the Prisma `Role` enum, so a role-only
 *     check would admit a JWT-backed row that merely carries that role.
 *   • `splitLeadingSystemMessages` takes the caller's own leading system
 *     message(s) off the request so the route can fold them into its single
 *     index-0 system message. The gpt-oss chat template renders only
 *     `messages[0]` as developer instructions and has no branch for a system
 *     message anywhere else, so one left at index 1 is silently dropped.
 *
 * The route-level behaviour is pinned in `llm-chat.voice-cache-stable.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { isServicePrincipal, splitLeadingSystemMessages } from "../routes/llm.js";
import type { ChatMessage } from "../types/index.js";

describe("isServicePrincipal", () => {
  it("matches the service principals middleware/auth.ts mints", () => {
    expect(isServicePrincipal({ id: "_service:voice", role: "service" })).toBe(true);
    expect(isServicePrincipal({ id: "_service:mcp", role: "service" })).toBe(true);
  });

  it("does not match a user row that merely carries the `service` role", () => {
    // `service` is a Prisma Role value. Only the id namespace says the bearer
    // was a service token rather than a session.
    expect(isServicePrincipal({ id: "3f0c9a8e-user", role: "service" })).toBe(false);
  });

  it("does not match people or an unauthenticated request", () => {
    expect(isServicePrincipal({ id: "u1", role: "owner" })).toBe(false);
    expect(isServicePrincipal({ id: "u2", role: "admin" })).toBe(false);
    expect(isServicePrincipal({ id: "_service:voice", role: "owner" })).toBe(false);
    expect(isServicePrincipal(undefined)).toBe(false);
  });
});

describe("splitLeadingSystemMessages", () => {
  const sys = (content: string): ChatMessage => ({ role: "system", content });
  const user = (content: string): ChatMessage => ({ role: "user", content });
  const assistant = (content: string): ChatMessage => ({ role: "assistant", content });

  it("takes voice's one system message and leaves the user turn", () => {
    const out = splitLeadingSystemMessages([sys("persona"), user("is everything working?")]);
    expect(out.preamble).toBe("persona");
    expect(out.rest).toEqual([user("is everything working?")]);
  });

  it("joins a leading run with a blank line, in order", () => {
    const out = splitLeadingSystemMessages([sys("first"), sys("second"), user("hi")]);
    expect(out.preamble).toBe("first\n\nsecond");
    expect(out.rest).toEqual([user("hi")]);
  });

  it("leaves a system message that is not leading where it is", () => {
    // Mid-conversation context keeps its position. Only the caller's
    // preamble is folded.
    const messages = [user("hi"), assistant("hello"), sys("later context"), user("and?")];
    const out = splitLeadingSystemMessages(messages);
    expect(out.preamble).toBe("");
    expect(out.rest).toEqual(messages);
  });

  it("returns an empty preamble and the same messages when there is none", () => {
    const out = splitLeadingSystemMessages([user("hi")]);
    expect(out.preamble).toBe("");
    expect(out.rest).toEqual([user("hi")]);
  });

  it("drops blank system messages instead of folding stray separators", () => {
    const out = splitLeadingSystemMessages([sys("  "), sys(" persona \n"), user("hi")]);
    expect(out.preamble).toBe("persona");
    expect(out.rest).toEqual([user("hi")]);
  });

  it("does not mutate the input", () => {
    const messages = [sys("persona"), user("hi")];
    const snapshot = JSON.stringify(messages);
    splitLeadingSystemMessages(messages);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
});
