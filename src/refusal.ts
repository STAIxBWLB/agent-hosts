/** Stable identifiers for machine-readable path and entry refusals. */
export const REFUSAL_CODES = [
  "relative-override",
  "empty-override",
  "opencode-config-route",
  "opencode-environment-required",
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
  readonly file?: string;

  constructor(readonly code: RefusalCode, readonly reason: string, options?: ErrorOptions & { file?: string }) {
    super(reason, options);
    this.name = "EntryRefusal";
    if (options?.file !== undefined) this.file = options.file;
  }
}

export function asEntryRefusal(error: unknown, context: string, file?: string): EntryRefusal {
  if (error instanceof EntryRefusal) {
    return !error.file && file ? new EntryRefusal(error.code, error.reason, { file, cause: error }) : error;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new EntryRefusal("io-error", `${context}: ${detail}; inspect the path and its permissions before retrying`, { cause: error, file });
}
