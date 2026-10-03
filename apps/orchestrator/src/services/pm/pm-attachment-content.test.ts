/**
 * WARP-1505 — the attachment content policy, table-driven.
 *
 * Pure functions, so every rule is a row: what is refused, what must agree with
 * what, what is recorded, and the ONE thing that is ever previewable.
 */
import { describe, it, expect } from "vitest";
import {
  SNIFF_BYTES,
  contentDisposition,
  evaluateAttachment,
  isPreviewableType,
  sanitizeAttachmentFileName,
  sniffContent,
} from "./pm-attachment-content.js";

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
const pad = (bytes: number[], to = 64): Buffer => {
  const b = Buffer.alloc(Math.max(to, bytes.length));
  Buffer.from(bytes).copy(b);
  return b;
};

const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const GIF = pad(ascii("GIF89a"));
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(32)]);
const PDF = pad(ascii("%PDF-1.7\n"));
const ZIP = pad([0x50, 0x4b, 0x03, 0x04]);
const GZIP = pad([0x1f, 0x8b, 0x08, 0x00]);
const OLE = pad([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ELF = pad([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]);
const MACHO = pad([0xcf, 0xfa, 0xed, 0xfe]);
const JAVA_CLASS = pad([0xca, 0xfe, 0xba, 0xbe]);
const PE = (() => {
  const b = Buffer.alloc(256);
  b.write("MZ", 0, "latin1");
  b.writeUInt32LE(0x80, 0x3c); // e_lfanew
  b.write("PE\0\0", 0x80, "latin1");
  return b;
})();
const TEXT = Buffer.from("just some plain text, nothing to see\n");

const verdict = (fileName: string, head: Buffer, claimedMime?: string) =>
  evaluateAttachment({ fileName, claimedMime, head });

describe("sanitizeAttachmentFileName", () => {
  it.each([
    ["report.pdf", "report.pdf"],
    ["  spaced name .txt  ", "spaced name .txt"],
    ["café ☕.docx", "café ☕.docx"],
    // path parts go — the name is display metadata, never a path
    ["../../etc/passwd", "passwd"],
    ["..\\..\\windows\\system32\\evil.dll", "evil.dll"],
    ["/abs/path/photo.png", "photo.png"],
    ["C:\\Users\\me\\photo.png", "photo.png"],
    ["a/b/c/", "file"],
    // control characters, including NUL and the C1 range
    ["bad\u0000name.txt", "badname.txt"],
    ["tab\there\nnewline.txt", "tabherenewline.txt"],
    ["c1\u0085\u009fchars.txt", "c1chars.txt"],
    // nothing left of a name
    ["", "file"],
    ["   ", "file"],
    [".", "file"],
    ["..", "file"],
    ["....", "file"],
  ])("%j -> %j", (raw, expected) => {
    expect(sanitizeAttachmentFileName(raw)).toBe(expected);
  });

  it("removes the bidi controls that make `invoice[RLO]gnp.exe` render as `invoiceexe.png`", () => {
    const spoof = "invoice\u202Egnp.exe";
    const clean = sanitizeAttachmentFileName(spoof);
    expect(clean).toBe("invoicegnp.exe");
    expect(clean).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/);
  });

  it("normalises to NFC so one name has one spelling", () => {
    expect(sanitizeAttachmentFileName("cafe\u0301.txt")).toBe("caf\u00e9.txt");
  });

  it("truncates an over-long name but keeps its extension, without splitting a code point", () => {
    const long = `${"a".repeat(400)}.pdf`;
    const out = sanitizeAttachmentFileName(long);
    expect(Array.from(out).length).toBe(255);
    expect(out.endsWith(".pdf")).toBe(true);
    const emoji = `${"😀".repeat(300)}.png`;
    const emojiOut = sanitizeAttachmentFileName(emoji);
    expect(Array.from(emojiOut).length).toBe(255);
    expect(emojiOut.endsWith(".png")).toBe(true);
    expect(emojiOut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/); // no lone surrogate
  });
});

describe("contentDisposition", () => {
  it("quotes a hostile name so it stays ONE parameter", () => {
    const h = contentDisposition("attachment", 'x"; filename=evil.exe; foo="bar.txt');
    expect(h.startsWith("attachment; filename=")).toBe(true);
    // the quote and backslash are gone from the ASCII fallback
    const fallback = /filename="([^"]*)"/.exec(h)![1];
    expect(fallback).not.toMatch(/["\\]/);
    expect(h).toContain("filename*=UTF-8''");
  });

  it("carries the real name in RFC 5987 form, encoding the characters the RFC excludes", () => {
    const h = contentDisposition("attachment", "Café (final) *1* it's.txt");
    expect(h).toContain("filename*=UTF-8''Caf%C3%A9%20%28final%29%20%2A1%2A%20it%27s.txt");
    // the plain fallback is ASCII-only and has no percent sign to be re-decoded
    expect(/filename="([^"]*)"/.exec(h)![1]).toBe("Caf_ (final) *1* it's.txt");
    expect(contentDisposition("attachment", "100%.txt")).toContain('filename="100_.txt"');
  });

  it("supports inline for the one case that uses it", () => {
    expect(contentDisposition("inline", "a.png").startsWith("inline; ")).toBe(true);
  });
});

