interface Deferred<T> {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
}

/**
 * A push-based async queue used to bridge callback/websocket streams into
 * `for await` iteration. `fail` rejects pending and future reads.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Deferred<T>[] = [];
  private closed = false;
  private terminalError: unknown = undefined;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
    } else {
      this.values.push(value);
    }
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined as never, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.terminalError = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  get closed_(): boolean {
    return this.closed;
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) {
      return Promise.resolve({ value: this.values.shift() as T, done: false });
    }
    if (this.terminalError !== undefined) {
      return Promise.reject(this.terminalError);
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined as never, done: true });
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}
