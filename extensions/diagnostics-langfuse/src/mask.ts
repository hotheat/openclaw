const SENSITIVE_KEY_RE = /(?:api[_-]?key|secret|token|password|authorization|cookie|credential)/i;
const SECRET_TEXT_RE = /\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g;

export function maskSensitiveData(value: unknown, depth = 0): unknown {
  if (depth > 12) {
    return "[max-depth]";
  }
  if (typeof value === "string") {
    return value.replace(SECRET_TEXT_RE, "[redacted]");
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => maskSensitiveData(entry, depth + 1));
  }
  const masked: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    masked[key] = SENSITIVE_KEY_RE.test(key) ? "[redacted]" : maskSensitiveData(entry, depth + 1);
  }
  return masked;
}
