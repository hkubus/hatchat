import type { UiMessage, UiTool } from "@hat/core";
import { questionOf, todosOf } from "@hat/core";
import { Fragment, Suspense, lazy, useEffect, useRef, useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  EditIcon,
  ForkIcon,
  RegenerateIcon,
} from "./icons";
import MessageImage from "./MessageImage";
import { ArtifactCard, QuestionCard, TodoList, ToolOutputs, argBrief } from "./ToolExtras";

const Markdown = lazy(() => import("./Markdown"));

/**
 * The one-word state shown at the end of a tool call's summary line.
 * Running and plain success are deliberately silent — a spinner marks the
 * former and a finished call needs no label.
 */
function toolStatus(t: UiTool): string | null {
  if (t.approval === "requested") return "awaiting approval";
  if (t.approval === "denied") return "denied";
  if (t.isError) return "failed";
  return null;
}

/**
 * The single line that identifies a tool call while collapsed. Shell calls get
 * their command, everything else gets the first line of whatever the tool
 * returned — the two things that actually tell you what the call was doing.
 */
function toolBrief(t: UiTool): string {
  const brief = argBrief(t.name, t.args);
  if (brief) return brief;
  if (t.args && typeof t.args === "object" && "command" in t.args) {
    return String((t.args as { command: unknown }).command);
  }
  const first = (t.result ?? "").split("\n").find((line) => line.trim().length > 0);
  return first?.trim() ?? "";
}

/** The full argument payload, formatted for the expanded body. */
function toolArgs(t: UiTool): string {
  if (t.args && typeof t.args === "object" && "command" in t.args) {
    return `$ ${String((t.args as { command: unknown }).command)}`;
  }
  return JSON.stringify(t.args, null, 2) ?? "";
}

