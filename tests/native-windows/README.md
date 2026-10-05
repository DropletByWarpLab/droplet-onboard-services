# Native Windows orchestrator smoke test

This explicit opt-in test runs the `Droplet.OrchestratorSmoke` console from the native Windows checkout against real Express handlers, real authentication middleware and signed JWTs over local HTTPS. It generates a short-lived localhost certificate and supplies its SHA-256 SPKI pin to the client. No real box, credentials, PostgreSQL, Redis, Nextcloud or device bridge is used.

Build `tests/Droplet.OrchestratorSmoke/Droplet.OrchestratorSmoke.csproj` in the Windows checkout, then in this repository (after `npm ci` and `npm run bootstrap`):

```powershell
$env:DROPLET_WINDOWS_SMOKE_DLL = 'C:/path/to/windows/tests/Droplet.OrchestratorSmoke/bin/x64/Release/net10.0/Droplet.OrchestratorSmoke.dll'
$env:DOTNET_EXE = 'C:/Program Files/dotnet/dotnet.exe' # optional; defaults to dotnet on PATH
npm run -w @droplet/orchestrator test:native-windows
```

The server fixture supplies the synthetic owner `alice@warp.test` / `hunter22hunter22`, department `22222222-2222-4222-8222-222222222222`, and pairing code `ABC234`. It tests native login, refresh-token rotation, `/auth/me`, Home, public health (including a real 503/down snapshot), storage, module/capability probes, department reads and choice writes, device pairing, and a Unicode file download through the production streaming client. Real aggregation and department services run against in-memory persistence. External services and the Redis session store are isolated test doubles.

The client deliberately corrupts the synthetic access-token signature: real authentication rejects `/auth/me` with 401, then the production client refreshes, persists the rotated pair, and replays the request successfully. The test checks exactly one rotation, the original session record, and the real refresh-token denylist/index.

It also checks request metadata: no browser marker, forwarded-host or cookie headers, anonymous health/login/refresh, valid Bearer JWTs on subsequent signed calls, and no cookies issued by native authentication. The client must report `NATIVE_ORCHESTRATOR_SMOKE_OK`. An absent or invalid DLL path fails with an explicit setup error. The default orchestrator tests do not collect this test.
