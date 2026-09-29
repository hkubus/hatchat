import type {
  ApprovalBroker,
  ApprovalDecision,
  ApprovalRequest,
  KernelEvent,
} from "@hat/core";

type TurnEmitter = (sessionId: string, event: KernelEvent) => void;

/**
 * Bridges tool approval requests to the client: emits `tool.approval` events on
 * the active turn stream and resolves when the client POSTs a decision.
 */
export class ApprovalManager implements ApprovalBroker {
  private readonly pending = new Map<string, { sessionId: string; finish: (decision: ApprovalDecision) => void }>();

  constructor(
    private readonly emitTurnEvent: TurnEmitter,
    private readonly timeoutMs = 300_000,
  ) {}

  request(req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    this.emitTurnEvent(req.sessionId, {
      type: "tool.approval",
      callId: req.callId,
      status: "requested",
    });

    return new Promise<ApprovalDecision>((resolve, reject) => {
      let settled = false;

      const finish = (decision: ApprovalDecision): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.pending.delete(req.callId);
        this.emitTurnEvent(req.sessionId, {
          type: "tool.approval",
          callId: req.callId,
          status: decision === "deny" ? "denied" : "approved",
        });
        resolve(decision);
      };

      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(req.callId);
        reject(new Error("approval aborted"));
      };

      const timer = setTimeout(() => finish("deny"), this.timeoutMs);

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(req.callId, { sessionId: req.sessionId, finish });
    });
  }

  resolve(callId: string, decision: ApprovalDecision, sessionId?: string): boolean {
    const entry = this.pending.get(callId);
    if (!entry) return false;
    // Bind approvals to the session that requested them so one tab can't
    // approve another conversation's tool call by guessing the call id.
    if (sessionId && entry.sessionId !== sessionId) return false;
    entry.finish(decision);
    return true;
  }
}
