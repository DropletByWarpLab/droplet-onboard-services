/**
 * WARP-837 — Email deep-link route.
 *
 * Optional catch-all so both `/email/:account` and `/email/:account/:thread`
 * resolve to the same workspace with the right initial selection. The first
 * catch-all segment is the thread id; anything deeper is ignored (the surface is
 * two levels: account → thread).
 *
 * Thin by design — all behaviour lives in EmailWorkspace, shared with /email.
 */

import { EmailWorkspace } from "@/components/email/EmailWorkspace";

export default function EmailDeepLinkPage({
  params,
}: {
  params: { account: string; thread?: string[] };
}) {
  const initialThreadId = params.thread?.[0];
  return (
    <EmailWorkspace
      initialAccountId={params.account}
      initialThreadId={initialThreadId}
    />
  );
}
