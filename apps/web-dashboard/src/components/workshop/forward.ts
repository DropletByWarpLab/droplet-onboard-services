/**
 * WARP-2974 — where `/workshop/<id>` sends a person. A route file may export
 * only what Next.js expects of a page, so the pure half lives here.
 */
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `/workshop?workspace=<id>` for a well-formed id; the bare Workshop otherwise. */
export function forwardTarget(raw: unknown): string {
  const id = typeof raw === "string" && ID.test(raw) ? raw : null;
  return id ? `/workshop?workspace=${encodeURIComponent(id)}` : "/workshop";
}
