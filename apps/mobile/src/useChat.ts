/**
 * The chat state machine.
 *
 * This is the port of `apps/web/src/App.tsx`'s state block. The web version
 * keeps it inline in a 1100-line component; here it is a hook so the transcript,
 * the session list, and the settings screen can all read one source of truth
 * without any of them owning it.
 *
 * Two invariants from the web client are load-bearing and preserved verbatim:
 *
 *   - **Usage is not double-counted.** `liveUsage` accumulates the turn in
 *     flight and is cleared only *after* the post-turn refresh has folded the
 *     server's stored usage into `messages`. Clearing it earlier would add the
 *     same tokens twice.
 *   - **A turn always ends in a refresh.** The streamed view is an optimistic
 *     projection; the server's path is the truth. That is what makes abort,
 *     mid-turn failure, and multi-iteration tool loops land on something
 *     correct rather than on a half-streamed transcript.
 */

import type { ModelInfo, ReasoningEffort, Usage } from "@hat/core";
import { REASONING_EFFORTS, addUsage, sumUsage } from "@hat/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import * as api from "./api";
import type { ApprovalMode, ApprovalDecision, RunnerSummary, SessionRecord, SessionSummary } from "./api";
import type { UiMessage } from "./chat";
import { applyEffect, approvalForDecision, buildMessages, readEvent } from "./chat";
import { loadPref, savePref } from "./runtime";

const DEFAULT_MODEL = "fake/fake-agent";

export interface PendingAttachment {
  uri: string;
  name: string;
  type: string;
  /** Local file URI, used for the preview thumbnail before the upload lands. */
  previewUri: string;
}

export interface ChatStore {
  ready: boolean;
  models: ModelInfo[];
  sessions: SessionSummary[];
  runners: RunnerSummary[];
  sessionId: string | null;
  session: SessionRecord | null;
  messages: UiMessage[];
  /** Assistant messages for the turn in flight, one per model iteration. */
  inFlight: UiMessage[];
  busy: boolean;
  error: string | null;
  warnings: string[];
  model: string;
  reasoningEffort: ReasoningEffort;
  policyMode: ApprovalMode;
  allowedTools: string[];
  /** Everything the visible branch has cost, including the turn in flight. */
  sessionUsage: Usage;
  selectedModel: ModelInfo | undefined;

