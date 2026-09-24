import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { clsx } from 'clsx';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  RefreshCw,
  Search,
  X
} from 'lucide-react';
import { useQueryStore } from '../stores/queryStore';
import { useLanguageStore } from '../stores/languageStore';
import { describeError } from '../utils/describeError';
import { measureColumnWidths } from '../utils/columnWidths';
import { GRID_PAGE_SIZE_OPTIONS } from '../utils/gridPagination';
import {
  mongoColumnAlignment,
  mongoColumns,
  mongoPageRange,
  type MongoFindPage,
  type MongoValueKind
} from '../utils/mongoDocuments';
import { PLAIN_TEXT_INPUT } from './FormControls';

interface MongoCollectionViewerProps {
  database: string;
  collection: string;
}

interface AppliedQuery {
  filter: string;
  sort: string;
}

/** 值的颜色按类型分：一眼分得出 `'41'`（字符串）和 `Long('41')` */
const KIND_CLASS: Record<MongoValueKind, string> = {
  double: 'text-fg',
  int: 'text-fg',
  long: 'text-fg',
  decimal: 'text-fg',
  string: 'text-fg',
  bool: 'text-warning',
  null: 'italic text-fg-subtle',
  objectId: 'text-accent',
  date: 'text-success',
  document: 'text-fg-muted',
  array: 'text-fg-muted',
  binary: 'text-fg-muted',
  other: 'text-fg-muted'
};

/**
 * MongoDB 集合的浏览页：条件、排序、分页，点一行在右边看整个文档。
 *
 * 不复用 `TableDataViewer`：那一张是「行 × 列 + 按主键写回」，而这里一页文档的列
 * 是现算出来的并集、缺字段和 `null` 是两回事、值是 mongosh 写法的文字。硬塞进去
 * 就得在那张 1800 行的组件里到处加「如果是 MongoDB」。
 */
