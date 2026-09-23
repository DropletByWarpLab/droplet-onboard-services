-- WARP-1157: a list of your passkeys in Settings.
--
--   "name"  — what the owner calls this passkey ("Work laptop"). NULL until
--             they rename it; the dashboard shows "Unnamed passkey".
--   "rpId"  — the Relying Party ID (the host) the passkey was created on.
--             The RP ID comes from the request host (webauthn-config.ts), so a
--             passkey made on droplet-ai.local cannot sign in on the per-device
--             FQDN, and the other way round. Storing it lets the list say where
--             each passkey works. NULL only on rows enrolled before this
--             migration: the host was not recorded then, and the dashboard
--             shows that as "address not recorded" rather than guessing.
ALTER TABLE "WebAuthnCredential" ADD COLUMN "name" TEXT;
ALTER TABLE "WebAuthnCredential" ADD COLUMN "rpId" TEXT;
