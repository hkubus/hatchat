import { useEffect, useState } from "react";
import type { SessionRecord } from "./api";

type Settings = Pick<SessionRecord, "instructions" | "temperature" | "maxTokens">;

/** Blank means "provider default"; anything else must parse. */
function parseOptional(raw: string, integer: boolean): number | null | undefined {
  const text = raw.trim();
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) return undefined;
  return value;
}

/**
 * Per-conversation model settings: instructions appended to the system prompt,
 * and the sampling knobs. They travel with the conversation (fork, export).
 */
export default function ChatSettings({
  settings,
  onSave,
  onClose,
}: {
  settings: Settings;
  onSave: (patch: Settings) => Promise<void>;
  onClose: () => void;
}): JSX.Element {
  const [instructions, setInstructions] = useState(settings.instructions);
  const [temperature, setTemperature] = useState(settings.temperature?.toString() ?? "");
  const [maxTokens, setMaxTokens] = useState(settings.maxTokens?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setInstructions(settings.instructions);
    setTemperature(settings.temperature?.toString() ?? "");
    setMaxTokens(settings.maxTokens?.toString() ?? "");
  }, [settings.instructions, settings.temperature, settings.maxTokens]);

  const parsedTemperature = parseOptional(temperature, false);
  const parsedMaxTokens = parseOptional(maxTokens, true);
  const temperatureError =
    parsedTemperature === undefined || (parsedTemperature !== null && (parsedTemperature < 0 || parsedTemperature > 2));
  const maxTokensError = parsedMaxTokens === undefined || (parsedMaxTokens !== null && parsedMaxTokens < 1);
  const dirty =
    instructions.trim() !== settings.instructions ||
    parsedTemperature !== settings.temperature ||
    parsedMaxTokens !== settings.maxTokens;

  async function save(): Promise<void> {
    if (temperatureError || maxTokensError) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        instructions: instructions.trim(),
        temperature: parsedTemperature ?? null,
        maxTokens: parsedMaxTokens ?? null,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="chat-settings" role="dialog" aria-label="Conversation settings">
      <div className="chat-settings-head">
        <h2>This conversation</h2>
        <button className="ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <label className="chat-settings-field">
        <span>Instructions</span>
        <textarea
          value={instructions}
          rows={5}
          placeholder="e.g. Answer in British English. Prefer short answers with code examples."
          onChange={(e) => setInstructions(e.target.value)}
        />
        <small>Added to the system prompt for every reply in this conversation.</small>
      </label>
      <div className="chat-settings-row">
        <label className="chat-settings-field">
          <span>Temperature</span>
          <input
            inputMode="decimal"
            value={temperature}
            placeholder="default"
            aria-invalid={temperatureError}
            onChange={(e) => setTemperature(e.target.value)}
          />
          <small>{temperatureError ? "0 to 2, or blank" : "0 to 2; blank uses the model's default"}</small>
        </label>
        <label className="chat-settings-field">
          <span>Max reply tokens</span>
          <input
            inputMode="numeric"
            value={maxTokens}
            placeholder="default"
            aria-invalid={maxTokensError}
            onChange={(e) => setMaxTokens(e.target.value)}
          />
          <small>{maxTokensError ? "A whole number, or blank" : "Longer replies are cut off (you can continue them)"}</small>
        </label>
      </div>
      <div className="chat-settings-actions">
        <button onClick={() => void save()} disabled={!dirty || saving || temperatureError || maxTokensError}>
          {saving ? "Saving…" : "Save"}
        </button>
        {error && <span className="error-inline">{error}</span>}
      </div>
    </div>
  );
}