describe("sniffContent", () => {
  it.each([
    ["png", PNG, "image/png"],
    ["jpeg", JPEG, "image/jpeg"],
    ["gif", GIF, "image/gif"],
    ["webp", WEBP, "image/webp"],
    ["pdf", PDF, "application/pdf"],
    ["zip", ZIP, "application/zip"],
    ["gzip", GZIP, "application/gzip"],
    ["ole", OLE, "application/x-ole-storage"],
  ])("recognises %s", (family, head, mime) => {
    expect(sniffContent(head)).toEqual({ family, mime });
  });

  it.each([
    ["ELF", ELF],
    ["Mach-O", MACHO],
    ["Java class / fat Mach-O", JAVA_CLASS],
    ["PE", PE],
  ])("recognises an executable: %s", (_n, head) => {
    expect(sniffContent(head)?.family).toBe("executable");
  });

  it("does not take a text file for a PE just because it starts with MZ", () => {
    expect(sniffContent(Buffer.from("MZ Industries — quarterly numbers\n".padEnd(128, " ")))).toBeNull();
    expect(sniffContent(Buffer.from("MZ"))).toBeNull();
  });

  it("does not take a text file for a PDF because it quotes the header further in", () => {
    expect(sniffContent(Buffer.from(`log: saw %PDF-1.4 in the stream\n`))).toBeNull();
  });

  it("returns null for plain text and for empty input", () => {
    expect(sniffContent(TEXT)).toBeNull();
    expect(sniffContent(Buffer.alloc(0))).toBeNull();
  });

  it("only ever needs SNIFF_BYTES of head (the tar magic is at 257)", () => {
    expect(SNIFF_BYTES).toBeGreaterThan(262);
    const tar = Buffer.alloc(512);
    tar.write("ustar", 257, "latin1");
    expect(sniffContent(tar)?.family).toBe("tar");
  });
});

