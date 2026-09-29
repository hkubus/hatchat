import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import "highlight.js/styles/github-dark.css";

function textContent(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (typeof node === "object" && "props" in node) {
    return textContent((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

function PreBlock({ children }: { children?: ReactNode }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const source = textContent(children);

  function copy(): void {
    void navigator.clipboard?.writeText(source);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="code-block">
      <button type="button" className="code-copy" onClick={copy} aria-label="Copy code to clipboard">
        <span aria-hidden="true">{copied ? "copied" : "copy"}</span>
        <span className="sr-only" role="status">{copied ? "Copied" : ""}</span>
      </button>
      <pre>{children}</pre>
    </div>
  );
}

/** Allow only safe URLs in model/tool output: http(s) + anchor + image data. */
function safeUrl(url: string | undefined): string {
  if (!url) return "";
  const trimmed = url.trim();
  if (trimmed.startsWith("#")) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(trimmed)) return trimmed;
  if (/^(mailto|tel):/i.test(trimmed)) return trimmed;
  return "";
}

export default function Markdown({ children }: { children: string }): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { ignoreMissing: true, detect: false }]]}
      urlTransform={safeUrl}
      components={{
        pre: PreBlock,
        a: ({ node, children: linkChildren, href, ...props }) => {
          const safe = safeUrl(typeof href === "string" ? href : undefined);
          if (!safe) return <span>{linkChildren}</span>;
          return (
            <a {...props} href={safe} target="_blank" rel="noreferrer noopener">
              {linkChildren}
            </a>
          );
        },
        img: ({ node, src, alt, ...props }) => {
          const safe = safeUrl(typeof src === "string" ? src : undefined);
          if (!safe) return null;
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          return <img {...props} src={safe} alt={alt ?? "image"} loading="lazy" referrerPolicy="no-referrer" />;
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
