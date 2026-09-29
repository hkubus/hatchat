import type { Part } from "@hat/core";
import { useState } from "react";
import * as api from "./api";
import MessageImage from "./MessageImage";

type FilePart = Extract<Part, { type: "file" }>;

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** The checklist carried by a `todo_write` call, or null if the args are malformed. */
export function todosOf(args: unknown): TodoItem[] | null {
  const todos = (args as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(todos)) return null;
  return todos.filter(
    (t): t is TodoItem =>
      Boolean(t) && typeof t.content === "string" && ["pending", "in_progress", "completed"].includes(t.status),
  );
}

export interface Question {
  question: string;
  options: string[];
  multiSelect: boolean;
}

export function questionOf(args: unknown): Question | null {
  const raw = args as { question?: unknown; options?: unknown; multi_select?: unknown } | null;
  if (!raw || typeof raw.question !== "string") return null;
  return {
    question: raw.question,
    options: Array.isArray(raw.options) ? raw.options.filter((o): o is string => typeof o === "string") : [],
    multiSelect: raw.multi_select === true,
  };
}

/** Argument fields that best identify a call of each built-in tool. */
const BRIEF_FIELDS: Record<string, string> = {
  read_file: "path",
  write_file: "path",
  edit_file: "path",
  list_dir: "path",
  grep: "pattern",
  glob: "pattern",
  web_fetch: "url",
  python: "code",
  process_start: "command",
  process_output: "id",
  process_kill: "id",
  create_artifact: "name",
  memory_save: "text",
  memory_update: "text",
  search_chats: "query",
  ask_user: "question",
  spawn_subagent: "task",
  schedule_create: "title",
};

/** A one-line summary taken from a tool's arguments, when the tool has one. */
export function argBrief(name: string, args: unknown): string | undefined {
  const field = BRIEF_FIELDS[name];
  const value = field ? (args as Record<string, unknown> | null)?.[field] : undefined;
  if (typeof value !== "string") return undefined;
  return value.split("\n").find((line) => line.trim())?.trim();
}

export function TodoList({ todos }: { todos: TodoItem[] }): JSX.Element {
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div className="todo" role="group" aria-label={`Checklist, ${done} of ${todos.length} done`}>
      <div className="todo-head">
        Checklist · {done}/{todos.length}
      </div>
      <ul>
        {todos.map((todo, index) => (
          <li key={index} className={`todo-item ${todo.status}`}>
            <span className="todo-box" aria-hidden="true">
              {todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "•" : ""}
            </span>
            <span className="todo-text">{todo.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A question the assistant is blocked on. Options are buttons (checkboxes for
 * multi-select); a free-text answer is always possible.
 */
export function QuestionCard({
  question,
  onAnswer,
}: {
  question: Question;
  onAnswer: (answer: string) => Promise<void>;
}): JSX.Element {
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(answer: string): Promise<void> {
    if (!answer.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAnswer(answer.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const toggle = (option: string): void =>
    setPicked((prev) => (prev.includes(option) ? prev.filter((o) => o !== option) : [...prev, option]));

  return (
    <div className="question" role="group" aria-label="Question from the assistant">
      <p className="question-text">{question.question}</p>
      {question.options.length > 0 && (
        <div className="question-options">
          {question.options.map((option) =>
            question.multiSelect ? (
              <button
                key={option}
                className={`chip ${picked.includes(option) ? "on" : ""}`}
                aria-pressed={picked.includes(option)}
                disabled={busy}
                onClick={() => toggle(option)}
              >
                {option}
              </button>
            ) : (
              <button key={option} className="chip" disabled={busy} onClick={() => void send(option)}>
                {option}
              </button>
            ),
          )}
          {question.multiSelect && (
            <button disabled={busy || picked.length === 0} onClick={() => void send(picked.join(", "))}>
              Send
            </button>
          )}
        </div>
      )}
      <form
        className="question-free"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <input
          value={text}
          disabled={busy}
          placeholder={question.options.length ? "Or type another answer…" : "Type your answer…"}
          aria-label="Answer"
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" disabled={busy || !text.trim()}>
          Answer
        </button>
      </form>
      {error && <p className="question-error">{error}</p>}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const PREVIEW_CHARS = 20_000;

function isTextual(mime: string): boolean {
  return mime.startsWith("text/") || /json|xml|javascript/.test(mime);
}

/**
 * A file the assistant produced. Images show inline; HTML previews in a
 * sandboxed frame (no scripts, no same-origin access); other text previews as
 * plain text. Everything can be downloaded under its given name.
 */
export function ArtifactCard({ file }: { file: FilePart }): JSX.Element {
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isImage = file.mime.startsWith("image/") && file.mime !== "image/svg+xml";
  const isHtml = file.mime === "text/html";
  const canPreview = isHtml || isTextual(file.mime) || file.mime === "image/svg+xml";

  async function togglePreview(): Promise<void> {
    if (preview !== null) {
      setPreview(null);
      return;
    }
    try {
      const text = await (await api.fetchAttachmentBlob(file.id)).text();
      setPreview(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function download(): Promise<void> {
    try {
      await api.downloadAttachment(file.id, file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="artifact">
      {isImage && <MessageImage attachmentId={file.id} src="" />}
      <div className="artifact-row">
        <span className="artifact-icon" aria-hidden="true">
          {file.name.split(".").pop()?.slice(0, 4).toUpperCase() || "FILE"}
        </span>
        <span className="artifact-meta">
          <span className="artifact-name">{file.name}</span>
          <span className="artifact-size">
            {file.mime} · {formatBytes(file.size)}
          </span>
        </span>
        {canPreview && (
          <button className="ghost" onClick={() => void togglePreview()}>
            {preview !== null ? "Hide" : "Preview"}
          </button>
        )}
        <button onClick={() => void download()}>Download</button>
      </div>
      {preview !== null &&
        (isHtml || file.mime === "image/svg+xml" ? (
          // Empty sandbox: no scripts, forms, or access to this origin.
          <iframe className="artifact-frame" title={file.name} sandbox="" srcDoc={preview} />
        ) : (
          <pre className="artifact-text">
            {preview.length > PREVIEW_CHARS ? `${preview.slice(0, PREVIEW_CHARS)}\n…` : preview}
          </pre>
        ))}
      {error && <p className="question-error">{error}</p>}
    </div>
  );
}

/** Images and files from a tool's result, shown outside the collapsed call. */
export function ToolOutputs({ parts }: { parts: Part[] }): JSX.Element | null {
  const images = parts.filter((p): p is Extract<Part, { type: "image" }> => p.type === "image");
  const files = parts.filter((p): p is FilePart => p.type === "file");
  if (images.length === 0 && files.length === 0) return null;
  return (
    <div className="tool-outputs">
      {images.length > 0 && (
        <div className="msg-images">
          {images.map((image, index) =>
            image.source.kind === "attachment" ? (
              <MessageImage key={index} attachmentId={image.source.id} src="" />
            ) : (
              <MessageImage
                key={index}
                src={
                  image.source.kind === "url"
                    ? image.source.url
                    : `data:${image.source.mime};base64,${image.source.data}`
                }
              />
            ),
          )}
        </div>
      )}
      {files.map((file) => (
        <ArtifactCard key={file.id} file={file} />
      ))}
    </div>
  );
}
