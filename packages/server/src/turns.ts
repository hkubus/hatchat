import type { KernelEvent } from "@hat/core";

type Listener = (event: KernelEvent) => void;

interface Subscriber {
  onEvent: Listener;
  onEnd: () => void;
}

/**
 * One in-flight turn. A turn outlives any single request: refreshing the tab or
 * switching conversations closes the SSE connection, but the model keeps
 * running. Subscribers replay whatever is not yet durable and then follow live.
 *
 * The replay buffer is trimmed at each message boundary (`message.done`,
 * `tool.result`) because everything up to that point is already persisted and
 * will come back from the session path instead.
 */
export class Turn {
  readonly abort = new AbortController();
  readonly signal = this.abort.signal;

  private events: KernelEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private finished = false;

  constructor(readonly sessionId: string) {}

  get done(): boolean {
    return this.finished;
  }

  push(event: KernelEvent): void {
    this.events.push(event);
    if (event.type === "message.done" || event.type === "tool.result") {
      this.events = [];
    } else if (this.events.length > 2_000) {
      this.events.shift();
    }
    for (const subscriber of this.subscribers) subscriber.onEvent(event);
  }

  /** Replay the pending tail, then receive live events until `onEnd`. */
  subscribe(subscriber: Subscriber): () => void {
    if (this.finished) {
      subscriber.onEnd();
      return () => {};
    }
    for (const event of this.events) subscriber.onEvent(event);
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  end(): void {
    if (this.finished) return;
    this.finished = true;
    for (const subscriber of this.subscribers) subscriber.onEnd();
    this.subscribers.clear();
    this.events = [];
  }
}

/**
 * Registry of active turns, one per session. `start` supersedes any turn still
 * running for that session; completed turns linger briefly so a client that
 * reconnects right as one ends can still drain the final events.
 */
export class TurnHub {
  private readonly turns = new Map<string, Turn>();

  get(sessionId: string): Turn | undefined {
    return this.turns.get(sessionId);
  }

  start(sessionId: string): Turn {
    this.turns.get(sessionId)?.abort.abort();
    const turn = new Turn(sessionId);
    this.turns.set(sessionId, turn);
    return turn;
  }

  /** Push an out-of-band event (e.g. an approval prompt) into the active turn. */
  emit(sessionId: string, event: KernelEvent): void {
    this.turns.get(sessionId)?.push(event);
  }

  finish(turn: Turn): void {
    turn.end();
    if (this.turns.get(turn.sessionId) === turn) {
      setTimeout(() => {
        if (this.turns.get(turn.sessionId) === turn) this.turns.delete(turn.sessionId);
      }, 10_000).unref?.();
    }
  }
}