function CopyButton({ text, title }: { text: string; title: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  function copy(): void {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button className="icon-btn" onClick={copy} title={title} aria-label={title} aria-live="polite">
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

export interface MessageActions {
  busy: boolean;
  sessionId: string | null;
  editing: { messageId: string; text: string } | null;
  /** `ask_user` calls answered here, hidden until their result arrives. */
  answered: ReadonlySet<string>;
  onEditChange(messageId: string, text: string): void;
  onEditSubmit(): void;
  onEditCancel(): void;
  onRegenerate(messageId: string): void;
  onFork(messageId: string): void;
  onSwitchBranch(messageId: string): void;
  onDecide(callId: string, decision: "approve" | "deny"): void;
  onAnswer(callId: string, answer: string): Promise<void>;
}

export default function MessageView({
  m,
  streamingNow = false,
  highlighted = false,
  actions,
}: {
  m: UiMessage;
  streamingNow?: boolean;
  highlighted?: boolean;
  actions: MessageActions;
}): JSX.Element {
  const { busy, editing, sessionId, answered } = actions;
  // An optimistic user message has no server id yet, so the actions that need
  // one (regenerate, edit, branch, fork) stay off it.
  const persisted = !m.id.startsWith("local-");

  return (
    <div
      id={`msg-${m.id}`}
      className={`msg ${m.role}${streamingNow ? " streaming" : ""}${highlighted ? " highlighted" : ""}`}
    >
      {editing?.messageId === m.id ? (
        <div className="edit-box">
          <textarea
            value={editing.text}
            onChange={(e) => actions.onEditChange(m.id, e.target.value)}
            rows={3}
          />
          <div className="edit-actions">
            <button onClick={() => actions.onEditSubmit()} disabled={busy}>
              Save & resend
            </button>
            <button className="ghost" onClick={() => actions.onEditCancel()}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {m.reasoning && (
            <details className="reasoning">
              <summary>
                <ChevronDownIcon className="disclosure" />
                <span>reasoning</span>
              </summary>
              <pre className="aside-body">{m.reasoning}</pre>
            </details>
          )}

          {m.text && (
            <div className={`markdown ${m.role}`}>
              <Suspense fallback={<span className="md-fallback">{m.text}</span>}>
                <Markdown>{m.text}</Markdown>
              </Suspense>
              {/* The caret lives inside the markdown block, not beside it:
                  as a sibling it would be a block-level flex item of `.msg`
                  and drop onto a line of its own. */}
              {streamingNow && <span className="caret" />}
            </div>
          )}

          {m.images.length > 0 && (
            <div className="msg-images">
              {m.images.map((img, index) => (
                <MessageImage key={index} attachmentId={img.attachmentId} src={img.src} />
              ))}
            </div>
          )}

          {m.files.length > 0 && (
            <div className="msg-files">
              {m.files.map((file) => (
                <ArtifactCard key={file.id} file={file} />
              ))}
            </div>
          )}

          {m.tools.map((t) => {
            if (t.name === "todo_write") return <TodoList key={t.callId} todos={todosOf(t.args)} />;
            const status = toolStatus(t);
            const question = t.name === "ask_user" ? questionOf(t.args) : undefined;
            const asking = question && t.running && !answered.has(t.callId) && sessionId;
            return (
              <Fragment key={t.callId}>
                <details
                  className={`tool ${t.isError ? "err" : ""} ${t.approval === "requested" ? "awaiting" : ""}`}
                  // An approval is a blocking question, so it must be visible
                  // rather than folded away behind a click.
                  open={t.approval === "requested"}
                >
                  <summary>
                    <ChevronDownIcon className="disclosure" />
                    <span className="tool-name">{t.name}</span>
                    <span className="tool-brief">{toolBrief(t)}</span>
                    {t.running && t.approval !== "requested" ? (
                      <span className="tool-spinner" role="status" aria-label="Running" />
                    ) : (
                      status && <span className={`tool-status ${t.approval ?? ""}`}>{status}</span>
                    )}
                  </summary>
                  <div className="aside-body">
                    <pre className="tool-args">{toolArgs(t)}</pre>
                    {t.approval === "requested" && (
                      <div className="approval">
                        <button onClick={() => actions.onDecide(t.callId, "approve")}>Approve</button>
                        <button className="danger" onClick={() => actions.onDecide(t.callId, "deny")}>
                          Deny
                        </button>
                      </div>
                    )}
                    {t.result && <pre className="tool-result">{t.result}</pre>}
                  </div>
                </details>
                {asking && (
                  <QuestionCard question={question} onAnswer={(answer) => actions.onAnswer(t.callId, answer)} />
                )}
                <ToolOutputs images={t.images} files={t.files} />
              </Fragment>
            );
          })}

          {!streamingNow && m.role === "assistant" && m.finishReason === "length" && (
            <div className="truncated-note">Cut off at the output limit.</div>
          )}
        </>
      )}

      {!streamingNow && !editing && (
        <div className="msg-actions">
          {m.branch && m.branch.count > 1 && (
            <span
              className="branch"
              role="group"
              aria-label={`Version ${m.branch.index + 1} of ${m.branch.count}`}
            >
              <button
                className="icon-btn"
                title="Previous version (regenerating creates versions)"
                aria-label={`Previous version, currently ${m.branch.index + 1} of ${m.branch.count}`}
                disabled={m.branch.index <= 0 || busy}
                onClick={() => actions.onSwitchBranch(m.branch!.ids[m.branch!.index - 1])}
              >
                <ChevronLeftIcon />
              </button>
              <span className="branch-label" aria-hidden="true">
                {m.branch.index + 1}/{m.branch.count}
              </span>
              <button
                className="icon-btn"
                title="Next version (regenerating creates versions)"
                aria-label={`Next version, currently ${m.branch.index + 1} of ${m.branch.count}`}
                disabled={m.branch.index >= m.branch.count - 1 || busy}
                onClick={() => actions.onSwitchBranch(m.branch!.ids[m.branch!.index + 1])}
              >
                <ChevronRightIcon />
              </button>
            </span>
          )}
          {m.text && <CopyButton text={m.text} title="Copy message" />}
          {m.role === "assistant" && persisted && (
            <button
              className="icon-btn"
              title="Regenerate"
              aria-label="Regenerate"
              disabled={busy}
              onClick={() => actions.onRegenerate(m.id)}
            >
              <RegenerateIcon />
            </button>
          )}
          {m.role === "user" && persisted && (
            <button
              className="icon-btn"
              title="Edit"
              aria-label="Edit"
              disabled={busy}
              onClick={() => actions.onEditChange(m.id, m.text)}
            >
              <EditIcon />
            </button>
          )}
          {persisted && (
            <button
              className="icon-btn"
              title="Fork: continue from here in a new conversation"
              aria-label="Fork from here"
              disabled={busy}
              onClick={() => actions.onFork(m.id)}
            >
              <ForkIcon />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