  clearError: () => void;
  /** Raise a client-side problem (a rejected file, a failed request). */
  reportError: (message: string) => void;
  send: (text: string, attachments: PendingAttachment[]) => Promise<void>;
  stop: () => void;
  newChat: () => Promise<void>;
  openSession: (id: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  regenerate: (messageId: string) => Promise<void>;
  editMessage: (messageId: string, text: string) => Promise<void>;
  switchBranch: (messageId: string) => Promise<void>;
  decide: (callId: string, decision: ApprovalDecision) => Promise<void>;
  setModel: (next: string) => void;
  setEffort: (next: ReasoningEffort) => void;
  setPolicyMode: (next: ApprovalMode) => void;
  setAllowedTools: (next: string[]) => void;
}

export function useChat(): ChatStore {
  const [ready, setReady] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [runners, setRunners] = useState<RunnerSummary[]>([]);
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [inFlight, setInFlightState] = useState<UiMessage[]>([]);
  const [liveUsage, setLiveUsage] = useState<Usage | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const [model, setModelState] = useState(DEFAULT_MODEL);
  const [reasoningEffort, setEffortState] = useState<ReasoningEffort>("off");
  const [policyMode, setPolicyModeState] = useState<ApprovalMode>("ask");
  const [allowedTools, setAllowedToolsState] = useState<string[]>([]);
  const [sessionId, setSessionIdState] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  // Identity of the turn whose events are currently allowed to touch state.
  // Guards against a late event from an abandoned turn landing in the state of
  // the session the user has since opened, and gives the turn's own cleanup a
  // way to tell whether it is still the current one.
  const turnRef = useRef<number | null>(null);
  const turnSeq = useRef(0);
  // Mirrors of state the turn lifecycle needs to read from inside async
  // callbacks, where the value captured in a closure would be stale. `stop` in
  // particular has to cancel *the session on screen now*, not the one it saw
  // when it was created.
  const sessionRef = useRef<string | null>(null);
  const inFlightRef = useRef<UiMessage[]>([]);

  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

  // `sessionRef` is written synchronously as well as from the effect above, so
  // it is already current for a `setSessionId` followed immediately by a
  // `followActiveTurn` in the same handler.
  const setSessionId = useCallback((next: string | null) => {
    sessionRef.current = next;
    setSessionIdState(next);
  }, []);

  // Kept in step with `inFlight` so `finishTurn` can promote what was streamed
  // without depending on a render having happened first.
  const setInFlight = useCallback(
    (update: UiMessage[] | ((prev: UiMessage[]) => UiMessage[])) => {
      setInFlightState((prev) => {
        const next = typeof update === "function" ? update(prev) : update;
        inFlightRef.current = next;
        return next;
      });
    },
    [],
  );

  const applySession = useCallback((next: SessionRecord) => {
    setSession(next);
    setModelState(next.model);
    setPolicyModeState(next.approvalMode);
    setAllowedToolsState(next.allowedTools);
    setEffortState(next.reasoningEffort);
  }, []);

  const refreshSessions = useCallback(async () => {
    const list = await api.listSessions();
    setSessions(list);
  }, []);

  const refresh = useCallback(
    async (id: string) => {
      const payload = await api.getSession(id);
      setMessages(buildMessages(payload.path));
      applySession(payload.session);
    },
    [applySession],
  );

  // --- streaming ----------------------------------------------------------

  const handleEvent = useCallback(
    (event: Parameters<typeof readEvent>[0], turnId: number) => {
      if (turnRef.current !== turnId) return;

      if (event.type === "usage") {
        // Usage is a per-iteration delta, so it accumulates.
        setLiveUsage((prev) => addUsage(prev, event.usage));
        return;
      }

      const effect = readEvent(event);
      switch (effect.kind) {
        case "reset-usage":
          setLiveUsage(undefined);
          break;
        case "error":
          setError(effect.message);
          break;
        case "warning":
          setWarnings((prev) => [...prev, effect.message]);
          break;
        case "session-title":
          // The server titles a new conversation from the first message while
          // the turn runs. Patching the list in place is what makes the header
          // update as you watch, instead of only after the turn ends.
          setSessions((prev) =>
            prev.map((s) => (s.id === effect.sessionId ? { ...s, title: effect.title } : s)),
          );
          break;
        default:
          setInFlight((current) => applyEffect(current, effect));
      }
    },
    [],
  );

  /**
   * Settle the view once a turn ends, however it ended.
   *
   * The streamed messages are promoted into `messages` *before* the refetch.
   * `refresh` replaces the list wholesale from the server's branch path, so
   * promoting first makes the refetch a quiet reconciliation instead of a swap
   * that blanks the last deltas — and if the refetch fails outright, the turn
   * the user just watched is still on screen.
   */
  const finishTurn = useCallback(
    async (id: string) => {
      if (inFlightRef.current.length > 0) {
        setMessages((prev) => [...prev, ...inFlightRef.current]);
      }
      setInFlight([]);
      await refresh(id).catch(() => undefined);
      await refreshSessions().catch(() => undefined);
      // Dropped only now: `messages` already carries the stored usage, so
      // keeping `liveUsage` would count the same tokens twice.
      setLiveUsage(undefined);
      setBusy(false);
    },
    [refresh, refreshSessions],
  );

  const runStream = useCallback(
    async (
      id: string,
      run: (
        onEvent: (event: Parameters<typeof readEvent>[0]) => void,
        signal: AbortSignal,
      ) => Promise<void>,
    ) => {
      const controller = new AbortController();
      // Monotonic, so two turns on one session can never collide on identity.
      turnSeq.current += 1;
      const turnId = turnSeq.current;
      abortRef.current = controller;
      turnRef.current = turnId;
      setBusy(true);
      setError(null);
      setInFlight([]);
      setWarnings([]);

      try {
        await run((event) => handleEvent(event, turnId), controller.signal);
      } catch (e) {
        // A turn the user stopped is not a failure; the server already unwound it.
        if (!api.isAbortError(e)) setError(describe(e));
      } finally {
        // Skipped once the turn has been abandoned (see `abandonTurn`): its
        // cleanup would otherwise overwrite the session the user moved to.
        if (turnRef.current === turnId) {
          abortRef.current = null;
          turnRef.current = null;
          if (sessionRef.current === id) await finishTurn(id);
        }
      }
    },
    [handleEvent, finishTurn],
  );

  /** Close the socket but leave the turn running server-side. */
  const detachStream = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  /**
   * The Stop button.
   *
   * Aborting the request is *not* enough: turns outlive their connection, so
   * closing the socket would just stop the updates while the model kept
   * generating and billing with nobody watching. The cancel has to be asked for
   * explicitly, then the socket is dropped to unblock the UI straight away.
   */
  const stop = useCallback(() => {
    if (sessionId) void api.cancelTurn(sessionId).catch(() => undefined);
    detachStream();
  }, [sessionId, detachStream]);

  /**
   * Leave the turn entirely, because the user is going somewhere else.
   *
   * Deliberately does **not** cancel: turns now outlive their connection, so
   * switching conversations leaves the model running and switching back
   * reattaches to it. Detaching is what stops the abandoned turn's `finally`
   * from writing the old session's messages over the new one.
   */
  const abandonTurn = useCallback(() => {
    detachStream();
    turnRef.current = null;
    setBusy(false);
  }, [detachStream]);

  /**
   * Reattach to a turn already running for `id`.
   *
   * The case that makes this necessary on iOS: the app gets backgrounded or
   * suspended while the model is answering, and the turn keeps going. Coming
   * back picks the answer up instead of showing a conversation that looks idle
   * while tokens are being spent. Resolves immediately when nothing is running.
   */
  const followActiveTurn = useCallback(
    async (id: string) => {
      // A ref guard rather than state: this can be kicked off from an effect
      // where the state has not caught up yet.
      if (sessionRef.current !== id) return;

      const controller = new AbortController();
      turnSeq.current += 1;
      const turnId = turnSeq.current;
      abortRef.current = controller;
      turnRef.current = turnId;
      setBusy(true);
      setError(null);
      setInFlight([]);
      setWarnings([]);

      try {
        await api.followTurn(
          id,
          (event) => handleEvent(event, turnId),
          controller.signal,
        );
      } catch (e) {
        if (!api.isAbortError(e)) setError(describe(e));
      } finally {
        // Same reconciliation as a turn we started, for the same reasons: the
        // user may have moved on while this was finishing.
        if (turnRef.current === turnId) {
          abortRef.current = null;
          turnRef.current = null;
          if (sessionRef.current === id) {
            await finishTurn(id);
          }
        }
      }
    },
    [handleEvent],
  );

  // --- boot ---------------------------------------------------------------

  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    let cancelled = false;

    (async () => {
      try {
        const [modelList, runnerList] = await Promise.all([
          api.getModels().catch(() => [] as ModelInfo[]),
          api.getRunners().catch(() => [] as RunnerSummary[]),
        ]);
        const list = await api.listSessions().catch(() => [] as SessionSummary[]);
        if (cancelled) return;

        setModels(modelList);
        setRunners(runnerList);
        setSessions(list);

        // Restore the last conversation, so a relaunch mid-thread lands back in
        // it. A session that has since been deleted must not strand the user on
        // a broken header, so fall back to the most recent conversation.
        const storedId = await loadPref("session", "");
        const target =
          (storedId && list.find((s) => s.id === storedId)?.id) || list[0]?.id || null;

        if (target) {
          const payload = await api.getSession(target).catch(() => null);
          if (cancelled) return;
          if (payload) {
            setSessionId(payload.session.id);
            setMessages(buildMessages(payload.path));
            applySession(payload.session);
            await savePref("session", payload.session.id);
            // A turn started before the app was closed is still running. On
            // iOS this is the common case, not the exception — the system
            // suspends the app freely — so reattaching is what makes the
            // restored conversation pick up where the model actually is.
            if (!cancelled) void followActiveTurn(payload.session.id);
          }
        }

        const storedModel = await loadPref("model", "");
        if (storedModel && modelList.some((m) => m.id === storedModel)) {
          setModelState(storedModel);
        } else if (modelList.length > 0) {
          setModelState(modelList[0].id);
        }

        const storedEffort = await loadPref("effort", "off");
        if ((REASONING_EFFORTS as readonly string[]).includes(storedEffort)) {
          setEffortState(storedEffort as ReasoningEffort);
        }
      } catch (e) {
        if (!cancelled) setError(describe(e));
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applySession, followActiveTurn]);

  useEffect(() => () => abortRef.current?.abort(), []);

  /**
   * Reattach when the app comes back to the foreground.
   *
   * This is the whole reason `followTurn` exists on iOS. The system suspends a
   * backgrounded app freely, and a socket suspended mid-stream is not a
   * reliable stream — but the turn keeps running on the server either way.
   * Coming back and asking what is happening is both cheaper and far more
   * correct than showing a conversation that looks finished while tokens are
   * still being spent.
   *
   * Uses `AppState` rather than an expo module so the hook has no new dependency.
   */
  useEffect(() => {
    let wasActive = AppState.currentState === "active";

    const subscription = AppState.addEventListener("change", (next) => {
      const active = next === "active";
      const cameBack = active && !wasActive;
      wasActive = active;
      if (!cameBack) return;

      const id = sessionRef.current;
      // Only reattach when we are not already following: a turn we started is
      // still streaming, and restarting the subscription would drop deltas.
      if (id && !turnRef.current) void followActiveTurn(id);
    });

    return () => subscription.remove();
  }, [followActiveTurn]);

  // Keep the stored model in step once the server's list has arrived, so a
  // model that disappeared (a provider key was removed) does not stay selected.
  useEffect(() => {
    if (models.length > 0 && !models.some((m) => m.id === model)) {
      setModelState(models[0].id);
    }
  }, [models, model]);

  // --- actions ------------------------------------------------------------

  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionId) return sessionId;
    const payload = await api.createSession(model);
    setSessionId(payload.session.id);
    setMessages(buildMessages(payload.path));
    applySession(payload.session);
    await savePref("session", payload.session.id);
    await refreshSessions().catch(() => undefined);
    if (policyMode !== "ask" || reasoningEffort !== "off" || allowedTools.length > 0) {
      const updated = await api.updateSession(payload.session.id, {
        approvalMode: policyMode,
        allowedTools,
        reasoningEffort,
      });
      applySession(updated);
    }
    return payload.session.id;
  }, [sessionId, model, policyMode, reasoningEffort, allowedTools, applySession, refreshSessions]);

  const send = useCallback(
    async (text: string, attachments: PendingAttachment[]) => {
      if (busy) return;
      const body = text.trim();
      if (!body && attachments.length === 0) return;

      setError(null);

      // Upload first, so a rejected image fails before anything is persisted.
      let attachmentIds: string[] = [];
      if (attachments.length > 0) {
        try {
          attachmentIds = await Promise.all(
            attachments.map(async (a) => (await api.uploadAttachment(a)).id),
          );
        } catch (e) {
          setError(describe(e));
          return;
        }
      }

      // Show the user's own message immediately; the refresh at the end of the
      // turn reconciles it with what the server stored.
      setMessages((prev) => [
        ...prev,
        {
          id: `local-${Date.now()}`,
          role: "user",
          text: body,
          reasoning: "",
          tools: [],
          images: attachments.map((a) => ({ src: a.previewUri })),
        },
      ]);

      try {
        const id = await ensureSession();
        await runStream(id, (onEvent, signal) =>
          api.sendTurn(id, body, model, attachmentIds, onEvent, signal),
        );
      } catch (e) {
        if (!api.isAbortError(e)) setError(describe(e));
        setBusy(false);
      }
    },
    [busy, ensureSession, model, runStream],
  );

  const newChat = useCallback(async () => {
    abandonTurn();
    setMessages([]);
    setInFlight([]);
    setError(null);
    setWarnings([]);
    setBusy(false);
    const payload = await api.createSession(model);
    setSessionId(payload.session.id);
    applySession(payload.session);
    await savePref("session", payload.session.id);
    await refreshSessions().catch(() => undefined);
  }, [abandonTurn, model, applySession, refreshSessions]);

  const openSession = useCallback(
    async (id: string) => {
      abandonTurn();
      setError(null);
      setWarnings([]);
      setInFlight([]);
      const payload = await api.getSession(id);
      setSessionId(payload.session.id);
      setMessages(buildMessages(payload.path));
      applySession(payload.session);
      await savePref("session", payload.session.id);
      // The previous conversation's turn may still be running, and this one may
      // have a turn of its own in flight (started on another device, or before
      // the app was backgrounded). Pick it up rather than showing a conversation
      // that looks idle while tokens are being spent.
      void followActiveTurn(payload.session.id);
    },
    [abandonTurn, applySession, followActiveTurn],
  );

  const renameSession = useCallback(
    async (id: string, title: string) => {
      await api.renameSession(id, title);
      await refreshSessions();
    },
    [refreshSessions],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      await api.deleteSession(id);
      if (id === sessionId) {
        setSessionId(null);
        setSession(null);
        setMessages([]);
        setInFlight([]);
        await savePref("session", "");
      }
      await refreshSessions();
    },
    [sessionId, refreshSessions],
  );

  const regenerate = useCallback(
    async (messageId: string) => {
      if (!sessionId || busy) return;
      await runStream(sessionId, (onEvent, signal) =>
        api.regenerate(sessionId, messageId, onEvent, signal),
      );
    },
    [sessionId, busy, runStream],
  );

  const editMessage = useCallback(
    async (messageId: string, text: string) => {
      if (!sessionId || busy || !text.trim()) return;
      await runStream(sessionId, (onEvent, signal) =>
        api.editMessage(sessionId, messageId, text, onEvent, signal),
      );
    },
    [sessionId, busy, runStream],
  );

  const switchBranch = useCallback(
    async (messageId: string) => {
      if (!sessionId || busy) return;
      const payload = await api.selectBranch(sessionId, messageId);
      setMessages(buildMessages(payload.path));
    },
    [sessionId, busy],
  );

  const decide = useCallback(
    async (callId: string, decision: ApprovalDecision) => {
      // Record the tap immediately: the round trip is long enough that a button
      // that sits there looking live makes the tool look hung.
      const resolved = approvalForDecision(decision);
      setInFlight((current) =>
        current.map((m) => ({
          ...m,
          tools: m.tools.map((t) => (t.callId === callId ? { ...t, approval: resolved } : t)),
        })),
      );
      if (!sessionId) return;
      try {
        // The server binds an approval to the session that asked for it.
        await api.resolveApproval(callId, decision, sessionId);
      } catch (e) {
        setError(describe(e));
      }
    },
    [sessionId],
  );

  // --- persisted bottom-bar settings --------------------------------------

  const persist = useCallback(
    (patch: api.SessionPatch) => {
      if (!sessionId) return;
      void api.updateSession(sessionId, patch).catch((e: unknown) => {
        setError(describe(e));
        // Pull the truth back so the control cannot silently drift.
        void refresh(sessionId).catch(() => undefined);
      });
    },
    [sessionId, refresh],
  );

  const setModel = useCallback(
    (next: string) => {
      setModelState(next);
      void savePref("model", next);
      // Must land immediately: the next turn is not guaranteed.
      persist({ model: next });
    },
    [persist],
  );

  const setEffort = useCallback(
    (next: ReasoningEffort) => {
      setEffortState(next);
      void savePref("effort", next);
      persist({ reasoningEffort: next });
    },
    [persist],
  );

  const setPolicyMode = useCallback(
    (next: ApprovalMode) => {
      setPolicyModeState(next);
      persist({ approvalMode: next });
    },
    [persist],
  );

  const setAllowedTools = useCallback(
    (next: string[]) => {
      setAllowedToolsState(next);
      persist({ allowedTools: next });
    },
    [persist],
  );

  // --- derived ------------------------------------------------------------

  const sessionUsage = useMemo(
    () => sumUsage([...messages.map((m) => m.usage), liveUsage]),
    [messages, liveUsage],
  );

  const selectedModel = useMemo(
    () => models.find((m) => m.id === model),
    [models, model],
  );

  return {
    ready,
    models,
    sessions,
    runners,
    sessionId,
    session,
    messages,
    inFlight,
    busy,
    error,
    warnings,
    model,
    reasoningEffort,
    policyMode,
    allowedTools,
    sessionUsage,
    selectedModel,
    clearError: useCallback(() => setError(null), []),
    reportError: useCallback((message: string) => setError(message), []),
    send,
    stop,
    newChat,
    openSession,
    refreshSessions,
    renameSession,
    deleteSession,
    regenerate,
    editMessage,
    switchBranch,
    decide,
    setModel,
    setEffort,
    setPolicyMode,
    setAllowedTools,
  };
}

/** Turn anything thrown into something worth showing a user. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
