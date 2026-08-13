/**
 * WARP-1907 — `routerSetPortEnabled()`, the dashboard's transport for the
 * router-jack write.
 *
 * 🔴 This file exists because a mutant survived: deleting the branch that mints
 * `RouterPortRefusedError` left 145 tests green. Nothing reached this function —
 * the panel tests mock the hook, and the hook test mocks `@/lib/api`. The two
 * layers above it were each testing the other's stub.
 *
 * What it pins:
 *   - the URL, method and body (including `force`, which is the only thing
 *     between a click and cutting the household's internet);
 *   - a 202 `requiresConfirmation` is a SUCCESS, not an error — the whole
 *     Tier-2 flow depends on it being returned rather than thrown;
 *   - a 409 guard refusal becomes the typed error the panel escalates from,
 *     with the guard carried verbatim;
 *   - a refusal the client can't recognise still throws something
 *     `translateError` can read (message + code + status), not a bare Error.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { routerSetPortEnabled, RouterPortRefusedError } from "./api";
import { authFetch } from "./auth";

vi.mock("./auth", () => ({ authFetch: vi.fn() }));

const authFetchMock = vi.mocked(authFetch);

function res(init: { ok: boolean; status: number; json: unknown }): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: vi.fn().mockResolvedValue(init.json),
  } as unknown as Response;
}

beforeEach(() => {
  authFetchMock.mockReset();
});

describe("the request", () => {
  it("POSTs enabled + force to the per-port path", async () => {
    authFetchMock.mockResolvedValue(res({ ok: true, status: 200, json: { status: "ok" } }));
    await routerSetPortEnabled("p5", false, true);

    const [url, init] = authFetchMock.mock.calls[0];
    expect(url).toContain("/api/network/ports/p5/enable");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ enabled: false, force: true });
  });

  it("defaults force to false", async () => {
    authFetchMock.mockResolvedValue(res({ ok: true, status: 200, json: {} }));
    await routerSetPortEnabled("p5", false);
    expect(JSON.parse(authFetchMock.mock.calls[0][1]?.body as string)).toEqual({
      enabled: false,
      force: false,
    });
  });

  it("percent-encodes the port so it cannot escape the path", async () => {
    authFetchMock.mockResolvedValue(res({ ok: true, status: 200, json: {} }));
    await routerSetPortEnabled("br-lan.30", true);
    expect(authFetchMock.mock.calls[0][0]).toContain("/api/network/ports/br-lan.30/enable");
  });
});

describe("the response", () => {
  it("returns a 202 confirmation payload rather than throwing on it", async () => {
    /* The 202 is the Tier-2 mint. Treating a non-OK status as a failure here
       would break every write before it ever reached the confirm endpoint. */
    const body = {
      status: "confirmation_required",
      requiresConfirmation: true,
      confirmationToken: "tok",
      operation: "router_port_disable",
    };
    authFetchMock.mockResolvedValue(res({ ok: false, status: 202, json: body }));
    await expect(routerSetPortEnabled("p5", false)).resolves.toMatchObject(body);
  });

  it("turns a 409 guard refusal into the typed error the panel escalates from", async () => {
    authFetchMock.mockResolvedValue(
      res({
        ok: false,
        status: 409,
        json: {
          code: "PORT_WRITE_REFUSED",
          message: "This is the jack your internet comes in on.",
          detail: {
            code: "WAN_PORT",
            reason: "This is the jack your internet comes in on.",
          },
        },
      }),
    );
    const err = await routerSetPortEnabled("p1", false).catch((e) => e);
    expect(err).toBeInstanceOf(RouterPortRefusedError);
    expect(err.guard).toEqual({
      code: "WAN_PORT",
      reason: "This is the jack your internet comes in on.",
    });
    expect(err.message).toBe("This is the jack your internet comes in on.");
  });

  it("keeps the MANAGEMENT code distinct", async () => {
    authFetchMock.mockResolvedValue(
      res({
        ok: false,
        status: 409,
        json: {
          code: "PORT_WRITE_REFUSED",
          detail: { code: "MANAGEMENT_PORT", reason: "your own connection" },
        },
      }),
    );
    const err = await routerSetPortEnabled("p2", false).catch((e) => e);
    expect(err.guard.code).toBe("MANAGEMENT_PORT");
  });

  it("does not fabricate a guard from a detail it cannot read", async () => {
    /* An escalation dialog built on a guess is worse than an honest error. */
    authFetchMock.mockResolvedValue(
      res({
        ok: false,
        status: 409,
        json: { code: "PORT_WRITE_REFUSED", detail: { code: "NOPE", reason: "x" } },
      }),
    );
    const err = await routerSetPortEnabled("p2", false).catch((e) => e);
    expect(err).not.toBeInstanceOf(RouterPortRefusedError);
  });

  it("does not treat a non-refusal 409 as a guard", async () => {
    authFetchMock.mockResolvedValue(
      res({ ok: false, status: 409, json: { code: "SOMETHING_ELSE", message: "nope" } }),
    );
    const err = await routerSetPortEnabled("p2", false).catch((e) => e);
    expect(err).not.toBeInstanceOf(RouterPortRefusedError);
    expect(err.code).toBe("SOMETHING_ELSE");
  });

  it("throws something translateError can read — message, code and status", async () => {
    authFetchMock.mockResolvedValue(
      res({
        ok: false,
        status: 502,
        json: {
          code: "PORT_WRITE_NOT_APPLIED",
          message: "The router accepted the change but the port didn't move.",
        },
      }),
    );
    const err = await routerSetPortEnabled("p5", false).catch((e) => e);
    expect(err.message).toBe("The router accepted the change but the port didn't move.");
    expect(err.code).toBe("PORT_WRITE_NOT_APPLIED");
    expect(err.status).toBe(502);
  });
});
