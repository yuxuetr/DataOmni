import { useEffect, useState } from 'react';
import { Copy, Pencil, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { useLanguageStore } from '../stores/languageStore';
import { describeError } from '../utils/describeError';
import { indentOnTab } from '../utils/mongoDocuments';
import { formatShortcut, matchesShortcut, SHORTCUTS } from '../utils/shortcuts';
import { PLAIN_TEXT_INPUT } from './FormControls';

/** 新建文档时编辑框里的起点：一对空括号，光标放在中间那行 */
export const NEW_DOCUMENT_TEMPLATE = '{\n  \n}';

interface MongoDocumentPanelProps {
  /** 看一个已有文档，或者新建一个 */
  mode: 'document' | 'insert';
  /** 标题上那个 `_id` 写法；新建时没有 */
  idText: string | null;
  /** 打开时拿到的文字（缩进写法）；`null` 是文档已经不在了 */
  text: string | null;
  loading: boolean;
  error: string | null;
  /** 视图、没有 `_id` 的结果不能改 */
  readOnly: boolean;
  /** 存；失败就抛，面板把原因写在编辑框下面，草稿留着 */
  onSave: (draft: string) => Promise<void>;
  onDelete: () => void;
  /** 从编辑里退出来：面板重新读一遍文档 */
  onCancelEdit: () => void;
  onClose: () => void;
  /** 草稿与原文不同的时候告诉外面：换一行、关面板之前要问一句 */
  onDirtyChange: (dirty: boolean) => void;
}

/**
 * 集合页右边的文档面板：看、改、新建都在这里，同一种 mongosh 写法。
 *
 * 编辑框就是普通的多行文本框，不是代码编辑器：要校验的只有「读不读得回来」，
 * 这件事由后端的解析器说了算（报行列），在这里再做一套高亮与校验就有两个裁判。
 */
export function MongoDocumentPanel({
  mode,
  idText,
  text,
  loading,
  error,
  readOnly,
  onSave,
  onDelete,
  onCancelEdit,
  onClose,
  onDirtyChange
}: MongoDocumentPanelProps) {
  const t = useLanguageStore((state) => state.t);
  const [editing, setEditing] = useState(mode === 'insert');
  const [draft, setDraft] = useState(mode === 'insert' ? NEW_DOCUMENT_TEMPLATE : '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  const original = mode === 'insert' ? NEW_DOCUMENT_TEMPLATE : text ?? '';
  const dirty = editing && draft !== original;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const startEditing = () => {
    setDraft(text ?? '');
    setSaveError(null);
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (cause) {
      setSaveError(describeError(cause));
    } finally {
      setSaving(false);
    }
  };

  const title = mode === 'insert' ? t('mongo.newDocument') : `${t('mongo.document')} · ${idText ?? ''}`;

  return (
    <aside className="flex w-[40%] min-w-72 max-w-[640px] flex-col border-l border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line bg-surface-sunken px-3 py-2">
        <span className="truncate text-xs font-medium text-fg-muted" title={title}>{title}</span>
        <div className="flex shrink-0 items-center gap-1">
          {mode === 'document' && !editing && (
            <>
              {!readOnly && (
                <button
                  onClick={startEditing}
                  disabled={loading || text === null}
                  className="rounded-control p-1 text-fg-muted hover:bg-surface-hover hover:text-fg disabled:opacity-40"
                  title={t('mongo.editDocument')}
                  aria-label={t('mongo.editDocument')}
                >
                  <Pencil size={14} />
                </button>
              )}
              <button
                onClick={() => {
                  if (text) {
                    setCopyError(null);
                    void navigator.clipboard.writeText(text).catch((cause) => {
                      setCopyError(describeError(cause, t('common.copyFailed')));
                    });
                  }
                }}
                disabled={!text}
                className="rounded-control p-1 text-fg-muted hover:bg-surface-hover hover:text-fg disabled:opacity-40"
                title={t('mongo.copyDocument')}
                aria-label={t('mongo.copyDocument')}
              >
                <Copy size={14} />
              </button>
              {!readOnly && (
                <button
                  onClick={onDelete}
                  disabled={loading || text === null}
                  className="rounded-control p-1 text-danger hover:bg-danger-soft disabled:opacity-40"
                  title={t('mongo.deleteDocument')}
                  aria-label={t('mongo.deleteDocument')}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </>
          )}
          <button
            onClick={onClose}
            className="rounded-control p-1 text-fg-muted hover:bg-surface-hover hover:text-fg"
            title={t('mongo.closeDocument')}
            aria-label={t('mongo.closeDocument')}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {editing ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Tab 缩进两格，而不是把焦点移出编辑框
              if (event.key === 'Tab' && !event.shiftKey) {
                event.preventDefault();
                const target = event.currentTarget;
                const next = indentOnTab(draft, target.selectionStart, target.selectionEnd);
                setDraft(next.text);
                requestAnimationFrame(() => target.setSelectionRange(next.caret, next.caret));
                return;
              }
              if (matchesShortcut(event, SHORTCUTS.saveToFile)) {
                event.preventDefault();
                void save();
              }
            }}
            aria-label={title}
            autoFocus
            className="min-h-0 flex-1 resize-none border-0 bg-surface p-3 font-mono text-[13px] text-fg outline-none"
            {...PLAIN_TEXT_INPUT}
          />
          {saveError && (
            <p className="border-t border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger">{saveError}</p>
          )}
          <div className="flex items-center justify-between gap-2 border-t border-line bg-surface-sunken px-3 py-2">
            <span className="text-xs text-fg-subtle">
              {t('mongo.editHint', { shortcut: formatShortcut(SHORTCUTS.saveToFile) })}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={() => {
                  if (mode === 'insert') {
                    onClose();
                    return;
                  }
                  setEditing(false);
                  setSaveError(null);
                  onCancelEdit();
                }}
                disabled={saving}
                className="rounded-control border border-line-strong px-3 py-1 text-sm text-fg-muted hover:bg-surface-hover disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => void save()}
                disabled={saving || (mode === 'document' && !dirty)}
                className="flex items-center gap-1 rounded-control border border-accent-line px-3 py-1 text-sm text-accent hover:bg-accent-soft disabled:opacity-50"
              >
                {saving ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
                <span>{mode === 'insert' ? t('mongo.insertDocument') : t('table.save')}</span>
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {copyError && <p className="mb-2 text-sm text-danger">{copyError}</p>}
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-fg-muted">
              <RefreshCw className="animate-spin text-fg-subtle" size={14} />
              {t('mongo.loading')}
            </div>
          ) : error ? (
            <p className="text-sm text-danger">{error}</p>
          ) : text === null ? (
            <p className="text-sm text-fg-muted">{t('mongo.documentGone')}</p>
          ) : (
            <pre className="select-text whitespace-pre font-mono text-[13px] text-fg">{text}</pre>
          )}
        </div>
      )}
    </aside>
  );
}