describe("evaluateAttachment — refused", () => {
  it.each([
    ["a PE named .txt", "notes.txt", PE],
    ["a PE named .png", "photo.png", PE],
    ["an ELF with no extension", "installer", ELF],
    ["a Mach-O named .pdf", "report.pdf", MACHO],
    ["a Java class named .dat", "thing.dat", JAVA_CLASS],
  ])("by magic bytes: %s", (_n, name, head) => {
    expect(verdict(name, head)).toEqual({ ok: false, reason: "blocked" });
  });

  it.each([
    "setup.exe", "lib.dll", "run.com", "saver.scr", "x.pif", "go.bat", "go.cmd", "a.msi", "a.msp",
    "panel.cpl", "link.lnk", "page.hta", "x.vbs", "x.vbe", "x.wsf", "x.wsh", "tool.jar", "x.reg", "Thing.app",
    "SETUP.EXE", "invoice.pdf.exe",
  ])("by extension: %s (even with harmless bytes)", (name) => {
    expect(verdict(name, TEXT)).toEqual({ ok: false, reason: "blocked" });
  });

  it.each([
    "application/x-msdownload",
    "application/x-dosexec",
    "application/x-msdos-program",
    "application/x-executable",
    "application/java-archive",
    "application/vnd.microsoft.portable-executable",
  ])("by claimed type: %s", (mime) => {
    expect(verdict("innocent.txt", TEXT, mime)).toEqual({ ok: false, reason: "blocked" });
  });

  it.each([
    "run.bat.",
    "run.bat ",
    "run.bat. .",
    "run.bat::$DATA",
    "run.bat:hidden",
    "setup.exe::$data",
    "RUN.BAT.",
    "evil.hta:",
  ])("by extension even when Windows would drop the tail: %j", (name) => {
    expect(verdict(name, TEXT)).toEqual({ ok: false, reason: "blocked" });
  });

  it("leaves an ordinary colon alone (it is not a stream suffix)", () => {
    expect(verdict("Q3: final.pdf", PDF).ok).toBe(true);
    expect(verdict("meeting 10:30.png", PNG).ok).toBe(true);
  });

  it("does NOT treat text scripts as executables — they cannot run from a download", () => {
    for (const name of ["deploy.sh", "backup.ps1", "tool.py", "app.js"]) {
      expect(verdict(name, Buffer.from("#!/bin/sh\necho hi\n")).ok, name).toBe(true);
    }
  });
});

