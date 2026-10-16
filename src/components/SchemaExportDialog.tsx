import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { Loader2, Search, X } from 'lucide-react';
import { PLAIN_TEXT_INPUT } from './FormControls';
import { useQueryStore } from '../stores/queryStore';
import { useLanguageStore } from '../stores/languageStore';
import type { ConnectionProfile } from '../contracts';
import { describeError } from '../utils/describeError';
import { requireDatabase } from '../utils/requireDatabase';
import { ddlRequest, type SchemaMetadataQueries } from '../utils/catalogQueries';
import { extractDdlStatements, joinDdlStatements } from '../utils/schemaObjects';
import { identifierDialectFor } from '../utils/sqlIdentifiers';
import { filterObjects, MAX_RENDERED_TREE_ITEMS, type DatabaseObject } from '../utils/databaseObjects';
import { tableKey, toErLinks, toErTables } from '../utils/erLayout';
import { buildDataDictionary } from '../utils/dataDictionary';
import { serverLabel } from '../utils/serverPresets';
import { buildDdlScript, dictionarySubset, mapWithConcurrency, type TableDdl } from '../utils/schemaExport';
import { isImeKeyEvent } from '../utils/shortcuts';

interface SchemaExportDialogProps {
  connection: ConnectionProfile;
  /** 对象树上「表」那一组 */
  tables: readonly DatabaseObject[];
  onClose: () => void;
}

type Format = 'sql' | 'markdown';

interface ErDiagramQueries {
  columns: string;
  foreign_keys: string;
  parameter_count: number;
}

/** 同时读几张表的建表语句，见 `mapWithConcurrency` */
const DDL_CONCURRENCY = 4;

/**
 * 勾一批表，一次导出它们的结构：建表语句（数据库自己给的原文）或数据字典。
 *
 * 列表和对象树守同一个上限（`MAX_RENDERED_TREE_ITEMS`）：三百张表的库里靠筛选找，
 * 不靠滚。「全选」按筛选结果选，包括没画出来的那些——画多少是渲染的事，选多少是人的事。
 */
