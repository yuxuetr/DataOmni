import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Pencil, Plus } from 'lucide-react';
import type { ColumnInfo, ConnectionEnvironment } from '../contracts';
import { useLanguageStore } from '../stores/languageStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useAppStore } from '../stores/appStore';
import { describeError } from '../utils/describeError';
import { requiresConfirmation, type StatementRisk } from '../utils/statementRisk';
import { batchReversibility } from '../utils/statementReversibility';
import type { SqlIdentifierDialect } from '../utils/sqlIdentifiers';
import {
  buildTableDdl,
  columnDefaultSql,
  incompleteDraftColumns,
  type ColumnDraft,
  type DdlPlan
} from '../utils/tableDdl';
import { ColumnDraftTable } from './ColumnDraftTable';
import { DdlPreviewDialog } from './DdlPreviewDialog';
import { DestructiveStatementPrompt } from './DestructiveStatementPrompt';

interface TableStructureEditorProps {
  connectionId: string;
  connectionName: string;
  environment: ConnectionEnvironment;
  schema: string | null;
  table: string;
  columns: readonly ColumnInfo[];
  dialect: SqlIdentifierDialect;
  /** 语句跑完之后重新读结构；改了表名时带上新名字 */
  onApplied: (newTableName: string) => void;
}

/**
 * 表结构页：既是列的清单，也是改它们的地方。
 *
 * 编辑不直接发语句——先算出计划，把语句、会丢的数据和做不到的项一起摆出来，
 * 再执行。结构改动和数据改动不同的地方在于**改错了通常撤不回来**：一条
 * DROP COLUMN 没有对应的「撤销」，所以这里不给「保存」，只给「预览 SQL」。
 */
