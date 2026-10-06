import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

// A new browser-painted picker must not quietly bypass the app's shared UI.
it("routes every single-choice field through the themed select primitive", () => {
  const root = resolve(__dirname, "..");
  const native: string[] = [];
  function scan(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") scan(path);
      } else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) {
        const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        function visit(node: ts.Node) {
          if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === "select") {
            native.push(relative(root, path).replaceAll("\\", "/"));
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
  }
  scan(root);
  expect(native).toEqual(["components/ui/ThemedSelect.tsx"]);
});
