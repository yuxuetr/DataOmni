import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, Copy, Loader2, Save, SquarePen, X } from 'lucide-react';
import { clsx } from 'clsx';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import type { ConnectionProfile } from '../contracts';
import type { TranslationKey, TranslationParams } from '../i18n/translate';
import { useAppStore } from '../stores/appStore';
import { useConnectionStore } from '../stores/connectionStore';
import { useLanguageStore } from '../stores/languageStore';
import type { SchemaMetadataQueries } from '../utils/catalogQueries';
import { openDatabase, type DatabaseHandle } from '../utils/databaseHandle';
import { describeError } from '../utils/describeError';
import { tableKey, type ErTable } from '../utils/erLayout';
import { diffSchemas, schemaDiffDialectFor, type SchemaDiff, type SchemaDiffDialect, type SchemaDifference } from '../utils/schemaDiff';
import { listTables, loadSchemaSnapshot, readNativeDdl, schemasOf, type ErDiagramQueries } from '../utils/schemaSnapshot';
import { buildSyncScript, defaultSelection, isSyncable, renderSyncScript } from '../utils/schemaSync';
import { isImeKeyEvent } from '../utils/shortcuts';
import { columnDefaultSql } from '../utils/tableDdl';
import { SegmentedControl } from './FormControls';
import { HighlightedCode } from './HighlightedCode';

type Translate = (key: TranslationKey, params?: TranslationParams) => string;

interface SchemaCompareDialogProps {
  /** 当前连接：脚本只能在它上面经编辑器执行 */
  current: ConnectionProfile;
  currentHandle: DatabaseHandle;
  /** 把脚本放进当前连接的新 SQL 标签；没有编辑器的场合不给 */
  onOpenSql?: (sql: string, title: string) => void;
  onClose: () => void;
}

/** 一侧：句柄、读到的表，以及关它的办法（借用当前连接的句柄时不关） */
interface Side {
  profile: ConnectionProfile;
  dialect: SchemaDiffDialect;
  handle: DatabaseHandle;
  release: () => Promise<void>;
  tables: ErTable[];
  metadata: SchemaMetadataQueries;
}

interface Result {
  diff: SchemaDiff;
  source: Side;
  target: Side;
  targetIsCurrent: boolean;
  serverVersion: string | null;
  nativeDdl: Map<string, string | { error: string }>;
}

/**
 * 两个库的结构比对（rfcs/schema-diff.md）。比对与出脚本都是纯函数，这里只管开第二个连接、读两边、
 * 勾选与预览。**不执行**：目标是当前连接时把脚本放进编辑器，由用户自己跑，照常走环境确认（用户 2026-11-05 定）
 */