describe("evaluateAttachment — name, claim and bytes must agree", () => {
  it.each([
    ["a .png that is really a PDF", "evil.png", PDF, "image/png"],
    ["a .jpg that is really a PNG", "photo.jpg", PNG, "image/jpeg"],
    ["a .pdf that is really a ZIP", "report.pdf", ZIP, "application/pdf"],
    ["a .png with no signature at all (HTML in disguise)", "evil.png", Buffer.from("<html><script>alert(1)</script></html>"), "image/png"],
    ["a .docx that is not a zip", "memo.docx", TEXT, undefined],
    ["a .txt that is really a PNG", "notes.txt", PNG, "text/plain"],
    ["a .svg that is really a PNG", "diagram.svg", PNG, undefined],
    ["a .csv that is really a PDF", "data.csv", PDF, undefined],
    // the NAME alone must be enough to catch it — no help from the client's claim
    ["a .png that is really a PDF, with no claim at all", "evil.png", PDF, undefined],
    ["a .pdf that is really a ZIP, with a generic claim", "report.pdf", ZIP, "application/octet-stream"],
    ["a .docx that is really a PDF, with no claim", "memo.docx", PDF, undefined],
    ["a claim of image/png over PDF bytes with a neutral name", "scan", PDF, "image/png"],
    ["a claim of text/html over PNG bytes", "scan.png", PNG, "text/html"],
    ["a claim of application/pdf over bytes with no signature", "scan", TEXT, "application/pdf"],
  ])("refuses %s", (_n, name, head, claimed) => {
    expect(verdict(name, head, claimed)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("still catches a legacy Office name over bytes that are plainly something else", () => {
    expect(verdict("old.doc", PNG, "application/msword")).toEqual({ ok: false, reason: "mismatch" });
    expect(verdict("old.xls", PDF, undefined)).toEqual({ ok: false, reason: "mismatch" });
    expect(verdict("old.xls", TEXT, "image/png")).toEqual({ ok: false, reason: "mismatch" });
  });

  it("ignores a generic or absent claim — browsers send octet-stream for what they do not know", () => {
    expect(verdict("photo.png", PNG, "application/octet-stream").ok).toBe(true);
    expect(verdict("photo.png", PNG, undefined).ok).toBe(true);
    expect(verdict("photo.png", PNG, "").ok).toBe(true);
  });

  it("ignores charset and case in the claim", () => {
    expect(verdict("n.txt", TEXT, "Text/Plain; charset=UTF-8").ok).toBe(true);
    expect(verdict("p.png", PNG, "IMAGE/PNG").ok).toBe(true);
  });

  it("does not refuse a claim it cannot judge (a specialised office type over zip bytes)", () => {
    expect(verdict("macros.xlsm", ZIP, "application/vnd.ms-excel.sheet.macroEnabled.12").ok).toBe(true);
  });
});

describe("evaluateAttachment — what is recorded", () => {
  it.each([
    ["photo.png", PNG, "image/png", true],
    ["photo.jpg", JPEG, "image/jpeg", true],
    ["photo.jpeg", JPEG, "image/jpeg", true],
    ["anim.gif", GIF, "image/gif", true],
    ["pic.webp", WEBP, "image/webp", true],
    // no extension, no claim: the bytes decide
    ["screenshot", PNG, "image/png", true],
    ["report.pdf", PDF, "application/pdf", false],
    ["bundle.zip", ZIP, "application/zip", false],
    ["memo.docx", ZIP, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", false],
    ["sheet.xlsx", ZIP, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", false],
    ["legacy.doc", OLE, "application/msword", false],
    ["logs.gz", GZIP, "application/gzip", false],
    ["notes.txt", TEXT, "text/plain", false],
    ["data.csv", TEXT, "text/csv", false],
    ["blob.bin", TEXT, "application/octet-stream", false],
    ["noext", TEXT, "application/octet-stream", false],
    ["song.mp3", Buffer.from("ID3\u0004\u0000"), "audio/mpeg", false],
  ])("%s -> %s (previewable: %s)", (name, head, mimeType, previewable) => {
    expect(verdict(name, head)).toEqual({ ok: true, mimeType, previewable });
  });

  it("accepts the legacy Office names real files wear without the OLE signature (HTML/RTF flavours)", () => {
    const html = Buffer.from("<html><body><table><tr><td>1</td></tr></table></body></html>");
    const rtf = Buffer.from("{\\rtf1\\ansi hello}");
    expect(verdict("export.xls", html, "application/vnd.ms-excel")).toEqual({
      ok: true,
      mimeType: "application/vnd.ms-excel",
      previewable: false,
    });
    expect(verdict("letter.doc", rtf, "application/msword").ok).toBe(true);
    expect(verdict("deck.ppt", rtf, undefined).ok).toBe(true);
  });

  it("accepts a .pdf with junk before the header (the spec allows 1024 bytes) — but only a .pdf", () => {
    const junked = Buffer.concat([Buffer.from("\r\n\r\nHTTP/1.1 200 OK\r\n\r\n"), PDF]);
    expect(verdict("fax.pdf", junked, "application/pdf")).toEqual({ ok: true, mimeType: "application/pdf", previewable: false });
    // a text file that merely quotes the header is a text file
    const quoting = Buffer.from("bug report: the stream began %PDF-1.4 and then stopped\n");
    expect(verdict("notes.txt", quoting, "text/plain")).toEqual({ ok: true, mimeType: "text/plain", previewable: false });
    // ...and a .pdf whose header is past the allowance is not a PDF
    const late = Buffer.concat([Buffer.alloc(2000, 0x20), PDF]);
    expect(verdict("late.pdf", late, "application/pdf")).toEqual({ ok: false, reason: "mismatch" });
  });

  it("records active content as an opaque download, whatever it claims", () => {
    for (const [name, claimed] of [
      ["page.html", "text/html"],
      ["page.htm", "text/html"],
      ["diagram.svg", "image/svg+xml"],
      ["data.xml", "application/xml"],
      ["x.xhtml", "application/xhtml+xml"],
    ] as const) {
      expect(verdict(name, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), claimed), name).toEqual({
        ok: true,
        mimeType: "application/octet-stream",
        previewable: false,
      });
    }
  });

  it("never records the client's claim — a lying claim over honest bytes is recorded as the bytes", () => {
    expect(verdict("photo.png", PNG, "image/png").ok && (verdict("photo.png", PNG, "image/png") as { mimeType: string }).mimeType).toBe("image/png");
    expect(verdict("blob.bin", TEXT, "application/x-something-invented")).toEqual({
      ok: true,
      mimeType: "application/octet-stream",
      previewable: false,
    });
  });

  it("only a SNIFFED raster image is previewable", () => {
    expect(isPreviewableType("image/png")).toBe(true);
    expect(isPreviewableType("image/svg+xml")).toBe(false);
    expect(isPreviewableType("image/bmp")).toBe(false);
    expect(isPreviewableType("application/pdf")).toBe(false);
    expect(isPreviewableType("text/html")).toBe(false);
  });
});
