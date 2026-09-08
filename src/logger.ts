type Level = "debug" | "info" | "warn" | "error";

const REDACT_KEYS = /key|token|authorization|secret|password/i;

function sanitize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        REDACT_KEYS.test(key) ? "[REDACTED]" : sanitize(item)
      ])
    );
  }
  return value;
}

function write(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  if (process.env.VITEST === "true") return;
  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...sanitize(fields) as Record<string, unknown>
  });
  if (level === "error") process.stderr.write(`${record}\n`);
  else process.stdout.write(`${record}\n`);
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => write("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields)
};
