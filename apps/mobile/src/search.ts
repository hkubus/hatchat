/**
 * Formatting for chat search results. Pure, so it is tested without React.
 */

export interface SnippetPart {
  text: string;
  /** True for a matched term, which the server wraps in « and ». */
  hit: boolean;
}

/**
 * Split a search snippet into plain and matched runs. Whitespace (including
 * the newlines of a multi-line message) collapses to single spaces, since a
 * snippet is shown as a two-line preview. An unmatched « or » is left as text.
 */
export function snippetParts(snippet: string): SnippetPart[] {
  const text = snippet.replace(/\s+/g, " ").trim();
  const out: SnippetPart[] = [];
  let last = 0;
  for (const match of text.matchAll(/«([^«»]*)»/g)) {
    const start = match.index ?? 0;
    if (start > last) out.push({ text: text.slice(last, start), hit: false });
    if (match[1]) out.push({ text: match[1], hit: true });
    last = start + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}
