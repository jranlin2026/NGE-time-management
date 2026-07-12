const RETRY_SECONDS = [30, 120, 300, 900, 1800, 3600, 7200, 7200];

export function createOutboxWorker({ ops, send, clock }) {
  const nowDate = () => clock?.now?.() || new Date();

  return {
    async flush(limit = 20) {
      const now = nowDate();
      const rows = ops.dueOutbox(now.toISOString(), limit);
      for (const row of rows) {
        try {
          const result = await send(row);
          ops.markOutboxSent(row.id, result?.externalId || "");
        } catch (error) {
          const delay = RETRY_SECONDS[Math.min(row.attempts, RETRY_SECONDS.length - 1)];
          const nextAttemptAt = new Date(now.getTime() + delay * 1000).toISOString();
          ops.markOutboxRetry(row.id, sanitizeError(error), nextAttemptAt);
        }
      }
      return rows.length;
    },
  };
}

function sanitizeError(error) {
  const message = String(error?.message || error)
    .replace(/\bBearer\s+[^\s,]+/gi, "Bearer [redacted]")
    .replace(/(app_secret|token|webhook|authorization)\s*[:=]\s*[^\s,]+/gi, "$1=[redacted]")
    .slice(0, 500);
  return new Error(message);
}
