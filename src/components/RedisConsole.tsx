import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { PLAIN_TEXT_INPUT } from './FormControls';
import { useConfirmPrompt } from './ConfirmPrompt';
import { useLanguageStore } from '../stores/languageStore';
import { useQueryStore } from '../stores/queryStore';
import { describeError } from '../utils/describeError';
import {
  bytesToBase64,
  commandRisk,
  formatReply,
  splitCommandLine,
  type RedisReply
} from '../utils/redisCommandLine';

interface RedisConsoleProps {
  database: number;
  /** 跑成了一条：键列表与值可能跟着变了 */
  onRan: () => void;
}

interface ConsoleEntry {
  id: number;
  line: string;
  output: string;
  /** 没跑成（拆不开、被拒、断线）；服务端的错误回答不算，那是一条正常的回答 */
  failed: boolean;
}

/**
 * Redis 的命令行：一行一条命令，写法与 redis-cli 相同（引号、`\xHH`），回答也照它的样子画。
 * 跑在这个标签的库号上；切库用对象树（`SELECT` 在这里会被拒——连接是各处共用的）
 */
export function RedisConsole({ database, onRan }: RedisConsoleProps) {
  const t = useLanguageStore((state) => state.t);
  const connectionString = useQueryStore((state) => state.connectionString);
  const timeoutMs = useQueryStore((state) => state.queryTimeoutMs);
  const { ask, prompt } = useConfirmPrompt();
  const [line, setLine] = useState('');
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [running, setRunning] = useState(false);
  // ↑ ↓ 翻的是跑过的命令；-1 是正在写的这一行
  const [historyIndex, setHistoryIndex] = useState(-1);
  const nextId = useRef(0);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [entries]);

  const record = (entry: Omit<ConsoleEntry, 'id'>) => {
    const id = nextId.current;
    nextId.current += 1;
    setEntries((previous) => [...previous, { id, ...entry }]);
  };

  const run = async () => {
    const text = line.trim();
    if (!text || running || !connectionString) return;
    const split = splitCommandLine(text);
    setHistoryIndex(-1);
    if (!split.ok) {
      record({ line: text, output: t(`redis.console.${split.error}`), failed: true });
      setLine('');
      return;
    }
    const risk = commandRisk(split.args);
    if (risk) {
      const confirmed = await ask({
        title: t('redis.console.confirmTitle'),
        message: t(`redis.console.risk.${risk}`, { command: text, database: `db${database}` }),
        confirmLabel: t('redis.console.run'),
        destructive: true
      });
      if (!confirmed) return;
    }
    setRunning(true);
    try {
      const reply = await invoke<RedisReply>('redis_execute', {
        connectionString,
        database,
        arguments: split.args.map(bytesToBase64),
        timeoutMs
      });
      record({ line: text, output: formatReply(reply), failed: false });
      setLine('');
      onRan();
    } catch (caught) {
      record({ line: text, output: describeError(caught), failed: true });
    } finally {
      setRunning(false);
    }
  };

  const typed = entries.map((entry) => entry.line);
  const recall = (step: 1 | -1) => {
    if (typed.length === 0) return;
    const next = historyIndex === -1
      ? (step === -1 ? typed.length - 1 : -1)
      : historyIndex + step;
    if (next < -1 || next >= typed.length) return;
    setHistoryIndex(next);
    setLine(next === -1 ? '' : typed[next]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={outputRef} className="min-h-0 flex-1 overflow-y-auto bg-surface-sunken px-4 py-3 font-mono text-[13px]">
        {entries.length === 0 && <p className="font-sans text-sm text-fg-muted">{t('redis.console.intro')}</p>}
        {entries.map((entry) => (
          <div key={entry.id} className="mb-3">
            <p className="select-text text-fg-muted">{`db${database}> ${entry.line}`}</p>
            <pre className={clsx('select-text whitespace-pre-wrap break-all', entry.failed ? 'text-danger' : 'text-fg')}>
              {entry.output}
            </pre>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-line px-4 py-2">
        <span className="shrink-0 font-mono text-[13px] text-fg-muted">{`db${database}>`}</span>
        <input
          value={line}
          onChange={(event) => {
            setLine(event.target.value);
            setHistoryIndex(-1);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void run();
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              recall(-1);
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              recall(1);
            }
          }}
          aria-label={t('redis.console.input')}
          placeholder="GET user:1"
          className="min-w-0 flex-1 rounded-control border border-line-strong bg-surface px-2 py-1 font-mono text-[13px] text-fg outline-none placeholder:text-fg-subtle focus:ring-2 focus:ring-accent"
          {...PLAIN_TEXT_INPUT}
        />
        {running && <Loader2 size={14} className="shrink-0 animate-spin text-fg-muted" />}
      </div>
      {prompt}
    </div>
  );
}
