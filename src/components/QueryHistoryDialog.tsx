import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Search, Star, Tag, Trash2, X } from 'lucide-react';
import { clsx } from 'clsx';
import {
  normalizeTags,
  QUERY_HISTORY_STATUSES,
  type QueryHistoryEntry,
  type QueryHistoryStatus
} from '../contracts/queryHistory';
import { EMPTY_HISTORY_FILTER, filterHistory, isEmptyFilter } from '../utils/historySearch';
import { useHistoryStore } from '../stores/historyStore';
import { useConnectionStore } from '../stores/connectionStore';
import { useLanguageStore } from '../stores/languageStore';
import type { TranslationKey } from '../i18n/translate';

interface QueryHistoryDialogProps {
  onClose: () => void;
  /**
   * 把一条语句放进**新**标签。不覆盖当前草稿——那会毁掉用户正在写的东西。
   *
   * 没有活动连接时不传：历史本来就能离线翻，但那时开不出标签来。与其点了
   * 没反应，不如让那一行不是按钮，复制仍然可用。
   */
  onOpenInNewTab?: (sql: string) => void;
}

const STATUS_LABEL_KEYS: Record<QueryHistoryStatus, TranslationKey> = {
  succeeded: 'history.status.succeeded',
  failed: 'history.status.failed',
  cancelled: 'history.status.cancelled',
  'timed-out': 'history.status.timed-out'
};

const STATUS_TONE: Record<QueryHistoryStatus, string> = {
  succeeded: 'border-success-line bg-success-soft text-success',
  failed: 'border-danger-line bg-danger-soft text-danger',
  cancelled: 'border-line-strong bg-surface-sunken text-fg-muted',
  'timed-out': 'border-warning-line bg-warning-soft text-warning'
};

function formatDuration(durationMs: number): string {
  return durationMs < 1000 ? `${durationMs} ms` : `${(durationMs / 1000).toFixed(2)} s`;
}

