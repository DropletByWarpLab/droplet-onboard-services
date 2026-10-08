import { CHAT_CONNECTION_POPUP_KEY, CHAT_CONNECTION_POPUP_TTL } from "@/lib/chat-connection-popup";

/** No account data is rendered. The parent independently verifies server state. */
export function GET() {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const script = `(() => {
    const key = ${JSON.stringify(CHAT_CONNECTION_POPUP_KEY)};
    try {
      const raw = sessionStorage.getItem(key); sessionStorage.removeItem(key);
      const record = raw ? JSON.parse(raw) : null;
      const age = record ? Date.now() - record.startedAt : Infinity;
      if (!record || !['google','m365'].includes(record.provider) || typeof record.nonce !== 'string' || !/^[a-zA-Z0-9-]{32,64}$/.test(record.nonce) || !Number.isFinite(age) || age < 0 || age > ${CHAT_CONNECTION_POPUP_TTL}) return;
      const origin = new URL(record.openerOrigin);
      if (!['http:','https:'].includes(origin.protocol) || origin.origin !== record.openerOrigin) return;
      const outcome = new URL(location.href).searchParams.get(record.provider);
      if (!['connected','cancelled','expired','failed','different_account','invalid'].includes(outcome)) return;
      if (window.opener) window.opener.postMessage({ type:'droplet.connection-return', provider:record.provider, nonce:record.nonce, outcome }, record.openerOrigin);
      window.close();
    } catch {}
  })();`;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Droplet account sign-in</title></head><body><p>Account approval finished. You can close this window and continue in your Droplet chat.</p><script nonce="${nonce}">${script}</script></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'` } });
}
