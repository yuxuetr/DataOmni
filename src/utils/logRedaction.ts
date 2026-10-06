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

export type LogSink = (level: 'warn' | 'error', message: string) => void;

function formatForLog(argument: unknown): string {
  // Error 要栈；redactLogValue 会把它拆成普通对象，序列化出来的栈是一行转义的 \n
  if (argument instanceof Error) {
    return redactSensitiveText(argument.stack ?? `${argument.name}: ${argument.message}`);
  }
  const redacted = redactLogValue(argument);
  if (typeof redacted === 'string') {
    return redacted;
  }
  try {
    return JSON.stringify(redacted) ?? String(redacted);
  } catch {
    return String(redacted);
  }
}

/**
 * 把 `console.warn` / `console.error` 与没接住的异常送进日志文件。
 *
 * 打包版没有开发者工具，这些输出原先谁也看不到；而用户报缺陷时能带回来的只有日志文件。
 * 自己先脱敏，不依赖 `installConsoleRedaction` 装在里层还是外层。`log` / `info` 不送：
 * 那是开发时看的。返回撤销函数，测试用
 */
export function forwardLogs(sink: LogSink): () => void {
  const originalWarn = console.warn;
  const originalError = console.error;
  const send = (level: 'warn' | 'error', args: unknown[]) => {
    try {
      sink(level, args.map(formatForLog).join(' '));
    } catch {
      // 日志写不进去不该连累正在做的事
    }
  };
  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    send('warn', args);
  };
  console.error = (...args: unknown[]) => {
    originalError(...args);
    send('error', args);
  };
  const onError = (event: ErrorEvent) => send('error', [event.error ?? event.message]);
  const onRejection = (event: PromiseRejectionEvent) => send('error', ['unhandled rejection', event.reason]);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    console.warn = originalWarn;
    console.error = originalError;
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