export function QueryHistoryDialog({ onClose, onOpenInNewTab }: QueryHistoryDialogProps) {
  const t = useLanguageStore((state) => state.t);
  const entries = useHistoryStore((state) => state.entries);
  const annotate = useHistoryStore((state) => state.annotate);
  const remove = useHistoryStore((state) => state.remove);
  const clear = useHistoryStore((state) => state.clear);
  const connections = useConnectionStore((state) => state.connections);

  const [filter, setFilter] = useState(EMPTY_HISTORY_FILTER);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  /** 正在编辑标注的那一条。同时只开一条，免得一屏输入框 */
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const visible = useMemo(() => filterHistory(entries, filter), [entries, filter]);

  const copySql = async (id: string, sql: string) => {
    await navigator.clipboard.writeText(sql);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1500);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="history-title"
      onClick={onClose}
    >
      <div
        className="flex h-[min(80vh,700px)] w-[940px] max-w-[calc(100vw-2rem)] flex-col rounded-panel bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 id="history-title" className="text-base font-medium text-fg">
            {t('history.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-control p-1 text-fg-subtle hover:bg-surface-hover hover:text-fg"
          >
            <X size={16} />
          </button>
        </div>

        {/* 筛选条。四个条件是与的关系，都留在一行上，免得筛完了还要回想自己
            设过什么 */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-2.5">
          <div className="relative min-w-[160px] flex-1">
            <Search
              size={13}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-subtle"
            />
            <input
              type="search"
              value={filter.text}
              onChange={(event) => setFilter({ ...filter, text: event.target.value })}
              placeholder={t('history.searchPlaceholder')}
              aria-label={t('history.searchPlaceholder')}
              className="w-full rounded-control border border-line-strong bg-surface py-1 pl-7 pr-2 text-sm text-fg placeholder:text-fg-subtle"
            />
          </div>

          <button
            type="button"
            onClick={() => setFilter({ ...filter, favoritesOnly: !filter.favoritesOnly })}
            aria-pressed={filter.favoritesOnly}
            title={t('history.filter.favoritesOnly')}
            className={clsx(
              'shrink-0 rounded-control border px-2 py-1',
              filter.favoritesOnly
                ? 'border-accent-line bg-accent-soft text-accent'
                : 'border-line-strong bg-surface text-fg-subtle hover:text-fg'
            )}
          >
            <Star size={14} fill={filter.favoritesOnly ? 'currentColor' : 'none'} />
          </button>

          <select
            value={filter.profileId ?? ''}
            onChange={(event) =>
              setFilter({ ...filter, profileId: event.target.value || null })
            }
            aria-label={t('history.filter.connection')}
            className="rounded-control border border-line-strong bg-surface px-2 py-1 text-sm text-fg"
          >
            <option value="">{t('history.filter.allConnections')}</option>
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name}
              </option>
            ))}
          </select>

          <select
            value={filter.status ?? ''}
            onChange={(event) =>
              setFilter({
                ...filter,
                status: (event.target.value || null) as QueryHistoryStatus | null
              })
            }
            aria-label={t('history.filter.status')}
            className="rounded-control border border-line-strong bg-surface px-2 py-1 text-sm text-fg"
          >
            <option value="">{t('history.filter.allStatuses')}</option>
            {QUERY_HISTORY_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(STATUS_LABEL_KEYS[status])}
              </option>
            ))}
          </select>

          {/* 两个日期框连同中间的短横当一个整体换行：分开换行会在上一行留下
              一个孤零零的「–」，看着像是界面坏了 */}
          <div className="flex shrink-0 items-center gap-2">
            <input
              type="date"
              value={filter.from ?? ''}
              onChange={(event) => setFilter({ ...filter, from: event.target.value || null })}
              aria-label={t('history.filter.from')}
              className="rounded-control border border-line-strong bg-surface px-2 py-1 text-sm text-fg"
            />
            <span className="text-xs text-fg-subtle">–</span>
            <input
              type="date"
              value={filter.to ?? ''}
              onChange={(event) => setFilter({ ...filter, to: event.target.value || null })}
              aria-label={t('history.filter.to')}
              className="rounded-control border border-line-strong bg-surface px-2 py-1 text-sm text-fg"
            />
          </div>

          {!isEmptyFilter(filter) && (
            <button
              type="button"
              onClick={() => setFilter(EMPTY_HISTORY_FILTER)}
              className="rounded-control px-2 py-1 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg"
            >
              {t('history.clearFilter')}
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {visible.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-fg-subtle">
              {entries.length === 0 ? t('history.empty') : t('history.noMatch')}
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {visible.map((entry) => (
                <li key={entry.id} className="group px-5 py-2.5 hover:bg-surface-hover">
                  <div className="flex items-center gap-2 text-xs text-fg-subtle">
                    <span
                      className={clsx(
                        'shrink-0 rounded-control border px-1.5 py-0.5 font-medium',
                        STATUS_TONE[entry.status]
                      )}
                    >
                      {t(STATUS_LABEL_KEYS[entry.status])}
                    </span>
                    <span className="shrink-0">{new Date(entry.startedAt).toLocaleString()}</span>
                    <span className="truncate">
                      {entry.connectionName}
                      {entry.database ? ` / ${entry.database}` : ''}
                    </span>
                    <span className="shrink-0">{formatDuration(entry.durationMs)}</span>
                    {entry.rowsAffected !== null && (
                      <span className="shrink-0">
                        {/* 英文「1 rows」一眼就露怯。中文两档同文，代价只有一个键 */}
                        {t(entry.rowsAffected === 1 ? 'history.rows.one' : 'history.rows', {
                          count: entry.rowsAffected
                        })}
                      </span>
                    )}

                    {/* 动作只在这一行悬停时出现：每行常驻五个图标会把列表变成按钮墙 */}
                    <span
                      className={clsx(
                        'ml-auto flex shrink-0 items-center gap-1 transition-opacity focus-within:opacity-100 group-hover:opacity-100',
                        // 已收藏的星标常驻：它是这条记录的状态，不是一个动作
                        entry.favorite ? 'opacity-100' : 'opacity-0'
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => annotate(entry.id, { favorite: !entry.favorite })}
                        aria-pressed={entry.favorite === true}
                        aria-label={t('history.favorite')}
                        title={t('history.favorite')}
                        className={clsx(
                          'rounded-control p-1 hover:bg-surface',
                          entry.favorite ? 'text-warning' : 'hover:text-fg'
                        )}
                      >
                        <Star size={13} fill={entry.favorite ? 'currentColor' : 'none'} />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setEditingId((current) => (current === entry.id ? null : entry.id))
                        }
                        aria-expanded={editingId === entry.id}
                        aria-label={t('history.annotate')}
                        title={t('history.annotate')}
                        className="rounded-control p-1 hover:bg-surface hover:text-fg"
                      >
                        <Tag size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void copySql(entry.id, entry.sql)}
                        aria-label={t('history.copy')}
                        title={t('history.copy')}
                        className="rounded-control p-1 hover:bg-surface hover:text-fg"
                      >
                        {copiedId === entry.id ? (
                          <Check size={13} className="text-success" />
                        ) : (
                          <Copy size={13} />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(entry.id)}
                        aria-label={t('history.remove')}
                        title={t('history.remove')}
                        className="rounded-control p-1 hover:bg-surface hover:text-danger"
                      >
                        <Trash2 size={13} />
                      </button>
                    </span>
                  </div>

                  {onOpenInNewTab ? (
                    <button
                      type="button"
                      onClick={() => {
                        onOpenInNewTab(entry.sql);
                        onClose();
                      }}
                      title={t('history.openInNewTab')}
                      className="mt-1 block w-full truncate text-left font-mono text-sm text-fg hover:underline"
                    >
                      {entry.sql}
                    </button>
                  ) : (
                    <p className="mt-1 truncate font-mono text-sm text-fg">{entry.sql}</p>
                  )}

                  {(entry.name || (entry.tags?.length ?? 0) > 0) && (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {entry.name && (
                        <span className="text-xs font-medium text-fg">{entry.name}</span>
                      )}
                      {entry.tags?.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          // 点一个标签就按它筛：标签的用处就是把同一类语句聚起来
                          onClick={() => setFilter({ ...filter, text: tag })}
                          className="rounded-control border border-line-strong bg-surface-sunken px-1.5 py-0.5 text-[11px] text-fg-muted hover:text-fg"
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  )}

                  {editingId === entry.id && (
                    <AnnotationEditor
                      entry={entry}
                      onSubmit={(annotation) => {
                        annotate(entry.id, annotation);
                        setEditingId(null);
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  )}

                  {entry.redacted && (
                    // 不说这句，用户会拿着一条 '***' 的语句去跑然后不明白为什么失败
                    <p className="mt-0.5 text-xs text-warning">{t('history.redacted')}</p>
                  )}
                  {entry.errorMessage && (
                    <p className="mt-0.5 truncate text-xs text-danger" title={entry.errorMessage}>
                      {entry.errorMessage}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-line px-5 py-2.5">
          <p className="text-xs text-fg-subtle">
            {t('history.count', { visible: visible.length, total: entries.length })}
          </p>
          <button
            type="button"
            onClick={clear}
            disabled={entries.length === 0}
            className="rounded-control px-2 py-1 text-xs text-fg-muted hover:bg-surface-hover hover:text-danger disabled:pointer-events-none disabled:opacity-40"
          >
            {t('history.clearAll')}
          </button>
        </div>
      </div>
    </div>
  );
}

interface AnnotationEditorProps {
  entry: QueryHistoryEntry;
  onSubmit: (annotation: { name: string; tags: string[] }) => void;
  onCancel: () => void;
}

/**
 * 命名与标签的就地编辑。
 *
 * 用 form + 提交而不是每敲一个字就写回 store：标注会落盘，逐字写等于每个
 * 按键都重写一遍整份历史。Esc 取消，回车提交。
 */
function AnnotationEditor({ entry, onSubmit, onCancel }: AnnotationEditorProps) {
  const t = useLanguageStore((state) => state.t);
  const [name, setName] = useState(entry.name ?? '');
  const [tags, setTags] = useState((entry.tags ?? []).join(', '));

  return (
    <form
      className="mt-1.5 flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ name, tags: normalizeTags(tags) });
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder={t('history.namePlaceholder')}
        aria-label={t('history.name')}
        className="min-w-[140px] flex-1 rounded-control border border-line-strong bg-surface px-2 py-1 text-xs text-fg placeholder:text-fg-subtle"
      />
      <input
        value={tags}
        onChange={(event) => setTags(event.target.value)}
        placeholder={t('history.tagsPlaceholder')}
        aria-label={t('history.tags')}
        className="min-w-[140px] flex-1 rounded-control border border-line-strong bg-surface px-2 py-1 text-xs text-fg placeholder:text-fg-subtle"
      />
      <button
        type="submit"
        className="rounded-control border border-accent-line bg-accent-soft px-2 py-1 text-xs text-accent"
      >
        {t('common.save')}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-control px-2 py-1 text-xs text-fg-muted hover:text-fg"
      >
        {t('common.cancel')}
      </button>
    </form>
  );
}
