export interface NormalizedError {
  code: string;
  message: string;
  retryable?: boolean;
  /** Server-requested delay before retrying (e.g. from `Retry-After`). */
  retryAfterMs?: number;
  cause?: unknown;
}

export function normalizeError(error: unknown, code = "unknown"): NormalizedError {
  if (error instanceof Error) {
    return { code, message: error.message, cause: error };
  }
  if (typeof error === "string") {
    return { code, message: error };
  }
  return { code, message: "Unknown error", cause: error };
}

export class HatError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "HatError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }

  toNormalized(): NormalizedError {
    return { code: this.code, message: this.message, retryable: this.retryable, cause: this };
  }
}