export function TableStructureEditor({
  connectionId,
  connectionName,
  environment,
  schema,
  table,
  columns,
  dialect,
  onApplied
}: TableStructureEditorProps) {
  const t = useLanguageStore((state) => state.t);
  const confirmationPolicy = useSettingsStore((state) => state.confirmationPolicy);
  const markSchemaChanged = useAppStore((state) => state.markSchemaChanged);

  const [drafts, setDrafts] = useState<ColumnDraft[] | null>(null);
  const [tableName, setTableName] = useState(table);
  const [preview, setPreview] = useState<DdlPlan | null>(null);
  const [pendingRisk, setPendingRisk] = useState<StatementRisk | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const editing = drafts !== null;

  const startEditing = () => {
    setDrafts(columns.map((column) => ({
      origin: column,
      name: column.name,
      dataType: column.data_type,
      nullable: column.is_nullable,
      // 目录里的默认值先归一成 SQL 原文，否则 MySQL 上「什么都没改」
      // 也会被 diff 判成改了默认值
      defaultValue: columnDefaultSql(column, dialect),
      dropped: false,
      primaryKey: column.is_primary_key
    })));
    setTableName(table);
    setError(null);
    setNotice(null);
  };

  const cancelEditing = () => {
    setDrafts(null);
    setPreview(null);
    setError(null);
  };

  const updateDraft = (index: number, patch: Partial<ColumnDraft>) => {
    setDrafts((current) =>
      current?.map((draft, position) => (position === index ? { ...draft, ...patch } : draft)) ?? null
    );
  };

  const addDraft = () => {
    setDrafts((current) => [
      ...(current ?? []),
      {
        origin: null, name: '', dataType: '', nullable: true,
        defaultValue: null, dropped: false, primaryKey: false
      }
    ]);
  };

  const removeDraft = (index: number) => {
    setDrafts((current) => {
      if (!current) {
        return current;
      }
      const draft = current[index];
      // 新加的列直接从草稿里去掉；原有的列只标记，下一步才生成 DROP COLUMN
      return draft.origin
        ? current.map((item, position) =>
          position === index ? { ...item, dropped: !item.dropped } : item)
        : current.filter((_, position) => position !== index);
    });
  };

  const incomplete = useMemo(
    () => (drafts ? incompleteDraftColumns(drafts) : []),
    [drafts]
  );

  const openPreview = () => {
    if (!drafts || incomplete.length > 0) {
      return;
    }
    setError(null);
    setPreview(buildTableDdl({
      schema,
      table,
      newTableName: tableName.trim() || table,
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
      const appliedName = tableName.trim() || table;
      setPreview(null);
      setDrafts(null);
      setNotice(t('ddl.applied'));
      markSchemaChanged();
      onApplied(appliedName);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setRunning(false);
    }
  };

  const apply = (plan: DdlPlan) => {
    // 删列会连数据一起没，和一条 DROP TABLE 同级；其余结构改动归为有界写入
    const risk: StatementRisk = plan.impacts.length > 0 ? 'destructive' : 'scoped-write';
    if (requiresConfirmation(risk, environment, confirmationPolicy)) {
      setPendingRisk(risk);
      return;
    }
    void run(plan);
  };

  return (
    <>
      <div className="flex items-start justify-between border-b border-line bg-surface-sunken p-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fg">{t('table.structureTitle')}</h2>
          <p className="mt-1 text-xs text-fg-muted">
            {t('table.fieldCount', { count: columns.length })}
          </p>
          {editing && (
            <label className="mt-2 flex items-center gap-2 text-xs text-fg-muted">
              {t('ddl.tableName')}
              <input
                value={tableName}
                onChange={(event) => setTableName(event.target.value)}
                className="rounded-control border border-line bg-surface px-2 py-1 font-mono text-xs text-fg"
              />
            </label>
          )}
          {notice && <p className="mt-2 text-xs text-success">{notice}</p>}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {editing ? (
            <>
              <button
                type="button"
                onClick={addDraft}
                className="flex items-center gap-1 rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
              >
                <Plus size={14} />
                {t('ddl.addColumn')}
              </button>
              <button
                type="button"
                onClick={cancelEditing}
                className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={openPreview}
                disabled={incomplete.length > 0}
                className="rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:opacity-90 disabled:opacity-50"
              >
                {t('ddl.preview')}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={startEditing}
              className="flex items-center gap-1 rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
            >
              <Pencil size={14} />
              {t('ddl.edit')}
            </button>
          )}
        </div>
      </div>

      {editing && incomplete.length > 0 && (
        <p className="border-b border-warning-line bg-warning-soft px-4 py-2 text-xs text-warning">
          {t('ddl.incomplete', { columns: incomplete.join(', ') })}
        </p>
      )}
      {editing && (
        <p className="border-b border-line px-4 py-2 text-xs text-fg-subtle">
          {t('ddl.keyColumnsReadOnly')}
        </p>
      )}
      {!editing && error && (
        <p className="border-b border-danger-line bg-danger-soft px-4 py-2 text-xs text-danger">
          {error}
        </p>
      )}

      <ColumnDraftTable
        drafts={drafts ?? columns.map((column) => ({
          origin: column,
          name: column.name,
          dataType: column.data_type,
          nullable: column.is_nullable,
          // 只读时也显示归一后的 SQL 原文：MySQL 目录里的 `active` 和 `0`
          // 分不出字符串与数字，而 `'active'` 与 `0` 分得出
          defaultValue: columnDefaultSql(column, dialect),
          dropped: false,
          primaryKey: column.is_primary_key
        }))}
        editing={editing}
        primaryKeyEditable={false}
        onChange={updateDraft}
        onRemove={removeDraft}
      />

      {preview && (
        <DdlPreviewDialog
          plan={preview}
          dialect={dialect}
          running={running}
          error={error}
          onApply={() => apply(preview)}
          onClose={() => setPreview(null)}
        />
      )}

      {preview && pendingRisk && (
        <DestructiveStatementPrompt
          sql={preview.statements.join(';\n')}
          risk={pendingRisk}
          statementCount={preview.statements.length}
          connectionName={connectionName}
          environment={environment}
          databaseLabel={dialect}
          reversibility={batchReversibility(preview.statements, dialect)}
          impacts={preview.impacts.map((impact) =>
            t('ddl.impact.dropColumn', { column: impact.column }))}
          onCancel={() => setPendingRisk(null)}
          onConfirm={() => {
            setPendingRisk(null);
            void run(preview);
          }}
        />
      )}
    </>
  );
}
