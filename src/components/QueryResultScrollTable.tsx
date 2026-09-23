import React, { useLayoutEffect, useState, useRef } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Square,
  Trash2,
  Edit,
  Download,
  BarChart3,
  Lock,
  Undo2
} from 'lucide-react';
import { clsx } from 'clsx';
import {
  FALLBACK_RESULT_TABLE_HEIGHT,
  resultTableHeight
} from '../utils/resultTableHeight';
import type { QueryResult } from '../contracts/query';
import { selectSqlDialect, useQueryStore } from '../stores/queryStore';
import { unwrapResultValue } from '../utils/resultValues';
import type { SerializedResultValue } from '../contracts/resultSet';
import { cellInputFromValue, type CellInput } from '../utils/cellInput';
import {
  pendingForRow,
  pendingStatements,
  revertChange,
  rowIdOf,
  stageDelete,
  stageInsert,
  stageUpdate,
  type PendingChange
} from '../utils/pendingChanges';
import type { TableTarget } from '../utils/rowStatements';
import { ROW_COUNT_MISMATCH_CODE, toQueryExecutionError } from '../utils/queryError';
import { PendingChangesBar } from './PendingChangesBar';
import { ChangeDiffDialog, type CommitFailure } from './ChangeDiffDialog';
import { CellInputEditor } from './CellInputEditor';
import { useResizableColumns } from '../hooks/useResizableColumns';
import { ColumnResizeHandle } from './ColumnResizeHandle';
import { GRID_PAGE_SIZE_OPTIONS } from '../utils/gridPagination';
import { GridCellValue } from './GridCellValue';
import { GridContextMenu, type GridContextTarget } from './GridContextMenu';
import { ColumnSortButton } from './ColumnSortButton';
import { nextColumnSort, sortRowsByColumn, type ColumnSort } from '../utils/resultSorting';
import { useCellSelection } from '../hooks/useCellSelection';
import { selectionSubset } from '../utils/cellSelection';
import { supportsFeature } from '../contracts/databaseSupport';
import { useLanguageStore } from '../stores/languageStore';
import { ExportResultDialog, type ExportScope } from './ExportResultDialog';
import { ResultChartDialog } from './ResultChartDialog';
import { DENSITY_CELL_CLASS } from '../utils/gridColumns';
import { useSettingsStore } from '../stores/settingsStore';
import { SHORTCUTS, formatShortcut } from '../utils/shortcuts';

/**
 * 结果区底边要留出的余量。
 *
 * 不留的话表格正好贴着底边，看上去像是被切掉了一截而不是滚到头了。
 */
const RESULT_PANE_BOTTOM_GAP = 12;

interface QueryResultScrollTableProps {
  result: QueryResult;
  statementId: string;
  /** 产生这份结果的那条 SQL。结果被截断时，导出整份要靠它重新执行一遍。 */
  resultSql?: string;
  formatExecutionTime: (ms: number) => string;
}

