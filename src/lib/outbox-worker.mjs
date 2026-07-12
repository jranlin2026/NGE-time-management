const RETRY_SECONDS = [30, 120, 300, 900, 1800, 3600, 7200, 7200];
import { sanitizeError } from "./sanitize-error.mjs";

export function createOutboxWorker({ ops, send, clock }) {
  const nowDate = () => clock?.now?.() || new Date();

  return {
    async flush(input = 20) {
      const { limit, throwOnFailure } = typeof input === "number"
        ? { limit: input, throwOnFailure: false }
        : { limit: input?.limit ?? 20, throwOnFailure: Boolean(input?.throwOnFailure) };
      const now = nowDate();
      const rows = ops.dueOutbox(now.toISOString(), limit);
      let firstError = null;
      for (const row of rows) {
        try {
          const result = await send(row);
          ops.markOutboxSent(row.id, result?.externalId || "");
        } catch (error) {
          const delay = RETRY_SECONDS[Math.min(row.attempts, RETRY_SECONDS.length - 1)];
          const nextAttemptAt = new Date(now.getTime() + delay * 1000).toISOString();
          ops.markOutboxRetry(row.id, new Error(sanitizeError(error)), nextAttemptAt);
          firstError ||= error;
        }
      }
      if (throwOnFailure && firstError) throw firstError;
      return rows.length;
    },
  };
}
