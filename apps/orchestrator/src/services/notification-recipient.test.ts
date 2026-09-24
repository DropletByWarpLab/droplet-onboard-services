/**
 * WARP-2911 — the refusal's `caller` hint names the code that passed the id.
 *
 * The hint is the whole point of throwing instead of logging: the log line has
 * to say WHERE the `User.id` came from. It is the frame right after the entry
 * point (sendNotification, dispatchToUser, …) — including when that caller
 * lives in the same module as the entry point, as the camera fan-out does
 * (push-dispatch calls dispatchToUser). "The first frame outside the
 * notification modules" skipped such a caller and, after an `await`, landed on
 * `processTicksAndRejections (node:internal/…)`, which names nothing.
 *
 * Here the entry point and its caller share THIS file, which is exactly that
 * shape.
 */
import { describe, it, expect } from "vitest";
import { assertRecipientIsUsername, NotificationRecipientError } from "./notification-recipient.js";

const USER_ID = "3b7d0195-6c1e-4f2a-9d8b-2a4c6e8f0a1b";

/** Stands in for an entry point such as `dispatchToUser`: async, and reached
 *  only after its caller has awaited something. */
async function entryPoint(username: string): Promise<void> {
  assertRecipientIsUsername("entryPoint", username);
}

async function theCodeThatPassedTheId(): Promise<void> {
  await Promise.resolve();
  await entryPoint(USER_ID);
}

describe("WARP-2911 — NotificationRecipientError.caller", () => {
  it("names the function that called the entry point: same module, across an await", async () => {
    const err = await theCodeThatPassedTheId().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotificationRecipientError);
    const { caller, message } = err as NotificationRecipientError;
    expect(caller).toMatch(/theCodeThatPassedTheId/);
    expect(caller).toMatch(/notification-recipient\.test\.ts:\d+:\d+/);
    expect(caller).not.toMatch(/processTicksAndRejections|node:internal/);
    expect(message).toContain(caller!);
  });

  it("a username passes", async () => {
    await expect(entryPoint("dev")).resolves.toBeUndefined();
    await expect(entryPoint("_service:mcp")).resolves.toBeUndefined();
  });
});
