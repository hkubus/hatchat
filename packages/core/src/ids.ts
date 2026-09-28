/**
 * Stable identifier generation. Uses the platform crypto UUID where available
 * (Node 20+, all modern browsers) and falls back to a random hex string.
 */
export function newId(prefix = ""): string {
  const uuid =
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}_${uuid}` : uuid;
}
