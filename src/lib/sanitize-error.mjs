export function sanitizeError(error) {
  return String(error?.message || error)
    .replace(/\bBearer\s+[^\s,]+/gi, "Bearer [redacted]")
    .replace(/\b(app_secret|token|webhook|authorization)\b\s*[:=]\s*[^\s,]+/gi, "$1=[redacted]")
    .slice(0, 500);
}