export function SchemaExportDialog({ connection, tables, onClose }: SchemaExportDialogProps) {
  const t = useLanguageStore((state) => state.t);
  const { database } = useQueryStore();
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [format, setFormat] = useState<Format>('sql');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ path: string; count: number; failed: Array<{ key: string; error: string }> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = progress !== null;

  const matching = useMemo(() => filterObjects(tables, filter), [tables, filter]);
  const shown = matching.slice(0, MAX_RENDERED_TREE_ITEMS);
  const hidden = matching.length - shown.length;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isImeKeyEvent(event) && !running) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [running, onClose]);

  const toggle = (key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const selectMatching = () => {
    setSelected((current) => new Set([...current, ...matching.map(tableKey)]));
  };

  const run = async () => {
    // 次序跟着树走，不跟着点选的先后
    const chosen = tables.filter((table) => selected.has(tableKey(table)));
    if (chosen.length === 0 || running) {
      return;
    }
    const databaseName = connection.database ?? chosen[0].schema ?? '';
    const date = localDate(new Date());
    const path = await save({
      defaultPath: `${databaseName || connection.name}-schema-${date}.${format === 'sql' ? 'sql' : 'md'}`,
      filters: format === 'sql'
        ? [{ name: 'SQL', extensions: ['sql'] }]
        : [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (!path) {
      return;
    }

    setError(null);
    setResult(null);
    setProgress({ done: 0, total: chosen.length });
    try {
      const select = (sql: string, params: unknown[]) => requireDatabase(database).select(sql, params);
      if (format === 'sql') {
        const metadata = await invoke<SchemaMetadataQueries>('get_schema_metadata_queries', {
          dbType: connection.db_type
        });
        const ddl = metadata.ddl;
        if (!ddl) {
          throw new Error(t('schemaExport.failed'));
        }
        let done = 0;
        const read = await mapWithConcurrency(chosen, DDL_CONCURRENCY, async (table): Promise<TableDdl> => {
          const key = tableKey(table);
          try {
            const request = ddlRequest(ddl, metadata.parameter_count, table.name, table.schema, identifierDialectFor(connection.db_type));
            const rows = await select(request.sql, request.params);
            const text = joinDdlStatements(extractDdlStatements(Array.isArray(rows) ? rows : []));
            return text ? { key, ddl: text } : { key, error: t('objectDefinition.empty') };
          } catch (cause) {
            return { key, error: describeError(cause, t('objectDefinition.readFailed')) };
          } finally {
            done += 1;
            setProgress({ done, total: chosen.length });
          }
        });
        const contents = buildDdlScript({ title: connection.name, database: databaseName, date, tables: read }, t);
        await invoke('write_text_file', { path, contents });
        const failed = read.flatMap((entry) => ('error' in entry ? [entry] : []));
        setResult({ path, count: read.length - failed.length, failed });
        return;
      }

      // 数据字典：整库的列与外键一次读两条，再挑出选中的表——比逐表查快得多
      const queries = await invoke<ErDiagramQueries>('get_er_diagram_queries', { dbType: connection.db_type });
      const params = Array.from({ length: queries.parameter_count }, () => databaseName);
      const [columnRows, linkRows] = await Promise.all([
        select(queries.columns, params),
        select(queries.foreign_keys, params)
      ]);
      const subset = dictionarySubset(
        toErTables(Array.isArray(columnRows) ? columnRows : []),
        toErLinks(Array.isArray(linkRows) ? linkRows : []),
        new Set(chosen.map(tableKey))
      );
      const contents = buildDataDictionary({
        title: connection.name,
        dialect: serverLabel(connection),
        origin: 'catalog',
        tables: subset.tables,
        links: subset.links,
        date
      }, t);
      await invoke('write_text_file', { path, contents });
      setResult({ path, count: subset.tables.length, failed: [] });
    } catch (cause) {
      setError(describeError(cause, t('schemaExport.failed')));
    } finally {
      setProgress(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="schema-export-title"
      onClick={() => !running && onClose()}
    >
      <div
        className="flex max-h-[calc(100vh-4rem)] w-[560px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-panel bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 id="schema-export-title" className="text-base font-medium text-fg">
            {t('schemaExport.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="rounded-control p-1 text-fg-muted hover:bg-surface-hover hover:text-fg"
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-line px-5 py-2">
          <Search size={13} className="shrink-0 text-fg-subtle" />
          <input
            type="text"
            value={filter}
            autoFocus
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t('schemaExport.filter')}
            aria-label={t('schemaExport.filter')}
            className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
            {...PLAIN_TEXT_INPUT}
          />
          <button
            type="button"
            onClick={selectMatching}
            disabled={running || matching.length === 0}
            className="shrink-0 rounded-control px-2 py-1 text-xs text-accent hover:bg-surface-hover disabled:opacity-40"
          >
            {t('schemaExport.selectAll', { count: matching.length })}
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            disabled={running || selected.size === 0}
            className="shrink-0 rounded-control px-2 py-1 text-xs text-fg-muted hover:bg-surface-hover disabled:opacity-40"
          >
            {t('schemaExport.clear')}
          </button>
        </div>

        <ul className="min-h-[120px] flex-1 overflow-y-auto px-3 py-2" aria-label={t('schemaExport.title')}>
          {shown.map((table) => {
            const key = tableKey(table);
            return (
              <li key={key}>
                <label className="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1 text-sm text-fg hover:bg-surface-hover">
                  <input
                    type="checkbox"
                    checked={selected.has(key)}
                    disabled={running}
                    onChange={() => toggle(key)}
                  />
                  <span className="truncate font-mono text-xs">{table.name}</span>
                </label>
              </li>
            );
          })}
          {matching.length === 0 && (
            <li className="px-2 py-1 text-xs text-fg-subtle">{t('schemaExport.noMatch', { query: filter.trim() })}</li>
          )}
          {hidden > 0 && (
            <li className="px-2 py-1 text-xs text-fg-subtle">{t('schemaExport.hidden', { count: hidden })}</li>
          )}
        </ul>

        <div className="space-y-3 border-t border-line px-5 py-3">
          <div className="flex flex-wrap items-center gap-4 text-sm text-fg">
            <span className="text-xs text-fg-muted">{t('schemaExport.format')}</span>
            {(['sql', 'markdown'] as const).map((option) => (
              <label key={option} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="schema-export-format"
                  checked={format === option}
                  disabled={running}
                  onChange={() => setFormat(option)}
                />
                {t(option === 'sql' ? 'schemaExport.formatSql' : 'schemaExport.formatMarkdown')}
              </label>
            ))}
          </div>
          {format === 'markdown' && <p className="text-xs text-fg-subtle">{t('schemaExport.markdownNote')}</p>}

          {result && (
            <div className="select-text space-y-1 text-xs">
              <p className="break-all text-success">{t('schemaExport.done', { count: result.count, path: result.path })}</p>
              {result.failed.length > 0 && (
                <>
                  <p className="text-danger">{t('schemaExport.someFailed', { count: result.failed.length })}</p>
                  <ul className="max-h-24 overflow-y-auto font-mono text-danger">
                    {result.failed.map((entry) => <li key={entry.key} className="break-words">{entry.key}: {entry.error}</li>)}
                  </ul>
                </>
              )}
            </div>
          )}
          {error && <p className="select-text break-words text-sm text-danger">{error}</p>}

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-fg-muted">
              {progress
                ? t('schemaExport.progress', { done: progress.done, total: progress.total })
                : t('schemaExport.selected', { count: selected.size, total: tables.length })}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={running}
                className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
              >
                {t('common.close')}
              </button>
              <button
                type="button"
                onClick={() => void run()}
                disabled={selected.size === 0 || running}
                className="flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:opacity-90 disabled:opacity-50"
              >
                {running && <Loader2 size={14} className="animate-spin" />}
                {t('schemaExport.export')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 本地日期 `YYYY-MM-DD`，同 ER 图的导出：`toISOString` 是 UTC，东八区凌晨会标成前一天 */
function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
