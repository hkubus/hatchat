import { useCallback, useEffect, useState } from "react";
import type { MemoryRecord, ScheduleRecord } from "./api";
import {
  addMemory,
  deleteMemory,
  deleteSchedule,
  getMemories,
  getSchedules,
  runSchedule,
  setScheduleEnabled,
  updateMemory,
} from "./api";

function MemoryRow({ memory, onChanged }: { memory: MemoryRecord; onChanged: () => Promise<void> }): JSX.Element {
  const [text, setText] = useState(memory.text);
  const [busy, setBusy] = useState(false);
  const dirty = text.trim() !== memory.text;

  useEffect(() => setText(memory.text), [memory.text]);

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    try {
      await work();
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-row compact memory-row">
      <input value={text} aria-label="Memory" disabled={busy} onChange={(e) => setText(e.target.value)} />
      {dirty && (
        <button disabled={busy || !text.trim()} onClick={() => void run(() => updateMemory(memory.id, text.trim()))}>
          Save
        </button>
      )}
      <button className="ghost" disabled={busy} onClick={() => void run(() => deleteMemory(memory.id))}>
        Forget
      </button>
    </div>
  );
}

/** What the assistant remembers about the user across conversations. */
export function MemoriesSection(): JSX.Element {
  const [memories, setMemories] = useState<MemoryRecord[] | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMemories(await getMemories());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(): Promise<void> {
    if (!draft.trim()) return;
    try {
      await addMemory(draft.trim());
      setDraft("");
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <section className="settings-section">
      <h2>Memory{memories ? ` (${memories.length})` : ""}</h2>
      <p className="settings-hint">
        Facts the assistant saved about you. They are included in every conversation while the
        Memory plugin is enabled; edit or forget anything here.
      </p>
      {memories?.map((memory) => <MemoryRow key={memory.id} memory={memory} onChanged={load} />)}
      <form
        className="settings-row compact"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          className="memory-input"
          value={draft}
          placeholder="Add something to remember…"
          aria-label="New memory"
          maxLength={500}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" disabled={!draft.trim()}>
          Add
        </button>
      </form>
      {error && <p className="settings-error">{error}</p>}
    </section>
  );
}

function formatWhen(ms: number | null): string {
  return ms === null ? "—" : new Date(ms).toLocaleString();
}

/** Prompts the assistant scheduled to run later or on a cron. */
export function SchedulesSection({ onOpenSession }: { onOpenSession?: (id: string) => void }): JSX.Element {
  const [schedules, setSchedules] = useState<ScheduleRecord[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSchedules(await getSchedules());
    } catch (e) {
      setMessage(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(work: () => Promise<void>, done?: string): Promise<void> {
    setMessage(null);
    try {
      await work();
      if (done) setMessage(done);
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="settings-section">
      <h2>Scheduled tasks{schedules ? ` (${schedules.length})` : ""}</h2>
      <p className="settings-hint">
        Ask the assistant to "remind me…" or "every weekday at 8, summarize…" to create one. Each run
        appears as a conversation in the sidebar.
      </p>
      {schedules?.length === 0 && <p className="settings-hint">Nothing scheduled.</p>}
      {schedules?.map((schedule) => (
        <div key={schedule.id} className="settings-row">
          <div className="settings-row-head">
            <span className="settings-name">{schedule.title}</span>
            <span className="pill muted">
              {schedule.cron ? `${schedule.cron} · ${schedule.timezone}` : "once"}
            </span>
            {!schedule.enabled && <span className="pill">paused</span>}
            {schedule.lastError && <span className="pill bad">last run failed</span>}
            <label className="cfg-toggle">
              <input
                type="checkbox"
                checked={schedule.enabled}
                onChange={(e) => void act(() => setScheduleEnabled(schedule.id, e.target.checked))}
              />
              enabled
            </label>
          </div>
          <p className="settings-hint">{schedule.prompt}</p>
          <div className="settings-meta">
            <span className="settings-hint">next: {formatWhen(schedule.nextRunAt)}</span>
            <span className="settings-hint">last: {formatWhen(schedule.lastRunAt)}</span>
            <span className="settings-hint mono">{schedule.model}</span>
          </div>
          {schedule.lastError && <p className="settings-error">{schedule.lastError}</p>}
          <div className="settings-row-body">
            <button onClick={() => void act(() => runSchedule(schedule.id), "Started; the result will appear in the sidebar.")}>
              Run now
            </button>
            {schedule.lastSessionId && onOpenSession && (
              <button className="ghost" onClick={() => onOpenSession(schedule.lastSessionId!)}>
                Open last run
              </button>
            )}
            <button className="ghost" onClick={() => void act(() => deleteSchedule(schedule.id))}>
              Delete
            </button>
          </div>
        </div>
      ))}
      {message && <p className="settings-msg">{message}</p>}
    </section>
  );
}