export function SchemaCompareDialog({ current, currentHandle, onOpenSql, onClose }: SchemaCompareDialogProps) {
  const t = useLanguageStore((state) => state.t);
  const connections = useConnectionStore((state) => state.connections);
  const activeConnectionString = useAppStore((state) => state.activeConnection?.connectionString ?? null);
  const candidates = useMemo(
    () => connections.filter((profile) => schemaDiffDialectFor(profile.db_type) !== null),
    [connections]
  );
  const [otherId, setOtherId] = useState(() => candidates.find((profile) => profile.id !== current.id)?.id ?? '');
  const [intoCurrent, setIntoCurrent] = useState(true);
  const [schemas, setSchemas] = useState<{ current: string | null; other: string | null }>({ current: null, other: null });
  const [sides, setSides] = useState<{ current: Side; other: Side } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  // 卸载时要关掉另开的那个句柄；state 在清理函数里读不到最新值
  const opened = useRef<Side | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    return () => {
      void opened.current?.release();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isImeKeyEvent(event)) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const openSide = async (profile: ConnectionProfile, isCurrent: boolean): Promise<Side> => {
    const dialect = schemaDiffDialectFor(profile.db_type);
    if (!dialect) throw new Error(profile.db_type);
    let handle = currentHandle;
    let release = async () => {};
    if (!isCurrent) {
      // 与连接时同一步：读钥匙串、建隧道、拿到连接串
      const connectionString = await invoke<string>('test_connection', { config: profile });
      // 两份配置算出同一个串时池子是同一个，关它就把当前连接的也关了：借用，不关
      if (connectionString !== activeConnectionString) {
        const own = await openDatabase(connectionString);
        handle = own;
        release = async () => {
          await own.close().catch(() => false);
        };
      }
    }
    const [er, metadata] = await Promise.all([
      invoke<ErDiagramQueries>('get_er_diagram_queries', { dbType: profile.db_type }),
      invoke<SchemaMetadataQueries>('get_schema_metadata_queries', { dbType: profile.db_type })
    ]);
    const select = (sql: string, params: unknown[]) => handle.select(sql, params);
    const tables = await listTables(select, er, profile.database ?? null);
    return { profile, dialect, handle, release, tables, metadata };
  };

  const run = async () => {
    const other = candidates.find((profile) => profile.id === otherId);
    if (!other) return;
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      let both = sides;
      if (!both || both.other.profile.id !== other.id) {
        await opened.current?.release();
        opened.current = null;
        const currentSide = both?.current ?? await openSide(current, true);
        const otherSide = await openSide(other, other.id === current.id);
        opened.current = otherSide;
        both = { current: currentSide, other: otherSide };
        setSides(both);
      }
      const load = (side: Side, schema: string | null) => loadSchemaSnapshot({
        select: (sql, params) => side.handle.select(sql, params),
        metadata: side.metadata,
        dialect: side.dialect,
        tables: side.tables,
        schema: schemasOf(side.tables).includes(schema ?? '') ? schema : null
      });
      const [currentSnapshot, otherSnapshot] = await Promise.all([load(both.current, schemas.current), load(both.other, schemas.other)]);
      const [source, target] = intoCurrent ? [both.other, both.current] : [both.current, both.other];
      const diff = intoCurrent ? diffSchemas(otherSnapshot, currentSnapshot) : diffSchemas(currentSnapshot, otherSnapshot);
      let nativeDdl = new Map<string, string | { error: string }>();
      let serverVersion: string | null = null;
      if (diff.sameDialect) {
        nativeDdl = await readNativeDdl({
          select: (sql, params) => source.handle.select(sql, params),
          metadata: source.metadata,
          dialect: source.dialect,
          diff,
          t
        });
        // MySQL 系认 TiDB / OceanBase、旧版本，PostgreSQL 系认 CockroachDB：改列的写法跟着变（同结构编辑）
        if (target.dialect === 'mysql' || target.dialect === 'postgresql') {
          const rows = await target.handle.select<Array<Record<string, unknown>>>('SELECT VERSION() AS version').catch(() => []);
          serverVersion = Array.isArray(rows) && rows[0] ? String(rows[0].version ?? '') : null;
        }
      }
      setResult({ diff, source, target, targetIsCurrent: target === both.current, serverVersion, nativeDdl });
      setSelected(defaultSelection(diff));
    } catch (cause) {
      setError(describeError(cause, t('schemaCompare.loadFailed')));
    } finally {
      setLoading(false);
    }
  };

  const plan = useMemo(() => {
    if (!result || !result.diff.sameDialect) return null;
    return buildSyncScript(result.diff, selected, {
      dialect: result.target.dialect,
      serverVersion: result.serverVersion,
      nativeDdl: result.nativeDdl,
      t
    });
  }, [result, selected, t]);

  const script = useMemo(() => {
    if (!result || !plan || plan.statements.length === 0) return '';
    const name = (side: Side) => (side.profile.database ? `${side.profile.name} / ${side.profile.database.split(/[\\/]/).pop()}` : side.profile.name);
    const header = `-- ${t('schemaCompare.scriptHeader', { target: name(result.target), source: name(result.source) })}`;
    return `${header}\n\n${renderSyncScript(plan.statements)}\n`;
  }, [result, plan, t]);

  const groups = useMemo(() => {
    const byTable = new Map<string, Array<{ index: number; difference: SchemaDifference }>>();
    result?.diff.differences.forEach((difference, index) => {
      const table = difference.table.target ?? difference.table.source;
      const key = table ? tableKey(table) : '';
      byTable.set(key, [...(byTable.get(key) ?? []), { index, difference }]);
    });
    return [...byTable.entries()];
  }, [result]);

  const toggle = (indexes: number[], on: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const index of indexes) {
        if (on) next.add(index);
        else next.delete(index);
      }
      return next;
    });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(script);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (cause) {
      setStatus({ kind: 'error', text: describeError(cause, t('common.copyFailed')) });
    }
  };

  const saveScript = async () => {
    setStatus(null);
    try {
      const path = await save({ defaultPath: 'sync.sql', filters: [{ name: 'SQL', extensions: ['sql'] }] });
      if (!path) return;
      await invoke('write_text_file', { path, contents: script });
      setStatus({ kind: 'ok', text: t('schemaCompare.saved', { path }) });
    } catch (cause) {
      setStatus({ kind: 'error', text: describeError(cause, t('schemaCompare.saveFailed')) });
    }
  };

  const otherProfile = candidates.find((profile) => profile.id === otherId) ?? null;
  const schemaPicker = (which: 'current' | 'other', side: Side | undefined) => {
    const names = side ? schemasOf(side.tables) : [];
    if (names.length < 2 || !side) return null;
    return (
      <select
        value={schemas[which] ?? ''}
        onChange={(event) => setSchemas((previous) => ({ ...previous, [which]: event.target.value || null }))}
        aria-label={t('schemaCompare.schemaOf', { connection: side.profile.name })}
        className="rounded-control border border-line bg-surface px-1.5 py-1 text-xs text-fg"
      >
        <option value="">{`${side.profile.name}: ${t('schemaCompare.allSchemas')}`}</option>
        {names.map((name) => (
          <option key={name} value={name}>{`${side.profile.name}: ${name}`}</option>
        ))}
      </select>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="schema-compare-title"
      onClick={onClose}
    >
      <div
        className="flex h-[calc(100vh-4rem)] w-[1100px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-panel bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <h2 id="schema-compare-title" className="shrink-0 text-sm font-medium text-fg">{t('schemaCompare.title')}</h2>
          {result && (
            <span className="flex min-w-0 items-center gap-1 truncate text-xs text-fg-subtle">
              {t('schemaCompare.direction', { source: result.source.profile.name, target: result.target.profile.name })}
            </span>
          )}
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="ml-auto rounded-control p-1 text-fg-muted hover:bg-surface-hover"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-2">
          {candidates.length === 0 ? (
            <span className="text-xs text-fg-subtle">{t('schemaCompare.noCandidates')}</span>
          ) : (
            <>
              <select
                value={otherId}
                onChange={(event) => setOtherId(event.target.value)}
                aria-label={t('schemaCompare.other')}
                className="max-w-56 rounded-control border border-line bg-surface px-1.5 py-1 text-xs text-fg"
              >
                <option value="" disabled>{t('schemaCompare.choose')}</option>
                {candidates.map((profile) => (
                  <option key={profile.id} value={profile.id}>{profile.name}</option>
                ))}
              </select>
              <SegmentedControl
                value={intoCurrent ? 'into' : 'from'}
                options={[
                  { value: 'into', label: t('schemaCompare.intoCurrent') },
                  { value: 'from', label: t('schemaCompare.fromCurrent') }
                ]}
                onChange={(value) => setIntoCurrent(value === 'into')}
              />
              {schemaPicker('current', sides?.current)}
              {sides?.other.profile.id === otherId && schemaPicker('other', sides.other)}
              <button
                type="button"
                disabled={!otherProfile || loading}
                onClick={() => void run()}
                className="flex items-center gap-1 rounded-control bg-accent px-3 py-1 text-xs text-fg-on-accent hover:opacity-90 disabled:opacity-50"
              >
                {loading ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />}
                {t('schemaCompare.run')}
              </button>
            </>
          )}
        </div>

        {status && (
          <p className={clsx('border-b border-line px-5 py-1.5 text-xs break-words', status.kind === 'ok' ? 'text-success' : 'text-danger')}>
            {status.text}
          </p>
        )}

        <div className="flex min-h-0 flex-1">
          <div className="w-[46%] shrink-0 overflow-auto border-r border-line px-5 py-3">
            {loading && (
              <p className="flex items-center gap-2 text-xs text-fg-subtle">
                <Loader2 size={14} className="animate-spin" />
                {t('schemaCompare.loading')}
              </p>
            )}
            {error && <p className="break-words text-xs text-danger">{error}</p>}
            {result && !loading && (
              <>
                {!result.diff.sameDialect && <p className="mb-2 text-xs text-warning">{t('schemaCompare.crossDialect')}</p>}
                {result.diff.differences.length === 0 && <p className="mb-2 text-xs text-fg">{t('schemaCompare.same')}</p>}
                {groups.map(([table, items]) => {
                  const syncable = items.filter((item) => result.diff.sameDialect && isSyncable(item.difference)).map((item) => item.index);
                  const allOn = syncable.length > 0 && syncable.every((index) => selected.has(index));
                  return (
                    <section key={table} className="mb-3">
                      <label className="flex items-center gap-2 text-xs font-medium text-fg">
                        {syncable.length > 0 && (
                          <input type="checkbox" checked={allOn} onChange={(event) => toggle(syncable, event.target.checked)} className="accent-accent" />
                        )}
                        <span className="font-mono">{table}</span>
                      </label>
                      <ul className="mt-1 space-y-0.5 pl-5">
                        {items.map(({ index, difference }) => {
                          const canSync = result.diff.sameDialect && isSyncable(difference);
                          return (
                            <li key={index}>
                              <label className={clsx('flex items-start gap-2 text-xs', canSync ? 'cursor-pointer text-fg' : 'text-fg-muted')}>
                                {canSync ? (
                                  <input
                                    type="checkbox"
                                    checked={selected.has(index)}
                                    onChange={(event) => toggle([index], event.target.checked)}
                                    className="mt-0.5 accent-accent"
                                  />
                                ) : (
                                  <span className="w-[13px] shrink-0" />
                                )}
                                <span className={clsx('min-w-0 break-words', isRemoval(difference) && 'text-danger')}>
                                  {describeDifference(difference, result.target.dialect, t)}
                                  {result.diff.sameDialect && !isSyncable(difference) && (
                                    <span className="text-fg-subtle">{t('schemaCompare.reportOnly')}</span>
                                  )}
                                </span>
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  );
                })}
                <p className="mt-3 text-xs text-fg-subtle">{t('schemaCompare.notCompared')}</p>
              </>
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            {plan && (
              <>
                <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-2">
                  <span className="text-xs font-medium text-fg">{t('schemaCompare.script')}</span>
                  {script && (
                    <div className="ml-auto flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void copy()}
                        className="flex items-center gap-1 rounded-control border border-line-strong px-2 py-1 text-xs text-fg hover:bg-surface-hover"
                      >
                        {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                        {copied ? t('common.copied') : t('schemaCompare.copy')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void saveScript()}
                        className="flex items-center gap-1 rounded-control border border-line-strong px-2 py-1 text-xs text-fg hover:bg-surface-hover"
                      >
                        <Save size={12} />
                        {t('schemaCompare.save')}
                      </button>
                      {result?.targetIsCurrent && onOpenSql && (
                        <button
                          type="button"
                          title={t('schemaCompare.openInEditorHint')}
                          onClick={() => {
                            onOpenSql(script, t('schemaCompare.editorTitle', { target: result.target.profile.name }));
                            onClose();
                          }}
                          className="flex items-center gap-1 rounded-control bg-accent px-2 py-1 text-xs text-fg-on-accent hover:opacity-90"
                        >
                          <SquarePen size={12} />
                          {t('schemaCompare.openInEditor')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {result && !result.targetIsCurrent && script && (
                  <p className="border-b border-line px-5 py-1.5 text-xs text-fg-subtle">{t('schemaCompare.targetNotCurrent')}</p>
                )}
                {plan.impacts.length > 0 && (
                  <div className="border-b border-line bg-danger-soft px-5 py-2 text-xs text-fg">
                    <p className="font-medium text-danger">{t('schemaCompare.impacts')}</p>
                    <ul className="mt-1 list-disc pl-4">
                      {plan.impacts.map((impact, index) => (
                        <li key={index} className="font-mono">
                          {impact.kind === 'drop-table'
                            ? t('schemaCompare.impact.dropTable', { table: impact.table })
                            : t('schemaCompare.impact.dropColumn', { table: impact.table, column: impact.column ?? '' })}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {plan.refusals.length > 0 && (
                  <div className="max-h-32 overflow-auto border-b border-line bg-warning-soft px-5 py-2 text-xs text-fg">
                    <p className="font-medium">{t('schemaCompare.refusals')}</p>
                    <ul className="mt-1 list-disc pl-4">
                      {plan.refusals.map((refusal, index) => (
                        <li key={index} className="break-words">
                          {t('schemaCompare.refusalLine', {
                            subject: [refusal.table, refusal.subject].filter(Boolean).join('.'),
                            reason: t(refusal.reason, refusal.params)
                          })}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="min-h-0 flex-1 overflow-auto px-5 py-3">
                  {script ? (
                    <pre className="select-text whitespace-pre font-mono text-xs leading-5 text-fg">
                      <HighlightedCode code={script} language="sql" />
                    </pre>
                  ) : (
                    result && result.diff.differences.length > 0 && <p className="text-xs text-fg-subtle">{t('schemaCompare.nothingSelected')}</p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function isRemoval(difference: SchemaDifference): boolean {
  return difference.kind === 'table-removed' || difference.kind === 'column-removed';
}

/** 一项差异的说法：都按「目标要怎么改」说 */
function describeDifference(difference: SchemaDifference, dialect: SchemaDiffDialect, t: Translate): string {
  const list = (items: ReadonlyArray<string | null>) => items.map((item) => item ?? '?').join(', ');
  switch (difference.kind) {
    case 'table-added':
      return t('schemaCompare.diff.tableAdded');
    case 'table-removed':
      return t('schemaCompare.diff.tableRemoved');
    case 'column-added':
      return t('schemaCompare.diff.columnAdded', { column: difference.column.name, type: difference.column.data_type });
    case 'column-removed':
      return t('schemaCompare.diff.columnRemoved', { column: difference.column.name });
    case 'column-changed': {
      const none = t('schemaCompare.diff.none');
      const changes = difference.changes.map((change) => {
        if (change === 'type') return t('schemaCompare.diff.type', { from: difference.target.data_type, to: difference.source.data_type });
        if (change === 'nullable') return t(difference.source.is_nullable ? 'schemaCompare.diff.nullable' : 'schemaCompare.diff.notNull');
        return t('schemaCompare.diff.default', {
          from: columnDefaultSql(difference.target, dialect) ?? none,
          to: columnDefaultSql(difference.source, dialect) ?? none
        });
      });
      return t('schemaCompare.diff.columnChanged', { column: difference.source.name, changes: changes.join('; ') });
    }
    case 'primary-key-changed':
      return t('schemaCompare.diff.primaryKey', {
        target: `(${list(difference.target)})`,
        source: `(${list(difference.source)})`
      });
    case 'index-added':
      return t(difference.index.isUnique ? 'schemaCompare.diff.uniqueIndexAdded' : 'schemaCompare.diff.indexAdded', {
        index: difference.index.name,
        columns: list(difference.index.columns)
      });
    case 'index-removed':
      return t('schemaCompare.diff.indexRemoved', { index: difference.index.name, columns: list(difference.index.columns) });
    case 'foreign-key-added':
    case 'foreign-key-removed':
      return t(difference.kind === 'foreign-key-added' ? 'schemaCompare.diff.foreignKeyAdded' : 'schemaCompare.diff.foreignKeyRemoved', {
        name: difference.foreignKey.name,
        columns: list(difference.foreignKey.columns),
        target: `${difference.foreignKey.referencedTable}(${list(difference.foreignKey.referencedColumns)})`
      });
  }
}
