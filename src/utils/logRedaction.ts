const SENSITIVE_KEY_PATTERN = /^(password|passwd|pwd|token|access_token|refresh_token|api_key|apikey|secret|authorization|cookie)$/i;
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/[^:/\s?#]+:)([^@\s/?#]*)(@)/gi;
const QUERY_SECRET_PATTERN = /([?&](?:password|passwd|pwd|token|access_token|refresh_token|api_key|apikey|secret)=)[^&#\s]*/gi;
const BEARER_TOKEN_PATTERN = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const KEY_VALUE_SECRET_PATTERN = /(["']?(?:password|passwd|pwd|token|access_token|refresh_token|api_key|apikey|secret|authorization|cookie)["']?\s*[:=]\s*["']?)([^"',\s}&#]+)/gi;

type ConsoleMethod = 'debug' | 'error' | 'info' | 'log' | 'warn';

let installed = false;

export function redactSensitiveText(value: string): string {
  return value
    .replace(URL_CREDENTIAL_PATTERN, '$1***$3')
    .replace(QUERY_SECRET_PATTERN, '$1***')
    .replace(BEARER_TOKEN_PATTERN, '$1 ***')
    .replace(KEY_VALUE_SECRET_PATTERN, '$1***');
}

export function redactLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSensitiveText(value.message),
      stack: value.stack ? redactSensitiveText(value.stack) : undefined
    };
  }

  if (value instanceof URL) {
    return redactSensitiveText(value.toString());
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactLogValue(item, seen));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return value;
  }

  seen.add(value);
  const redacted = Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? '***' : redactLogValue(nestedValue, seen)
    ])
  );
  seen.delete(value);
  return redacted;
}

export function installConsoleRedaction(): void {
  if (installed) {
    return;
  }

  installed = true;
  const methods: ConsoleMethod[] = ['debug', 'error', 'info', 'log', 'warn'];

  for (const method of methods) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args.map((argument) => redactLogValue(argument)));
    };
  }
}
