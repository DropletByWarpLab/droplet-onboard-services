/**
 * WARP-3515 — print the one-time recovery key.
 *
 * Droplet shows a drive's recovery key once, so a paper copy is the most
 * dependable way for an owner to keep it. The page is built in a throwaway
 * iframe — the dialog's own chrome (scrim, buttons, theme) never prints, and
 * the printed page is plain black-on-white regardless of light/dark mode — out
 * of DOM text nodes rather than an HTML string, so a drive name the owner typed
 * ("<img onerror=…>") prints as inert text.
 *
 * The iframe is removed as soon as the print dialog closes (`afterprint`), with
 * a safety timeout for browsers that never fire it: the key must not linger in
 * the document any longer than the owner needs it.
 */

export interface PrintRecoveryKeyInput {
  /** Customer-facing drive name (never a device path). */
  driveName: string;
  recoveryKey: string;
}

export interface PrintRecoveryKeyOptions {
  /** Test seam: how the iframe's window is printed. Defaults to focusing it and
   *  calling `print()` — some browsers print the PARENT page unless the iframe's
   *  own window has focus first. */
  print?: (frameWindow: Window) => void;
  /** Test seam: the date stamped on the page. */
  now?: () => Date;
}

/** Longest the iframe may outlive the print call if `afterprint` never fires. */
const CLEANUP_AFTER_MS = 60_000;

function el(
  doc: Document,
  tag: string,
  text: string,
  style?: Partial<CSSStyleDeclaration>,
): HTMLElement {
  const node = doc.createElement(tag);
  node.textContent = text;
  if (style) Object.assign(node.style, style);
  return node;
}

/** @returns true when the print dialog was opened; false (with nothing left in
 *  the document) when it could not be. */
export function printRecoveryKey(
  { driveName, recoveryKey }: PrintRecoveryKeyInput,
  {
    print = (w) => {
      w.focus();
      w.print();
    },
    now = () => new Date(),
  }: PrintRecoveryKeyOptions = {},
): boolean {
  if (typeof document === "undefined") return false;

  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  Object.assign(frame.style, {
    position: "fixed",
    width: "0",
    height: "0",
    border: "0",
    visibility: "hidden",
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    frame.remove();
  };

  document.body.appendChild(frame);
  const win = frame.contentWindow;
  const doc = frame.contentDocument;
  if (!win || !doc) {
    cleanup();
    return false;
  }

  try {
    doc.title = "Droplet recovery key";
    const body = doc.body;
    Object.assign(body.style, {
      fontFamily: "system-ui, sans-serif",
      margin: "32px",
      lineHeight: "1.5",
    });
    body.append(
      el(doc, "h1", "Droplet recovery key", { fontSize: "22px", margin: "0 0 4px" }),
      el(doc, "p", `Drive: ${driveName}`, { margin: "0 0 20px" }),
      el(doc, "pre", recoveryKey, {
        fontFamily: "ui-monospace, Menlo, Consolas, monospace",
        fontSize: "18px",
        letterSpacing: "0.04em",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        padding: "16px",
        border: "2px solid currentColor",
        margin: "0 0 20px",
      }),
      el(
        doc,
        "p",
        "Keep this page somewhere safe and private, away from this Droplet. Anyone with this key can unlock the drive. Droplet can't show it again.",
        { margin: "0 0 8px" },
      ),
      el(doc, "p", `Printed ${now().toLocaleDateString()}`, { margin: "0", fontSize: "13px" }),
    );

    win.addEventListener("afterprint", cleanup);
    window.setTimeout(cleanup, CLEANUP_AFTER_MS);
    print(win);
    return true;
  } catch {
    cleanup();
    return false;
  }
}
