// WARP-2480 fixture — `#` opens a PRIVATE CLASS FIELD in TypeScript, not a
// comment. The repo really does start lines that way (for example
// `#src = "";` in apps/web-dashboard/src/__tests__/home/cameras-widget.*),
// so treating `#` as a comment introducer in a .ts/.js file would strip a
// code line — exactly what WARP-2480 says must never happen.
// Expected: one violation, reported on the `#digest` line.
import { createHash } from "node:crypto";

export class Fingerprinter {
  #digest = createHash("md5");

  hex(value: string): string {
    return this.#digest.update(value).digest("hex");
  }
}
