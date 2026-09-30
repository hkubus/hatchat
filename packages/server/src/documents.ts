/**
 * Turning an uploaded document into text the model can read.
 *
 * Images go to vision models as pixels; everything else a user attaches —
 * notes, source files, CSVs, PDFs — is read as text on upload, stored next to
 * the blob, and inlined into the user's message for the model. Extraction runs
 * once, not every turn, and the chat keeps a compact file chip.
 */

export const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** More than this is cut off: it would crowd out the conversation anyway. */
export const MAX_DOCUMENT_CHARS = 400_000;

const TEXT_MIME = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/javascript",
  "application/typescript",
  "application/x-sh",
  "application/x-python",
  "application/sql",
  "application/graphql",
  "application/x-ndjson",
]);

const TEXT_EXTENSIONS = new Set(
  (
    "txt md markdown rst org csv tsv json jsonl ndjson yaml yml toml ini cfg conf env xml html htm css scss " +
    "js mjs cjs jsx ts tsx py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh fish ps1 sql graphql " +
    "lua r scala clj ex exs erl hs ml vue svelte dockerfile makefile gradle properties log diff patch tex bib"
  ).split(" "),
);

export type DocumentResult =
  | { kind: "image"; mime: string }
  | { kind: "document"; mime: string; text: string }
  | { kind: "rejected"; status: 415 | 422; error: string };

function extensionOf(name: string): string {
  const base = name.toLowerCase().split(/[\\/]/).pop() ?? "";
  if (base === "dockerfile" || base === "makefile") return base;
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1);
}

function cap(text: string): string {
  if (text.length <= MAX_DOCUMENT_CHARS) return text;
  return `${text.slice(0, MAX_DOCUMENT_CHARS)}\n…[truncated: the document is ${text.length} characters]`;
}

/** Strict UTF-8 with no NUL bytes; undefined for anything binary. */
function decodeText(data: Uint8Array): string | undefined {
  if (data.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data).replace(/^﻿/, "");
  } catch {
    return undefined;
  }
}

async function pdfText(data: Uint8Array): Promise<string> {
  // Loaded lazily: pdf.js is large and most servers never see a PDF.
  const { extractText, getDocumentProxy } = await import("unpdf");
  // pdf.js refuses a Node Buffer (what the upload route has) and takes over the
  // memory it is given, so it gets a private copy: the caller still stores it.
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(pdf, { mergePages: true });
  return (Array.isArray(text) ? text.join("\n\n") : text).trim();
}

/** Classify an upload and, for documents, extract its text. */
export async function readUpload(data: Uint8Array, mime: string, name: string): Promise<DocumentResult> {
  const type = mime.split(";")[0].trim().toLowerCase();
  if (IMAGE_MIME.has(type)) return { kind: "image", mime: type };
  const ext = extensionOf(name);

  if (type === "application/pdf" || ext === "pdf") {
    let text: string;
    try {
      text = await pdfText(data);
    } catch {
      return { kind: "rejected", status: 422, error: "could not read this PDF" };
    }
    if (!text) {
      return {
        kind: "rejected",
        status: 422,
        error: "this PDF has no extractable text (a scan?); attach page images instead",
      };
    }
    return { kind: "document", mime: "application/pdf", text: cap(text) };
  }

  const looksTextual =
    type.startsWith("text/") ||
    TEXT_MIME.has(type) ||
    type.endsWith("+json") ||
    type.endsWith("+xml") ||
    TEXT_EXTENSIONS.has(ext) ||
    // Browsers send an empty type (or octet-stream) for unknown extensions;
    // the bytes decide.
    type === "" ||
    type === "application/octet-stream";
  if (!looksTextual) {
    return { kind: "rejected", status: 415, error: `unsupported file type ${type || "(unknown)"}` };
  }
  const text = decodeText(data);
  if (text === undefined) {
    return { kind: "rejected", status: 415, error: "binary files are not supported; attach text, code, PDF or images" };
  }
  const normalized = type && type !== "application/octet-stream" ? type : "text/plain";
  return { kind: "document", mime: normalized, text: cap(text) };
}
