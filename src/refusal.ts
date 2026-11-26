/** Stable identifiers for machine-readable path and entry refusals. */
export const REFUSAL_CODES = [
  "relative-override",
  "empty-override",
  "opencode-config-route",
  "opencode-merged-config",
  "jcode-interpolation",
  "invalid-target",
  "invalid-entry",
  "invalid-configuration",
  "size-limit",
  "unsafe-path",
  "lock-held",
  "changed-since-preview",
  "file-changed",
  "invalid-plan",
  "invalid-receipt",
  "managed-entry-changed",
  "pending-operation",
  "io-error",
] as const;

export type RefusalCode = typeof REFUSAL_CODES[number];

/** Apply and undo throw this error. Plan and path results carry the same reason and code. */
export class EntryRefusal extends Error {
  constructor(readonly code: RefusalCode, readonly reason: string, options?: ErrorOptions) {
    super(reason, options);
    this.name = "EntryRefusal";
  }
}

export function asEntryRefusal(error: unknown, context: string): EntryRefusal {
  if (error instanceof EntryRefusal) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new EntryRefusal("io-error", `${context}: ${detail}; inspect the path and its permissions before retrying`, { cause: error });
}