export const QueryResultScrollTable: React.FC<QueryResultScrollTableProps> = ({ 
  result, 
  statementId, 
  resultSql,
  formatExecutionTime 
}) => {
  const t = useLanguageStore((state) => state.t);
  // 和表数据网格共用同一档行高。这张网格没有列菜单，入口在「设置」里
  const densityClass = DENSITY_CELL_CLASS[useSettingsStore((state) => state.gridDensity)];
  const commitRowChanges = useQueryStore((state) => state.commitRowChanges);
  const connectionId = useQueryStore((state) => state.connectionId);
  const dialect = useQueryStore(selectSqlDialect);
  
  // 分页状态
  const [currentPage, setCurrentPage] = useState(1);
  const [sort, setSort] = useState<ColumnSort | null>(null);
  const [pageSize, setPageSize] = useState(25);
  
  // 编辑状态
  const [editingCell, setEditingCell] = useState<{
    rowIndex: number;
    columnIndex: number;
  } | null>(null);
  const [editValue, setEditValue] = useState<CellInput>({ kind: 'unset' });
  
  // 新增行状态
  const [showAddForm, setShowAddForm] = useState(false);
  const [newRowData, setNewRowData] = useState<Record<string, CellInput>>({});
  const [showExport, setShowExport] = useState(false);
  const [showChart, setShowChart] = useState(false);
  /** 待提交的变更。这张表和表数据视图共用同一套模型与同一个事务命令 */
  const [changes, setChanges] = useState<PendingChange[]>([]);
  const [showChanges, setShowChanges] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitFailure, setCommitFailure] = useState<CommitFailure | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  /** 表格本身的高度。量它而不是量滚动容器的 scrollHeight——后者会被我们
      刚设上去的高度影响，自己量自己就成了循环 */
  const tableContentRef = useRef<HTMLDivElement>(null);
  const [tableHeight, setTableHeight] = useState(FALLBACK_RESULT_TABLE_HEIGHT);
  
  // 计算分页数据
  const totalRows = result.rows.length;
  // 先对整份结果排序再切页：只排当前页得到的是「这一页内部的次序」，
  // 不是用户想要的「整份结果按这列排」
  const sortedRows = React.useMemo(
    () => sortRowsByColumn(result.columns, result.rows, sort),
    [result.columns, result.rows, sort]
  );
  const totalPages = Math.ceil(totalRows / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalRows);
  const currentRows = React.useMemo(
    () => sortedRows.slice(startIndex, endIndex),
    [sortedRows, startIndex, endIndex]
  );
  // 翻页、改排序、换一条语句的结果都换了数据集，选区必须跟着清掉；
  // 同一页重新渲染则留着
  const datasetKey = `${statementId}|${sort?.column ?? ''}:${sort?.direction ?? ''}|${currentPage}|${pageSize}`;
  const cells = useCellSelection(currentRows, result.columns, datasetKey);
  const [contextTarget, setContextTarget] = useState<GridContextTarget | null>(null);

  // 选中的部分单独成一档。选区的行号是**当前页**里的行号，所以取数据要从
  // currentRows 取，而不是导出对话框拿到的那份排过序的全部结果
  const exportScopes = React.useMemo(() => {
    const list: ExportScope[] = [{ id: 'current', label: t('export.scope.currentResult') }];
    if (result.truncated && resultSql && supportsFeature(dialect, 'streamingExport')) {
      list.push({
        id: 'full',
        label: t('export.scope.fullResult'),
        note: t('export.scope.fullResultNote'),
        sql: resultSql
      });
    }
    if (cells.selection) {
      const subset = selectionSubset(currentRows, result.columns, cells.selection);
      list.unshift({
        id: 'selection',
        label: t('export.scope.selection'),
        note: t('export.scope.selectionNote', {
          rows: subset.rows.length,
          columns: subset.columns.length
        }),
        columns: subset.columns,
        rows: subset.rows
      });
    }
    return list;
  }, [cells.selection, currentRows, dialect, result.columns, result.truncated, resultSql, t]);
  
  // 能不能改由 `describeResultEditability` 证明过：认得出是单表 SELECT，
  // 键来自目录，且键列在投影里。这里只读结论，不再自己拼条件判断
  const editability = result.editability;
  const canEdit = editability?.editable === true && supportsFeature(dialect, 'dataEditing');
  const keyColumns = React.useMemo(
    () => new Set(editability?.editable ? editability.keyColumns : []),
    [editability]
  );
  const readOnlyReason = (() => {
    // 这类连接还没接上表格编辑：说这个，而不是去猜索引读没读到
    if (editability && !supportsFeature(dialect, 'dataEditing')) {
      return t('table.readOnly.pendingFeature');
    }
    if (!editability || editability.editable) {
      return null;
    }
    switch (editability.reason) {
      case 'complex-query':
        return t('result.readOnly.complexQuery');
      case 'missing-unique-key':
        return t('result.readOnly.missingUniqueKey');
      case 'key-not-projected':
        return t('result.readOnly.keyNotProjected');
      default:
        return t('result.readOnly.metadataPending');
    }
  })();
  
  /**
   * 列的声明类型。优先用驱动给的 `database_type`——它是这一次查询真正返回的
   * 类型；目录里的列信息只有在认得出目标表时才有，而且列清单可能对不上
   */
  const columnType = (index: number): string =>
    result.column_metadata?.[index]?.database_type
      ?? result.tableColumns?.find(column => column.name === result.columns[index])?.data_type
      ?? '';

  const ACTION_COLUMN_WIDTH = 72;
  // 列宽按当前页的内容估算，可拖动覆盖
  const { widths, alignments, totalWidth, startResize, autoFitColumn, resizingIndex } =
    useResizableColumns(result.columns, currentRows);
  const tableWidth = totalWidth + (canEdit ? ACTION_COLUMN_WIDTH : 0);
  
  // 编辑相关函数
  const startEditing = (rowIndex: number, columnIndex: number, currentValue: SerializedResultValue) => {
    if (!canEdit) return;
    setEditingCell({ rowIndex, columnIndex });
    // NULL 回到 `null` 档：否则打开编辑框再关掉就把 NULL 变成了空字符串
    setEditValue(cellInputFromValue(unwrapResultValue(currentValue)));
  };
  
  const cancelEditing = () => {
    setEditingCell(null);
    setEditValue({ kind: 'unset' });
  };
  
  /** 这一行的键与原值。键值要从 tagged 包装里拆出来才能进 WHERE */
  const rowContext = (rowIndex: number) => {
    if (!editability?.editable) {
      return null;
    }
    const row = sortedRows[rowIndex + startIndex];
    if (!row) {
      return null;
    }
    const original = Object.fromEntries(
      result.columns.map((column, index) => [column, unwrapResultValue(row[index])])
    );
    return {
      key: {
        columns: editability.keyColumns,
        values: Object.fromEntries(
          editability.keyColumns.map((column) => [column, original[column] ?? null])
        )
      },
      original
    };
  };

  /** 保存 = 排队，不发语句 */
  const saveEdit = () => {
    if (!editingCell || !canEdit) return;
    const context = rowContext(editingCell.rowIndex);
    if (context) {
      const columnName = result.columns[editingCell.columnIndex];
      setChanges((current) =>
        stageUpdate(current, context.key, context.original, { [columnName]: editValue }));
    }
    cancelEditing();
  };

  const deleteRow = (rowIndex: number) => {
    if (!canEdit) return;
    const context = rowContext(rowIndex);
    if (context) {
      setChanges((current) => stageDelete(current, context.key, context.original));
    }
  };

  
  // 新增行相关函数
  const showAddRowForm = () => {
    if (!canEdit) return;
    
    // 键列留空：新增时它们由数据库生成，用户填进去的值多半会和序列打架
    const initialData: Record<string, CellInput> = {};
    result.columns.forEach(column => {
      if (!keyColumns.has(column)) {
        initialData[column] = { kind: 'unset' };
      }
    });
    
    setNewRowData(initialData);
    setShowAddForm(true);
  };
  
  const cancelAddRow = () => {
    setShowAddForm(false);
    setNewRowData({});
  };
  
  const saveNewRow = () => {
    if (!canEdit) return;
    setChanges((current) => stageInsert(current, newRowData));
    cancelAddRow();
  };

  /** 这一行上有没有排队中的改动 */
  const pendingFor = (rowIndex: number) => {
    const context = rowContext(rowIndex);
    return context ? pendingForRow(changes, rowIdOf(context.key)) : undefined;
  };

  const revertAllChanges = () => {
    setChanges([]);
    setCommitFailure(null);
    setCommitError(null);
    setShowChanges(false);
  };

  const writeTarget = (): TableTarget => ({
    schema: editability?.editable ? editability.schema : null,
    table: editability?.editable ? editability.table : '',
    columns: result.tableColumns ?? [],
    dialect
  });

  const commitChanges = async () => {
    if (changes.length === 0) return;
    setCommitting(true);
    setCommitError(null);
    setCommitFailure(null);
    try {
      await commitRowChanges(statementId, pendingStatements(changes, writeTarget()));
      setChanges([]);
      setShowChanges(false);
    } catch (error) {
      const failure = toQueryExecutionError(error);
      const index = typeof (error as { statement_index?: unknown })?.statement_index === 'number'
        ? (error as { statement_index: number }).statement_index
        : 0;
      setCommitFailure({ index, error: failure });
      setCommitError(
        failure.code === ROW_COUNT_MISMATCH_CODE
          ? t('changes.conflict', { index: index + 1 })
          : failure.message
      );
      // 失败时把预览打开：出错的那一条就标在里面
      setShowChanges(true);
    } finally {
      setCommitting(false);
    }
  };

  const updateNewRowData = (column: string, value: CellInput) => {
    setNewRowData(prev => ({ ...prev, [column]: value }));
  };
  
  // 可用空间 = 这张表的顶边到结果区底边之间还剩多少。
  //
  // 量这个而不是量结果区的总高：表上面还压着语句头、工具条、分页条，
  // 它们各自多高会随文案和语言变，减一串常数迟早对不上。
  useLayoutEffect(() => {
    const scroller = scrollContainerRef.current;
    const content = tableContentRef.current;
    if (!scroller || !content) {
      return;
    }
    const pane = scroller.closest('.query-result-pane');
    if (!pane) {
      // 没有结果区（比如被别处复用）就退回写死的那个数，行为和改之前一样
      setTableHeight(FALLBACK_RESULT_TABLE_HEIGHT);
      return;
    }

    const measure = () => {
      const available = pane.getBoundingClientRect().bottom
        - scroller.getBoundingClientRect().top
        - RESULT_PANE_BOTTOM_GAP;
      setTableHeight(resultTableHeight(available, content.offsetHeight));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    observer.observe(content);
    return () => observer.disconnect();
    // 换一份结果、翻页、改列宽都会让内容高度变，ResizeObserver 会跟着报，
    // 这里只需要在组件换了结果时重新挂一次。
    //
    // 不区分「一条语句」和「多条语句」：这个公式自带上限——永远不超过内容
    // 本身的高度，所以多条结果里的第一条也只会长到它自己那么高，不会为了
    // 占满而撑出空白把后面的推出视野
  }, [result]);

  return (
    <div className="border rounded-panel overflow-hidden bg-surface relative">
      {/* 头部信息栏 */}
      <div className="px-4 py-3 bg-surface-sunken border-b flex items-center justify-between">
        <div className="flex items-center space-x-4 text-sm text-fg-muted">
          <span>{t('result.rowCount', { count: totalRows })}</span>
          {result.truncated && (
            <span className="text-warning">
              {result.truncation_reason === 'byte_limit'
                ? t('result.truncatedByBytes', {
                    limit: Math.round((result.byte_limit ?? 0) / 1024 / 1024)
                  })
                : t('result.truncatedByRows', {
                    limit: result.row_limit?.toLocaleString() ?? ''
                  })}
            </span>
          )}
          <span>{t('result.affectedRows', { count: result.affected_rows })}</span>
          <span>{t('result.executionTime', { time: formatExecutionTime(result.execution_time) })}</span>
          {canEdit && <span className="text-fg-subtle">{t('result.doubleClickToEdit')}</span>}
          {/* 不能改就说清为什么。只把编辑入口收起来，用户会以为这个版本没有这个功能 */}
          {readOnlyReason && (
            <span className="flex items-center gap-1 text-fg-subtle" title={readOnlyReason}>
              <Lock size={12} />
              <span className="max-w-[28rem] truncate">{readOnlyReason}</span>
            </span>
          )}
          <span className="text-fg-subtle">{t('result.copyHint', { shortcut: formatShortcut(SHORTCUTS.copySelection) })}</span>
        </div>
        
        <div className="flex items-center gap-2">
          {canEdit && (
            <button
              onClick={showAddRowForm}
              className="flex items-center space-x-1 px-3 py-1.5 text-sm text-success border border-success-line rounded-control hover:bg-success-soft"
            >
              <Edit size={14} />
              <span>{t('result.addRow')}</span>
            </button>
          )}
          <button
            onClick={() => setShowChart(true)}
            disabled={totalRows === 0}
            className="flex items-center gap-1 rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover disabled:opacity-50"
            title={t('result.chartTitle')}
          >
            <BarChart3 size={14} />
            <span>{t('result.chart')}</span>
          </button>
          <button
            onClick={() => setShowExport(true)}
            disabled={totalRows === 0}
            className="flex items-center gap-1 rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover disabled:opacity-50"
            title={t('result.exportCurrent')}
          >
            <Download size={14} />
            <span>{t('result.export')}</span>
          </button>
        </div>
      </div>

      <PendingChangesBar
        count={changes.length}
        committing={committing}
        error={commitError}
        onPreview={() => setShowChanges(true)}
        onRevertAll={revertAllChanges}
        onCommit={commitChanges}
      />

      {showChanges && (
        <ChangeDiffDialog
          changes={changes}
          target={writeTarget()}
          committing={committing}
          failure={commitFailure}
          onRevert={(id) => setChanges((current) => revertChange(current, id))}
          onRevertAll={revertAllChanges}
          onCommit={commitChanges}
          onClose={() => setShowChanges(false)}
        />
      )}

      {/* 导出的是排序后的整份结果，不是当前这一页——用户看到的次序就是文件里的次序 */}
      {showExport && (
        <ExportResultDialog
          columns={result.columns}
          rows={sortedRows}
          sourceName={editability?.editable ? editability.table : t('result.queryResult')}
          truncated={result.truncated}
          connectionId={connectionId ?? undefined}
          // 只在结果真被截断时才给「完整结果」这一档。没截断时内存里的就是全部，
          // 再跑一遍数据库只是白付一次查询的代价。
          scopes={exportScopes}
          onClose={() => setShowExport(false)}
        />
      )}

      {/* 画的也是排序后的整份结果，和导出同一份：图上的次序就是表上的次序 */}
      {showChart && (
        <ResultChartDialog
          columns={result.columns}
          rows={sortedRows}
          onClose={() => setShowChart(false)}
        />
      )}

      {cells.copyError && (
        <div className="border-b border-danger-line bg-danger-soft px-3 py-1.5 text-xs text-danger">
          {t('result.copyFailed', { reason: cells.copyError })}
        </div>
      )}

      {/* 表格滚动容器 */}
      <div className="relative">
        <div
          ref={scrollContainerRef}
          {...cells.gridProps}
          className="overflow-auto query-result-scroll focus:outline-none"
          style={{
            maxHeight: `${tableHeight}px`,
            width: '100%'
          }}
        >
        <div ref={tableContentRef} style={{ width: `${tableWidth}px`, minWidth: '100%' }}>
          {/* 按量出来的宽度铺，不用 w-full：w-full 会把富余宽度按比例摊给
              各列，量出来的列宽就失去意义了 */}
          <table className="table-fixed border-collapse" style={{ width: `${tableWidth}px` }}>
            <colgroup>
              {widths.map((width, index) => (
                <col key={index} style={{ width: `${width}px` }} />
              ))}
              {canEdit && <col style={{ width: `${ACTION_COLUMN_WIDTH}px` }} />}
            </colgroup>
            <thead>
              <tr className="bg-surface-sunken border-b border-line">
                {result.columns.map((column, index) => (
                  <th
                    key={index}
                    className={clsx(
                      'relative border-r border-line text-left text-xs font-medium text-fg',
                      densityClass
                    )}
                  >
                    <div className="flex items-center gap-1">
                      <ColumnSortButton
                        columnLabel={column}
                        direction={sort?.column === column ? sort.direction : null}
                        onToggle={() => {
                          setSort((current) => nextColumnSort(current, column));
                          setCurrentPage(1);
                        }}
                      />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate" title={column}>{column}</span>
                        {result.column_metadata?.[index] && (
                          // 去掉逐格类型标签后这里是唯一显示类型的地方，
                          // 窄列会截断，所以挂个 title 让悬停能看全
                          <span
                            className="truncate text-[10px] font-normal text-fg-subtle"
                            title={`${result.column_metadata[index].database_type} · ${
                              result.column_metadata[index].nullable === null
                                ? t('result.nullUnknown')
                                : result.column_metadata[index].nullable ? 'NULL' : 'NOT NULL'
                            }`}
                          >
                            {result.column_metadata[index].database_type}
                            {' · '}
                            {result.column_metadata[index].nullable === null
                              ? t('result.nullUnknown')
                              : result.column_metadata[index].nullable
                                ? 'NULL'
                                : 'NOT NULL'}
                          </span>
                        )}
                      </div>
                      {keyColumns.has(column) && (
                        <span className="shrink-0 text-warning" title={t('schema.primaryKey')}>🔑</span>
                      )}
                    </div>
                    <ColumnResizeHandle
                      active={resizingIndex === index}
                      onPointerDown={(event) => startResize(index, event)}
                      onDoubleClick={() => autoFitColumn(index)}
                    />
                  </th>
                ))}
                {canEdit && (
                  <th className={clsx('text-left text-xs font-medium text-fg', densityClass)}>
                    {t('result.actions')}
                  </th>
                )}
              </tr>
            </thead>
            
            <tbody className="divide-y divide-line">
              {/* 新增行表单 */}
              {showAddForm && (
                <tr className="bg-success-soft">
                  {result.columns.map((column, columnIndex) => (
                    <td 
                      key={columnIndex} 
                      className={clsx('border-r border-line', densityClass)}
                    >
                      {keyColumns.has(column) ? (
                        <span className="text-fg-subtle italic text-xs">{t('result.autoGenerated')}</span>
                      ) : (
                        <CellInputEditor
                          value={newRowData[column] ?? { kind: 'unset' }}
                          onChange={(next) => updateNewRowData(column, next)}
                          dataType={columnType(columnIndex)}
                          dialect={dialect}
                        />
                      )}
                    </td>
                  ))}
                  {canEdit && (
                    <td className={densityClass}>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={saveNewRow}
                          className="p-1 text-success hover:bg-success-soft rounded-control"
                        >
                          <Edit size={14} />
                        </button>
                        <button
                          onClick={cancelAddRow}
                          className="p-1 text-fg-muted hover:bg-surface-hover rounded-control"
                        >
                          <Square size={14} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              )}
              
              {/* 数据行 */}
              {currentRows.map((row, rowIndex) => {
                const pending = pendingFor(rowIndex);
                return (
                <tr
                  key={startIndex + rowIndex}
                  className={clsx(
                    'hover:bg-surface-hover',
                    pending?.kind === 'delete' && 'bg-danger-soft line-through opacity-70',
                    pending?.kind === 'update' && 'bg-accent-soft'
                  )}
                >
                  {row.map((cell, cellIndex) => {
                    const isEditing = editingCell?.rowIndex === rowIndex && editingCell?.columnIndex === cellIndex;
                    return (
                      <td
                        key={cellIndex}
                        className={clsx(
                          'relative border-r border-line font-mono text-[13px]',
                          densityClass,
                          alignments[cellIndex] === 'right' && 'text-right',
                          cells.isSelected(rowIndex, cellIndex) && 'bg-accent-soft',
                          cells.isFocused(rowIndex, cellIndex) && 'outline outline-1 -outline-offset-1 outline-accent',
                          canEdit && !isEditing && 'cursor-pointer'
                        )}
                        onClick={(event) => cells.selectCell(rowIndex, cellIndex, event.shiftKey)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          // 右击选区外的格子先选上它：菜单里那几条都作用于选区
                          if (!cells.isSelected(rowIndex, cellIndex)) {
                            cells.selectCell(rowIndex, cellIndex);
                          }
                          setContextTarget({
                            row: rowIndex,
                            column: cellIndex,
                            x: event.clientX,
                            y: event.clientY
                          });
                        }}
                        onDoubleClick={() => canEdit && !isEditing
                          && startEditing(rowIndex, cellIndex, cell)}
                      >
                        {isEditing ? (
                          <CellInputEditor
                            value={editValue}
                            onChange={setEditValue}
                            // SQLite 的 UPDATE 没有 `SET 列 = DEFAULT`
                            allowDefault={dialect !== 'sqlite'}
                            dataType={columnType(cellIndex)}
                            dialect={dialect}
                            autoFocus
                            onCommit={saveEdit}
                            onCancel={cancelEditing}
                          />
                        ) : (
                          // 每格再挂一个类型标签是重复——表头已经写了 BIGINT · NOT NULL，
                          // 而且标签会占掉列宽，让本来放得下的值反而被截断
                          <GridCellValue value={cell} />
                        )}
                      </td>
                    );
                  })}
                  {canEdit && (
                    <td className={densityClass}>
                      {pending ? (
                        // 排了队的行只给一个撤销：再改一次要么覆盖刚才那次，
                        // 要么和待删除打架，两种都不好解释
                        <button
                          onClick={() => setChanges((current) => revertChange(current, pending.id))}
                          className="flex items-center gap-1 rounded-control border border-line-strong px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-surface-hover"
                        >
                          <Undo2 size={11} />
                          {t('changes.revert')}
                        </button>
                      ) : (
                        <button
                          onClick={() => deleteRow(rowIndex)}
                          className="p-1 text-danger hover:bg-danger-soft rounded-control"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      
    </div>
      

      
      {/* 分页控件 */}
      {totalPages > 1 && (
        <div className="px-4 py-3 bg-surface-sunken border-t flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <span className="text-sm text-fg">
              {t('result.range', { from: startIndex + 1, to: endIndex, total: totalRows })}
            </span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setCurrentPage(1);
              }}
              className="text-sm border border-line-strong rounded-control px-2 py-1"
            >
              {GRID_PAGE_SIZE_OPTIONS.map((option) => (
                <option key={option} value={option}>{t('result.pageSizeOption', { size: option })}</option>
              ))}
            </select>
          </div>
          
          <div className="flex items-center space-x-1">
            <button
              onClick={() => setCurrentPage(1)}
              disabled={currentPage === 1}
              className="p-1 rounded-control hover:bg-surface-active disabled:opacity-50"
            >
              <ChevronsLeft size={16} />
            </button>
            <button
              onClick={() => setCurrentPage(currentPage - 1)}
              disabled={currentPage === 1}
              className="p-1 rounded-control hover:bg-surface-active disabled:opacity-50"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="px-3 py-1 text-sm text-fg">
              {t('result.pageOf', { page: currentPage, total: totalPages })}
            </span>
            <button
              onClick={() => setCurrentPage(currentPage + 1)}
              disabled={currentPage === totalPages}
              className="p-1 rounded-control hover:bg-surface-active disabled:opacity-50"
            >
              <ChevronRight size={16} />
            </button>
            <button
              onClick={() => setCurrentPage(totalPages)}
              disabled={currentPage === totalPages}
              className="p-1 rounded-control hover:bg-surface-active disabled:opacity-50"
            >
              <ChevronsRight size={16} />
            </button>
          </div>
        </div>
      )}

      {contextTarget && (
        <GridContextMenu
          target={contextTarget}
          onCopy={(withHeaders) => cells.copy(withHeaders)}
          onCopyRow={(row) => cells.copyRow(row)}
          onCopyColumn={(column) => cells.copyColumn(column, true)}
          onClose={() => setContextTarget(null)}
        />
      )}
    </div>
  );
}; 
