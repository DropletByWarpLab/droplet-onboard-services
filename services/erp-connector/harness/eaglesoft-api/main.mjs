#!/usr/bin/env node
/**
 * CLI entrypoint for the dummy Eaglesoft REST API box — what the container
 * runs, and what you run by hand to point a connector, a curl, or the
 * orchestrator at a long-lived fake box.
 *
 * The in-process tests do NOT use this file; they import
 * `startMockEaglesoftApi` directly. Keeping the two paths on the same server
 * module means what CI proves is the same thing you can then run by hand.
 *
 *   node main.mjs                       # HTTPS on :9888, loopback only
 *   MOCK_ES_BIND=0.0.0.0 node main.mjs  # reachable from other containers
 *   MOCK_ES_TLS=0 node main.mjs         # plain HTTP, for eyeballing the wire
 */
import { startMockEaglesoftApi, DEFAULT_PORT } from "./mock-server.mjs";

const port = Number(process.env.MOCK_ES_PORT ?? DEFAULT_PORT);
// Loopback by default: a fake Eaglesoft box that answers on every interface is
// not something to expose by accident.
const hostname = process.env.MOCK_ES_BIND ?? "127.0.0.1";
const tls = process.env.MOCK_ES_TLS !== "0";

const box = await startMockEaglesoftApi({ port, hostname, tls, quiet: false });

// CodeQL js/clear-text-logging (#222): never echo the password, fixture or
// not — this banner is what ends up pasted into tickets and CI logs. Say
// where it comes from instead; the value is DEV_CREDENTIALS in fixture.mjs
// unless MOCK_ES_PASSWORD overrides it.
const passwordSource = process.env.MOCK_ES_PASSWORD
  ? "<redacted: set via MOCK_ES_PASSWORD>"
  : "<redacted: fixture default, see DEV_CREDENTIALS in fixture.mjs>";

console.log(`
  Dummy Eaglesoft API box (SYNTHETIC — not Patterson's real contract)

    URL           ${box.url}
    Discovery     ${box.url}/help          (JSON, or HTML with Accept: text/html)
    Schedule date ${box.anchorDate}        (UTC; the seed is anchored here)
    CA cert       ${box.caCertPath ?? "(TLS disabled)"}
    Credentials   integrationKey=${box.credentials.integrationKey}
                  userId=${box.credentials.userId}
                  password=${passwordSource}

  Fault injection (make the box misbehave):
    curl -sk -X PUT ${box.url}/__control/faults -H 'content-type: application/json' \\
         -d '{"status":500}'
    curl -sk -X DELETE ${box.url}/__control/faults
`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\n[mock-eaglesoft] ${signal} — shutting down`);
    box.close().then(() => process.exit(0));
  });
}
