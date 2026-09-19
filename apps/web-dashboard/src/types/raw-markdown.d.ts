/**
 * WARP-2490 — `?raw` imports return the file's text.
 *
 * vite (vitest) implements this natively; `next.config.js` adds the matching
 * webpack rule (`resourceQuery: /^\?raw$/`, `type: "asset/source"`). This
 * declaration is what lets `tsc` see the same thing both bundlers do — without
 * it the import is an untyped module error, and `vitest` would not have caught
 * that because esbuild strips types.
 */
declare module "*.md?raw" {
  const content: string;
  export default content;
}
