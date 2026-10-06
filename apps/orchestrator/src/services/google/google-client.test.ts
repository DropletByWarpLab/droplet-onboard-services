import { describe, it, expect, vi } from "vitest";
import { createGoogleProvider, GoogleProviderError, GOOGLE_MAIL_SCOPE } from "./google-client.js";
import { GOOGLE_EMAIL_SCOPE, GOOGLE_CALENDAR_SCOPE } from "./scopes.js";

const app = { clientId: "customer-client", clientSecret: "secret-client" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const mailScopes = [GOOGLE_EMAIL_SCOPE, GOOGLE_MAIL_SCOPE];
const tokenBody = { access_token: "short-lived", refresh_token: "long-lived", token_type: "Bearer", scope: mailScopes.join(" ") };

describe("Google provider transport", () => {
  it("asks for offline mail consent with S256 PKCE on Google's fixed page", () => {
    const provider = createGoogleProvider();
    const url = new URL(provider.getAuthorizationUrl(app, {
      redirectUri: "https://droplet.example.com/api/google/callback", state: "browser-state", codeChallenge: "challenge",
    }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      access_type: "offline", response_type: "code", scope: mailScopes.join(" "),
      prompt: "consent select_account", code_challenge_method: "S256", code_challenge: "challenge", state: "browser-state",
    });
    expect(url.searchParams.has("client_secret")).toBe(false);
  });

  it("exchanges and refreshes only at the token endpoint without following redirects", async () => {
    const fetcher = vi.fn(async () => json(tokenBody));
    const provider = createGoogleProvider(fetcher);
    await expect(provider.exchangeCode(app, { code: "code", codeVerifier: "verifier", redirectUri: "https://droplet.example.com/api/google/callback" }))
      .resolves.toEqual({ accessToken: "short-lived", refreshToken: "long-lived", grantedScopes: mailScopes });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.fromEntries(init.body as URLSearchParams)).toMatchObject({
      grant_type: "authorization_code", client_id: app.clientId, client_secret: app.clientSecret, code_verifier: "verifier",
    });
    await provider.refresh(app, "refresh");
    const refreshBody = (fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body as URLSearchParams;
    expect(refreshBody.get("grant_type")).toBe("refresh_token");
    expect(refreshBody.get("refresh_token")).toBe("refresh");
  });

  it("classifies revoked grants and never includes the provider error body", async () => {
    const provider = createGoogleProvider(vi.fn(async () => json({ error: "invalid_grant", error_description: "REFRESH_TOKEN_SECRET" }, 400)));
    const err = await provider.refresh(app, "refresh").catch((error: unknown) => error);
    expect(err).toBeInstanceOf(GoogleProviderError);
    expect(err).toMatchObject({ needsReconnect: true });
    expect(JSON.stringify(err)).not.toContain("REFRESH_TOKEN_SECRET");
  });

  it("treats provider outages and redirect failures as transient generic errors", async () => {
    for (const fetcher of [vi.fn(async () => json({ error: "server-secret" }, 503)), vi.fn(async () => { throw new Error("token-secret"); })]) {
      const err = await createGoogleProvider(fetcher).refresh(app, "refresh").catch((error: unknown) => error);
      expect(err).toMatchObject({ needsReconnect: false });
      expect(String(err)).not.toMatch(/server-secret|token-secret/);
    }
  });

  it("rejects a token with the wrong mail permission", async () => {
    const provider = createGoogleProvider(vi.fn(async () => json({ ...tokenBody, scope: "openid email" })));
    await expect(provider.refresh(app, "refresh")).rejects.toMatchObject({ needsReconnect: true });
  });

  it("uses Google's verified userinfo identity without requiring Gmail access", async () => {
    const fetcher = vi.fn(async () => json({ email: "Person@Example.com", verified_email: true }));
    const provider = createGoogleProvider(fetcher);
    await expect(provider.getAccountAddress("bearer")).resolves.toBe("person@example.com");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://www.googleapis.com/oauth2/v2/userinfo");
    expect(init.headers).toEqual({ Authorization: "Bearer bearer" });
    await expect(createGoogleProvider(vi.fn(async () => json({ email: "bad\r\naddress", verified_email: true }))).getAccountAddress("bearer"))
      .rejects.toBeInstanceOf(GoogleProviderError);
    await expect(createGoogleProvider(vi.fn(async () => json({ email: "unverified@example.com", verified_email: false }))).getAccountAddress("bearer"))
      .rejects.toBeInstanceOf(GoogleProviderError);
  });

  it("calendar-only consent asks for email identity and read-only events, and validates the actual returned grant", async () => {
    const calendarScopes = [GOOGLE_EMAIL_SCOPE, GOOGLE_CALENDAR_SCOPE];
    const provider = createGoogleProvider(vi.fn(async () => json({ ...tokenBody, scope: calendarScopes.join(" ") })));
    const opts = { redirectUri: "https://box.customer.com/api/google/callback", state: "state", codeChallenge: "challenge", scopes: calendarScopes };
    const url = new URL(provider.getAuthorizationUrl(app, opts));
    expect(url.searchParams.get("scope")).toBe(calendarScopes.join(" "));
    expect(url.searchParams.get("scope")).not.toContain(GOOGLE_MAIL_SCOPE);
    await expect(provider.exchangeCode(app, { code: "code", codeVerifier: "verifier", redirectUri: opts.redirectUri, scopes: calendarScopes }))
      .resolves.toMatchObject({ grantedScopes: calendarScopes });
    const missing = createGoogleProvider(vi.fn(async () => json({ ...tokenBody, scope: GOOGLE_EMAIL_SCOPE })));
    await expect(missing.exchangeCode(app, { code: "code", codeVerifier: "verifier", redirectUri: opts.redirectUri, scopes: calendarScopes }))
      .rejects.toMatchObject({ needsReconnect: true });
  });

  it("only refresh may omit unchanged scopes and email scope aliases remain equivalent", async () => {
    const provider = createGoogleProvider(vi.fn(async () => json({ ...tokenBody, scope: undefined })));
    await expect(provider.refresh(app, "refresh")).resolves.toMatchObject({ grantedScopes: mailScopes });
    await expect(provider.exchangeCode(app, { code: "code", codeVerifier: "verifier", redirectUri: "https://box.customer.com/api/google/callback" }))
      .rejects.toMatchObject({ needsReconnect: true });
    await expect(createGoogleProvider(vi.fn(async () => json({ ...tokenBody, scope: `email ${GOOGLE_MAIL_SCOPE}` }))).refresh(app, "refresh"))
      .resolves.toMatchObject({ grantedScopes: mailScopes });
  });

  it("revokes only via Google's fixed endpoint and accepts an already revoked token", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 400 }));
    await createGoogleProvider(fetcher).revoke("refresh");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect((init.body as URLSearchParams).get("token")).toBe("refresh");
    expect(init.redirect).toBe("error");
  });
});
