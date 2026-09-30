import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_DOCUMENT_CHARS, readUpload } from "./documents.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

test("images pass through untouched", async () => {
  assert.deepEqual(await readUpload(bytes("x"), "image/png", "a.png"), { kind: "image", mime: "image/png" });
});

test("text, code and extension-only uploads are read as text", async () => {
  const md = await readUpload(bytes("# Title"), "text/markdown", "a.md");
  assert.deepEqual(md, { kind: "document", mime: "text/markdown", text: "# Title" });
  const code = await readUpload(bytes("print(1)"), "", "main.py");
  assert.equal(code.kind, "document");
  assert.equal((code as { mime: string }).mime, "text/plain");
  const json = await readUpload(bytes('{"a":1}'), "application/json", "x.json");
  assert.equal(json.kind, "document");
});

test("a BOM is dropped and huge documents are capped", async () => {
  const bom = await readUpload(bytes("﻿hello"), "text/plain", "a.txt");
  assert.equal((bom as { text: string }).text, "hello");
  const huge = await readUpload(bytes("a".repeat(MAX_DOCUMENT_CHARS + 10)), "text/plain", "a.txt");
  assert.match((huge as { text: string }).text, /truncated/);
});

test("binary data is rejected", async () => {
  const result = await readUpload(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]), "application/octet-stream", "a.bin");
  assert.equal(result.kind, "rejected");
  const zip = await readUpload(new Uint8Array([1, 2]), "application/zip", "a.zip");
  assert.equal(zip.kind, "rejected");
  assert.equal((zip as { status: number }).status, 415);
});

test("text is extracted from a PDF", async () => {
  const pdf = minimalPdf("Hello PDF");
  const result = await readUpload(pdf, "application/pdf", "doc.pdf");
  assert.equal(result.kind, "document", JSON.stringify(result));
  assert.match((result as { text: string }).text, /Hello PDF/);
});

test("a PDF uploaded as a Buffer is read, and the Buffer is left intact", async () => {
  // The upload route hands over a Node Buffer, which pdf.js rejects outright.
  const upload = Buffer.from(minimalPdf("Hello Buffer"));
  const size = upload.length;
  const result = await readUpload(upload, "application/pdf", "doc.pdf");
  assert.equal(result.kind, "document", JSON.stringify(result));
  assert.match((result as { text: string }).text, /Hello Buffer/);
  // The same bytes are stored afterwards, so extraction must not consume them.
  assert.equal(upload.length, size);
  assert.equal(upload.subarray(0, 5).toString("latin1"), "%PDF-");
});

test("a corrupt PDF is rejected cleanly", async () => {
  const result = await readUpload(bytes("%PDF-1.4 garbage"), "application/pdf", "bad.pdf");
  assert.equal(result.kind, "rejected");
});

/** A one-page PDF with a single line of Helvetica text, xref offsets computed. */
function minimalPdf(text: string): Uint8Array {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