export function MongoCollectionViewer({ database, collection }: MongoCollectionViewerProps) {
  const t = useLanguageStore((state) => state.t);
  const connectionString = useQueryStore((state) => state.connectionString);
  const [filterDraft, setFilterDraft] = useState('');
  const [sortDraft, setSortDraft] = useState('');
  const [applied, setApplied] = useState<AppliedQuery>({ filter: '', sort: '' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(50);
  const [result, setResult] = useState<MongoFindPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [countError, setCountError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [documentText, setDocumentText] = useState<string | null>(null);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [documentError, setDocumentError] = useState<string | null>(null);
  // 晚到的响应不许覆盖新的：翻页快的时候前一页可能比后一页回来得晚
  const findRequest = useRef(0);
  const countRequest = useRef(0);
  const documentRequest = useRef(0);

  const timeoutMs = useQueryStore((state) => state.queryTimeoutMs);

  const load = useCallback(async (nextPage: number, query: AppliedQuery, size: number) => {
    if (!connectionString) {
      return;
    }
    const request = ++findRequest.current;
    setLoading(true);
    setError(null);
    try {
      const found = await invoke<MongoFindPage>('mongodb_find', {
        connectionString,
        database,
        collection,
        filter: query.filter,
        sort: query.sort,
        skip: (nextPage - 1) * size,
        limit: size,
        timeoutMs
      });
      if (request === findRequest.current) {
        setResult(found);
        setPage(nextPage);
      }
    } catch (cause) {
      if (request === findRequest.current) {
        // 上一次的结果不留：它是另一个条件下的文档，留在错误下面会被当成这次的
        setResult(null);
        setError(describeError(cause));
      }
    } finally {
      if (request === findRequest.current) {
        setLoading(false);
      }
    }
  }, [connectionString, database, collection, timeoutMs]);

  /** 总数另外数：大集合上带条件的精确计数可能很慢，不能挡着第一页 */
  const recount = useCallback(async (query: AppliedQuery) => {
    if (!connectionString) {
      return;
    }
    const request = ++countRequest.current;
    setCounting(true);
    setCountError(null);
    setTotal(null);
    try {
      const counted = await invoke<number>('mongodb_count', {
        connectionString,
        database,
        collection,
        filter: query.filter,
        timeoutMs
      });
      if (request === countRequest.current) {
        setTotal(counted);
      }
    } catch (cause) {
      if (request === countRequest.current) {
        setCountError(describeError(cause));
      }
    } finally {
      if (request === countRequest.current) {
        setCounting(false);
      }
    }
  }, [connectionString, database, collection, timeoutMs]);

  useEffect(() => {
    const initial = { filter: '', sort: '' };
    void load(1, initial, pageSize);
    void recount(initial);
    // 只在打开时跑一次；之后的每次查询由按钮与翻页触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionString, database, collection]);

  const applyQuery = () => {
    const query = { filter: filterDraft, sort: sortDraft };
    setApplied(query);
    setSelectedId(null);
    void load(1, query, pageSize);
    // 排序不改变总数；只动了排序时不重新数
    if (query.filter !== applied.filter || total === null) {
      void recount(query);
    }
  };

  const resetQuery = () => {
    setFilterDraft('');
    setSortDraft('');
    const query = { filter: '', sort: '' };
    setApplied(query);
    setSelectedId(null);
    void load(1, query, pageSize);
    void recount(query);
  };

  const refresh = () => {
    void load(page, applied, pageSize);
    void recount(applied);
    if (selectedId) {
      void openDocument(selectedId);
    }
  };

  const openDocument = async (id: string) => {
    if (!connectionString) {
      return;
    }
    const request = ++documentRequest.current;
    setSelectedId(id);
    setDocumentLoading(true);
    setDocumentError(null);
    try {
      const text = await invoke<string | null>('mongodb_document', {
        connectionString,
        database,
        collection,
        id,
        timeoutMs
      });
      if (request === documentRequest.current) {
        setDocumentText(text);
      }
    } catch (cause) {
      if (request === documentRequest.current) {
        setDocumentText(null);
        setDocumentError(describeError(cause));
      }
    } finally {
      if (request === documentRequest.current) {
        setDocumentLoading(false);
      }
    }
  };

  const documents = useMemo(() => result?.documents ?? [], [result]);
  const columns = useMemo(() => mongoColumns(documents), [documents]);
  const widths = useMemo(
    () => measureColumnWidths(
      columns,
      documents.map((document) => columns.map((column) => document.fields[column]?.text ?? ''))
    ),
    [columns, documents]
  );
  const alignments = useMemo(
    () => columns.map((column) => mongoColumnAlignment(documents, column)),
    [columns, documents]
  );
  const gridWidth = widths.reduce((sum, width) => sum + width, 0);
  const range = mongoPageRange(page, pageSize, documents.length, result?.has_more ?? false, total);

  const onQueryKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyQuery();
    }
  };

  const countLabel = counting
    ? t('mongo.counting')
    : total !== null
      ? t('mongo.count', { count: total })
      : '';

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center justify-between border-b bg-surface-sunken p-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-fg" title={`${database}.${collection}`}>
            {database}.{collection}
          </h2>
          <p className="mt-1 text-xs text-fg-muted">
            {countLabel}
            {/* 条件写错时计数也会失败，报的是同一句话；那句已经在条件栏下面了 */}
            {countError && !error && (
              <span className="text-danger" title={countError}>{t('mongo.countFailed', { reason: countError })}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            disabled={loading}
            className="flex items-center gap-1 rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg transition-colors hover:bg-surface-hover disabled:opacity-50"
            title={t('explorer.refresh')}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            <span>{t('explorer.refresh')}</span>
          </button>
          <span className="text-sm text-fg-muted">{t('table.pageSizeLabel')}</span>
          <select
            value={pageSize}
            onChange={(event) => {
              const size = Number(event.target.value);
              setPageSize(size);
              void load(1, applied, size);
            }}
            className="rounded-control border border-line-strong px-2 py-1 text-sm"
          >
            {GRID_PAGE_SIZE_OPTIONS.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </div>
      </div>

      {/* 条件栏：写法同 mongosh，回车即查 */}
      <div className="space-y-2 border-b border-line px-4 py-2">
        <div className="flex items-center gap-2">
          <label htmlFor="mongo-filter" className="w-12 shrink-0 text-xs font-medium text-fg-muted">
            {t('mongo.filter')}
          </label>
          <input
            id="mongo-filter"
            value={filterDraft}
            onChange={(event) => setFilterDraft(event.target.value)}
            onKeyDown={onQueryKeyDown}
            placeholder={t('mongo.filterPlaceholder')}
            className="min-w-0 flex-1 rounded-control border border-line-strong bg-surface px-2 py-1 font-mono text-[13px] text-fg outline-none placeholder:text-fg-subtle focus:ring-2 focus:ring-accent"
            {...PLAIN_TEXT_INPUT}
          />
          <button
            onClick={applyQuery}
            disabled={loading}
            className="flex items-center gap-1 rounded-control border border-accent-line px-3 py-1 text-sm text-accent transition-colors hover:bg-accent-soft disabled:opacity-50"
          >
            <Search size={14} />
            <span>{t('mongo.apply')}</span>
          </button>
          <button
            onClick={resetQuery}
            disabled={loading || (!filterDraft && !sortDraft && !applied.filter && !applied.sort)}
            className="rounded-control border border-line-strong px-3 py-1 text-sm text-fg-muted transition-colors hover:bg-surface-hover disabled:opacity-50"
          >
            {t('mongo.reset')}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="mongo-sort" className="w-12 shrink-0 text-xs font-medium text-fg-muted">
            {t('mongo.sort')}
          </label>
          <input
            id="mongo-sort"
            value={sortDraft}
            onChange={(event) => setSortDraft(event.target.value)}
            onKeyDown={onQueryKeyDown}
            placeholder={t('mongo.sortPlaceholder')}
            className="min-w-0 flex-1 rounded-control border border-line-strong bg-surface px-2 py-1 font-mono text-[13px] text-fg outline-none placeholder:text-fg-subtle focus:ring-2 focus:ring-accent"
            {...PLAIN_TEXT_INPUT}
          />
          <span className="shrink-0 text-xs text-fg-subtle">{t('mongo.syntaxHint')}</span>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 border-b border-danger-line bg-danger-soft px-4 py-2">
          <AlertCircle className="shrink-0 text-danger" size={14} />
          <span className="text-sm text-danger">{error}</span>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          {documents.length === 0 ? (
            <div className="flex h-full items-center justify-center text-fg-muted">
              {loading ? (
                <>
                  <RefreshCw className="animate-spin text-fg-subtle" size={20} />
                  <span className="ml-2">{t('mongo.loading')}</span>
                </>
              ) : error ? null : (
                t('mongo.empty')
              )}
            </div>
          ) : (
            <>
              {loading && (
                <div className="absolute inset-0 z-40 flex items-start justify-center bg-surface/60 pt-8">
                  <span className="flex items-center gap-2 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-fg-muted shadow">
                    <RefreshCw className="animate-spin text-fg-subtle" size={16} />
                    {t('mongo.loading')}
                  </span>
                </div>
              )}
              <div className="flex-1 overflow-auto">
                <table className="table-fixed border-collapse" style={{ width: `${gridWidth}px`, minWidth: '100%' }}>
                  <colgroup>
                    {widths.map((width, index) => (
                      <col key={columns[index]} style={{ width: `${width}px` }} />
                    ))}
                  </colgroup>
                  <thead className="sticky top-0 z-20 bg-surface-sunken">
                    <tr>
                      {columns.map((column) => (
                        <th
                          key={column}
                          className="border-b border-r border-line px-2 py-1 text-left text-xs font-medium text-fg"
                        >
                          <span className="block truncate" title={column}>{column}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line bg-surface">
                    {documents.map((document, rowIndex) => (
                      <tr
                        key={document.id ?? `row-${rowIndex}`}
                        onClick={() => {
                          if (document.id) {
                            void openDocument(document.id);
                          }
                        }}
                        title={document.id ? undefined : t('mongo.noId')}
                        className={clsx(
                          'hover:bg-surface-hover',
                          document.id ? 'cursor-pointer' : 'cursor-default',
                          document.id !== null && document.id === selectedId && 'bg-accent-soft'
                        )}
                      >
                        {columns.map((column, columnIndex) => {
                          const cell = document.fields[column];
                          return (
                            <td
                              key={column}
                              className={clsx(
                                'border-r border-line px-2 py-1 font-mono text-[13px]',
                                alignments[columnIndex] === 'right' && 'text-right'
                              )}
                            >
                              {cell ? (
                                <span
                                  className={clsx('block truncate', KIND_CLASS[cell.kind])}
                                  title={cell.truncated ? t('mongo.truncated') : cell.text}
                                >
                                  {cell.text}
                                </span>
                              ) : (
                                // 缺字段和 null 是两回事：null 是写进去的值，这里是这个文档根本没有这一项
                                <span className="block h-4" title={t('mongo.fieldMissing')} />
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {(range.hasPrevious || range.hasNext) && (
            <div className="flex items-center justify-between border-t bg-surface-sunken px-4 py-2">
              <span className="text-sm text-fg">
                {range.total !== null
                  ? t('mongo.range', { from: range.from, to: range.to, total: range.total })
                  : t('mongo.rangeOpen', { from: range.from, to: range.to })}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => void load(1, applied, pageSize)}
                  disabled={!range.hasPrevious || loading}
                  className="rounded-control p-1 hover:bg-surface-active disabled:opacity-50"
                >
                  <ChevronsLeft size={16} />
                </button>
                <button
                  onClick={() => void load(page - 1, applied, pageSize)}
                  disabled={!range.hasPrevious || loading}
                  className="rounded-control p-1 hover:bg-surface-active disabled:opacity-50"
                >
                  <ChevronLeft size={16} />
                </button>
                <span className="px-3 py-1 text-sm text-fg">
                  {range.lastPage !== null
                    ? t('result.pageOf', { total: range.lastPage, page })
                    : page}
                </span>
                <button
                  onClick={() => void load(page + 1, applied, pageSize)}
                  disabled={!range.hasNext || loading}
                  className="rounded-control p-1 hover:bg-surface-active disabled:opacity-50"
                >
                  <ChevronRight size={16} />
                </button>
                {/* 末页要知道总数；没数出来时这个按钮不出现，而不是跳到一个猜的页码 */}
                {range.lastPage !== null && (
                  <button
                    onClick={() => void load(range.lastPage ?? 1, applied, pageSize)}
                    disabled={!range.hasNext || loading}
                    className="rounded-control p-1 hover:bg-surface-active disabled:opacity-50"
                  >
                    <ChevronsRight size={16} />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {selectedId && (
          <aside className="flex w-[40%] min-w-72 max-w-[640px] flex-col border-l border-line bg-surface">
            <div className="flex items-center justify-between border-b border-line bg-surface-sunken px-3 py-2">
              <span className="truncate text-xs font-medium text-fg-muted" title={selectedId}>
                {t('mongo.document')} · {selectedId}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => {
                    if (documentText) {
                      void navigator.clipboard.writeText(documentText).catch((cause) => {
                        setDocumentError(describeError(cause, t('common.copyFailed')));
                      });
                    }
                  }}
                  disabled={!documentText}
                  className="rounded-control p-1 text-fg-muted hover:bg-surface-hover hover:text-fg disabled:opacity-40"
                  title={t('mongo.copyDocument')}
                  aria-label={t('mongo.copyDocument')}
                >
                  <Copy size={14} />
                </button>
                <button
                  onClick={() => {
                    documentRequest.current += 1;
                    setSelectedId(null);
                    setDocumentText(null);
                    setDocumentError(null);
                  }}
                  className="rounded-control p-1 text-fg-muted hover:bg-surface-hover hover:text-fg"
                  title={t('mongo.closeDocument')}
                  aria-label={t('mongo.closeDocument')}
                >
                  <X size={14} />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {documentLoading ? (
                <div className="flex items-center gap-2 text-sm text-fg-muted">
                  <RefreshCw className="animate-spin text-fg-subtle" size={14} />
                  {t('mongo.loading')}
                </div>
              ) : documentError ? (
                <p className="text-sm text-danger">{documentError}</p>
              ) : documentText === null ? (
                <p className="text-sm text-fg-muted">{t('mongo.documentGone')}</p>
              ) : (
                <pre className="whitespace-pre font-mono text-[13px] text-fg select-text">{documentText}</pre>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
