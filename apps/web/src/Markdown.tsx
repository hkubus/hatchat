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
      <button className="code-copy" onClick={copy}>
        {copied ? "copied" : "copy"}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

export default function Markdown({ children }: { children: string }): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { ignoreMissing: true, detect: false }]]}
      components={{
        pre: PreBlock,
        a: ({ node, children: linkChildren, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer noopener">
            {linkChildren}
          </a>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
