import { useEffect, useMemo, useState } from 'react';
import { PLAIN_TEXT_INPUT } from './FormControls';
import { invoke } from '@tauri-apps/api/core';
import { Plus, X } from 'lucide-react';
import { useLanguageStore } from '../stores/languageStore';
import { useAppStore } from '../stores/appStore';
import { describeError } from '../utils/describeError';
import type { SqlIdentifierDialect } from '../utils/sqlIdentifiers';
import {
  buildCreateTable,
  defaultCreateSchema,
  incompleteDraftColumns,
  usableDraftColumns,
  type ColumnDraft,
  type DdlPlan
} from '../utils/tableDdl';
import { ColumnDraftTable } from './ColumnDraftTable';
import { DdlPreviewDialog } from './DdlPreviewDialog';

interface CreateTableDialogProps {
  connectionId: string;
  dialect: SqlIdentifierDialect;
  /** 库里已有的 schema；SQLite 没有这一层，传空数组 */
  schemas: readonly string[];
  /** 登录用户：Oracle 的 schema 就是用户，不写 schema 时建在它名下 */
  username?: string | null;
  onClose: () => void;
  onCreated: (table: string, schema: string | null) => void;
}

const BLANK: ColumnDraft = {
  origin: null,
  name: '',
  dataType: '',
  nullable: true,
  defaultValue: null,
  dropped: false,
  primaryKey: false
};

/**
 * 新建表。
 *
 * 不走二次确认：建表不碰任何已有数据，风险和一条 INSERT 同级。给每条 CREATE
 * 弹一次确认，弹到第三次就没人看了，真正危险的那次也会被顺手点掉。
 *
 * 和改结构共用同一张列表格，也共用同一个预览框——建表同样是「先看要跑什么，
 * 再跑」。建表不删数据，所以没有影响清单，风险也只是有界写入。
 *
 * 起手两列（一个主键、一个普通列）不是装饰：空表格里第一件要做的事是
 * 决定主键，而这个程序里没有主键的表**不可编辑**。
 */
export function CreateTableDialog({
  connectionId,
  dialect,
  schemas,
  username,
  onClose,
  onCreated
}: CreateTableDialogProps) {
  const t = useLanguageStore((state) => state.t);
  const markSchemaChanged = useAppStore((state) => state.markSchemaChanged);

  const [table, setTable] = useState('');
  const [schema, setSchema] = useState(() => defaultCreateSchema(schemas, dialect, username));
  const [drafts, setDrafts] = useState<ColumnDraft[]>([
    {
      ...BLANK,
      // 名字会被引号括起来：Oracle 里带引号的小写名字大小写敏感，以后每次都得加引号写
      name: dialect === 'oracle' ? 'ID' : 'id',
      dataType: defaultKeyType(dialect),
      nullable: false,
      primaryKey: true
    },
    { ...BLANK }
  ]);
  const [preview, setPreview] = useState<DdlPlan | null>(null);
  const [running, setRunning] = useState(false);

  // 点遮罩已经会把填的内容丢掉，Esc 却不动——两条关闭路径得一致，否则人会
  // 以为这个弹窗「关不掉」。跑着的时候不关：那一下会让人以为动作被取消了，
  // 而语句已经发出去了
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !running) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [running, onClose]);

  const [error, setError] = useState<string | null>(null);

  const updateDraft = (index: number, patch: Partial<ColumnDraft>) => {
    setDrafts((current) =>
      current.map((draft, position) => (position === index ? { ...draft, ...patch } : draft)));
  };

  const removeDraft = (index: number) => {
    setDrafts((current) => current.filter((_, position) => position !== index));
  };

  const incomplete = useMemo(() => incompleteDraftColumns(drafts), [drafts]);
  const usable = useMemo(() => usableDraftColumns(drafts), [drafts]);
  const ready = table.trim() !== '' && usable.length > 0 && incomplete.length === 0;
  const withoutKey = usable.every((draft) => !draft.primaryKey);

  const openPreview = () => {
    if (!ready) {
      return;
    }
    setError(null);
    setPreview(buildCreateTable({
      schema: schema.trim() === '' ? null : schema.trim(),
      table: table.trim(),
      dialect,
      columns: drafts
    }));
  };

  const run = async (plan: DdlPlan) => {
    setRunning(true);
    setError(null);
    try {
      await invoke<number[]>('execute_write_batch', {
        connectionId,
        statements: plan.statements.map((sql) => ({ sql, params: [], expectRows: null }))
      });
      markSchemaChanged();
      onCreated(table.trim(), schema.trim() === '' ? null : schema.trim());
      onClose();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-table-title"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[760px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-panel bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 id="create-table-title" className="text-base font-medium text-fg">
            {t('ddl.createTitle')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-control p-1 text-fg-muted hover:bg-surface-hover hover:text-fg"
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface-sunken px-5 py-3">
          {schemas.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-fg-muted">
              {t('ddl.schema')}
              <select
                value={schema}
                onChange={(event) => setSchema(event.target.value)}
                className="rounded-control border border-line bg-surface px-2 py-1 font-mono text-xs text-fg"
              >
                {schemas.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </label>
          )}
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            {t('ddl.tableName')}
            <input
              value={table}
              autoFocus
              onChange={(event) => setTable(event.target.value)}
              className="rounded-control border border-line bg-surface px-2 py-1 font-mono text-xs text-fg"
              {...PLAIN_TEXT_INPUT}
            />
          </label>
          <button
            type="button"
            onClick={() => setDrafts((current) => [...current, { ...BLANK }])}
            className="flex items-center gap-1 rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
          >
            <Plus size={14} />
            {t('ddl.addColumn')}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <ColumnDraftTable
            drafts={drafts}
            editing
            primaryKeyEditable
            onChange={updateDraft}
            onRemove={removeDraft}
          />
        </div>

        <div className="border-t border-line bg-surface-sunken px-5 py-3">
          {incomplete.length > 0 && (
            <p className="mb-2 text-xs text-warning">
              {t('ddl.incomplete', { columns: incomplete.join(', ') })}
            </p>
          )}
          {/* 没有主键不拦着——日志表本来可能不要。但那样的表在这里不可编辑 */}
          {withoutKey && incomplete.length === 0 && (
            <p className="mb-2 text-xs text-fg-subtle">{t('ddl.noPrimaryKeyNote')}</p>
          )}
          {error && <p className="mb-2 text-sm text-danger">{error}</p>}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={openPreview}
              disabled={!ready}
              className="rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:opacity-90 disabled:opacity-50"
            >
              {t('ddl.preview')}
            </button>
          </div>
        </div>
      </div>

      {preview && (
        <DdlPreviewDialog
          plan={preview}
          dialect={dialect}
          running={running}
          error={error}
          onApply={() => void run(preview)}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

/** 主键那一列的起手类型：各家最常见的自增写法（SQL Server 那句在改结构语料里跑过真库） */
function defaultKeyType(dialect: SqlIdentifierDialect): string {
  if (dialect === 'postgresql') {
    return 'integer GENERATED ALWAYS AS IDENTITY';
  }
  if (dialect === 'sqlserver') {
    return 'int IDENTITY(1,1)';
  }
  if (dialect === 'oracle') {
    return 'NUMBER(10) GENERATED ALWAYS AS IDENTITY';
  }
  return dialect === 'mysql' ? 'INT AUTO_INCREMENT' : 'INTEGER';
}
