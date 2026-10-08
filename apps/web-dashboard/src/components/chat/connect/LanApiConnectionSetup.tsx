"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { providerDescriptor } from "@droplet/shared-types";
import { authFetch, useAuth } from "@/lib/auth";

// This transport uses the shipped legacy endpoint. Its provider key cannot
// use the SQL provisioning wizard or the parameterised LAN connect route.
const PROVIDER = "eaglesoft-api";
const descriptor = providerDescriptor(PROVIDER)!;
const paths = { test: "/api/integrations/eaglesoft/test", connect: "/api/integrations/eaglesoft/connect" } as const;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function routeMapFrom(text: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Paste valid route map JSON from your Eaglesoft server or Patterson SDK."); }
  if (!record(value) || !record(value.authenticate) || !record(value.reads) || !record(value.writes)) {
    throw new Error("The route map needs authenticate, reads, and writes objects from your Eaglesoft API contract.");
  }
  const auth = value.authenticate;
  if (!["controller", "method", "template"].every((key) => typeof auth[key] === "string" && auth[key].trim()) ||
      typeof auth.verb !== "string" || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(auth.verb)) {
    throw new Error("Add the discovered authentication controller, method, HTTP verb, and route template to the route map.");
  }
  return value;
}

/** Patterson API setup: details go straight to the existing REST flow. */
export function LanApiConnectionSetup({ onConnected }: { onConnected?: () => void }) {
  const { user } = useAuth();
  const canManage = user?.role === "owner" || user?.role === "admin";
  const [values, setValues] = useState<Record<string, string>>({});
  const [routeMap, setRouteMap] = useState("");
  const [caCert, setCaCert] = useState("");
  const [busy, setBusy] = useState<"test" | "connect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const active = useRef(true);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; inFlight.current?.abort(); };
  }, []);

  const submit = async (operation: "test" | "connect") => {
    if (!canManage || inFlight.current) return;
    setError(null);
    setStatus(null);
    let apiRouteMap: Record<string, unknown>;
    try {
      const missing = descriptor.credentialFields.find((field) => field.required && !values[field.name]?.trim());
      if (missing) throw new Error(`Enter ${missing.label.toLowerCase()}.`);
      if (values.port && (!Number.isInteger(Number(values.port)) || Number(values.port) < 1 || Number(values.port) > 65535)) {
        throw new Error("Enter an HTTPS port between 1 and 65535, or leave it blank for the default.");
      }
      apiRouteMap = routeMapFrom(routeMap);
      if (caCert.trim() && (!caCert.includes("-----BEGIN CERTIFICATE-----") || !caCert.includes("-----END CERTIFICATE-----"))) {
        throw new Error("Paste the server's CA certificate in PEM format, or leave it blank when its certificate is already trusted.");
      }
    } catch (validationError) {
      setError((validationError as Error).message);
      return;
    }

    const controller = new AbortController();
    inFlight.current = controller;
    setBusy(operation);
    let keepCredentialsForConnect = false;
    try {
      const response = await authFetch(paths[operation], {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({
          provider: PROVIDER, host: values.host.trim(), ...(values.port ? { port: Number(values.port) } : {}),
          apiCredentials: { integrationKey: values.integrationKey, userId: values.userId, password: values.password },
          enableWrites: false, apiRouteMap, ...(caCert.trim() ? { apiCaCert: caCert.trim() } : {}),
        }),
      });
      // The existing API may return HTTP 200 for a blocked connector. Only
      // its explicit connected verdict represents a saved live connection.
      const result: unknown = response.ok ? await response.json() : null;
      if (!active.current) return;
      if (!response.ok) throw new Error("request_failed");
      if (operation === "test") {
        if (!record(result) || result.ok !== true) throw new Error("test_failed");
        keepCredentialsForConnect = true;
        setStatus("Connection test passed. Choose Connect to save this setup.");
      } else if (record(result) && result.provider === PROVIDER && result.status === "CONNECTED") {
        setStatus("Eaglesoft API is connected. Droplet will use the discovered read routes.");
        onConnected?.();
      } else if (record(result) && result.provider === PROVIDER && result.status === "PROVISIONING") {
        setStatus("Setup was saved, but the API is not connected yet. Check the live route map, certificate trust, and server access before retrying.");
      } else {
        throw new Error("connection_not_confirmed");
      }
    } catch {
      if (active.current) setError(operation === "test"
        ? "Droplet could not verify this API connection. Check the credentials, live route map, server access, and certificate trust."
        : "Droplet could not confirm this API connection. Check its setup and try again.");
    } finally {
      inFlight.current = null;
      if (active.current) {
        setBusy(null);
        // Retain credentials only between a passing test and the explicit
        // save in this active form; clear every secret after save or failure.
        if (!keepCredentialsForConnect) setValues((current) => Object.fromEntries(Object.entries(current).filter(([name]) => !descriptor.credentialFields.find((field) => field.name === name)?.secret)));
      }
    }
  };

  if (!canManage) return <p className="type-footnote">Ask your Droplet owner or administrator to connect this system.</p>;

  return <form className="space-y-4" aria-label="Patterson API setup" onSubmit={(event: FormEvent) => { event.preventDefault(); void submit("connect"); }}>
    <p className="type-footnote text-[var(--text-muted)]">Use your Patterson integration key and API user credentials. Your Eaglesoft administrator can provide the server details and discovered API routes.</p>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {descriptor.credentialFields.map((field) => <label key={field.name} className="flex flex-col gap-1.5">
        {field.label}
        <input className="input" type={field.secret ? "password" : field.type === "positiveInteger" ? "number" : "text"}
          required={field.required} disabled={Boolean(busy)} value={values[field.name] ?? ""}
          autoComplete={field.secret ? "new-password" : "off"} {...(field.type === "positiveInteger" ? { min: 1, max: 65535, step: 1 } : {})}
          onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))} />
        {field.help && <span className="type-caption-1 text-[var(--text-muted)]">{field.help}</span>}
      </label>)}
    </div>
    <label className="flex flex-col gap-1.5">Route map JSON
      <textarea className="input" rows={8} required disabled={Boolean(busy)} spellCheck={false} value={routeMap} onChange={(event) => setRouteMap(event.target.value)} />
      <span className="type-caption-1 text-[var(--text-muted)]">Build this map from your server&apos;s live /help page or the Patterson SDK. Include authenticate (controller, method, verb, template), reads, and writes objects. Each read needs its discovered route and response field mappings before it can sync.</span>
    </label>
    <label className="flex flex-col gap-1.5">CA certificate PEM (optional)
      <textarea className="input" rows={4} disabled={Boolean(busy)} spellCheck={false} value={caCert} onChange={(event) => setCaCert(event.target.value)} />
      <span className="type-caption-1 text-[var(--text-muted)]">Supply the server&apos;s CA certificate for a private or self-signed certificate. Leave this blank only when its certificate is already trusted. Droplet keeps HTTPS verification enabled.</span>
    </label>
    {error && <p className="type-footnote text-system-red" role="alert">{error}</p>}
    {status && <p className="type-footnote" role="status">{status}</p>}
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => void submit("test")}>{busy === "test" ? "Testing…" : "Test connection"}</button>
      <button type="submit" className="btn primary" disabled={Boolean(busy)}>{busy === "connect" ? "Connecting…" : "Connect"}</button>
    </div>
  </form>;
}
