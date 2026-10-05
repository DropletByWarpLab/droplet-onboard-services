/**
 * WARP-3506 — the ONE definition of a camera's Frigate key.
 *
 * A camera used to have two identities: the name the operator typed (stored
 * verbatim as `Camera.name`) and the key Frigate files it under (`addCamera`
 * lower-cased it and replaced everything outside [a-z0-9_]). Every DB↔Frigate
 * join (reconcile prune, `getCameras`, per-camera routes) assumed the two were
 * equal, so a name with an upper-case letter or a hyphen was written to
 * Frigate as one string and pruned as an "orphan" under the other.
 *
 * Now there is one: `Camera.name` IS the Frigate key, always the output of
 * this function, and what the operator typed lives in `displayName`. Every
 * place that writes a camera into, or reads one out of, Frigate's config
 * (add, delete, sync, settings, accept, the discovery merge) goes through it.
 *
 * Mirrors `frigate_client.py::add_camera` in camera-discovery, which applies
 * the same rule to the names it derives — the two writers must agree.
 */

/** `Front-Door` → `front_door`; `Warp_Lab_Office` → `warp_lab_office`. */
export function toFrigateKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** True when `name` is non-empty and already its own Frigate key. */
export function isFrigateKey(name: string): boolean {
  return name !== "" && toFrigateKey(name) === name;
}

/**
 * The household-facing label for a name: underscores become spaces and each
 * word is capitalised (`front_door` → `Front Door`). Applied to what the
 * operator TYPED, so a hyphen or an upper-case letter they chose survives in
 * the label (`Front-Door` stays `Front-Door`) even though the key does not.
 */
export function toDisplayName(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
