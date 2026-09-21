import React, { useState, useRef } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Square,
  Trash2,
  Edit,
  Download,
  Lock
} from 'lucide-react';
import { clsx } from 'clsx';
import type { QueryResult } from '../contracts/query';
import { selectSqlDialect, useQueryStore } from '../stores/queryStore';
import { unwrapResultValue } from '../utils/resultValues';
import type { SerializedResultValue } from '../contracts/resultSet';
import { cellInputFromValue, type CellInput } from '../utils/cellInput';
import { CellInputEditor } from './CellInputEditor';
import { useResizableColumns } from '../hooks/useResizableColumns';
import { ColumnResizeHandle } from './ColumnResizeHandle';
import { GRID_PAGE_SIZE_OPTIONS } from '../utils/gridPagination';
import { GridCellValue } from './GridCellValue';
import { GridContextMenu, type GridContextTarget } from './GridContextMenu';
import { ColumnSortButton } from './ColumnSortButton';
import { nextColumnSort, sortRowsByColumn, type ColumnSort } from '../utils/resultSorting';
import { useCellSelection } from '../hooks/useCellSelection';
import { useLanguageStore } from '../stores/languageStore';
import { ExportResultDialog } from './ExportResultDialog';

interface QueryResultScrollTableProps {
  result: QueryResult;
  statementId: string;
  formatExecutionTime: (ms: number) => string;
}

export const QueryResultScrollTable: React.FC<QueryResultScrollTableProps> = ({ 
  result, 
  statementId, 
  formatExecutionTime 
}) => {
  const t = useLanguageStore((state) => state.t);
  const { updateRowData, deleteRowData, insertRowData } = useQueryStore();
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
  
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  
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
  
  // 能不能改由 `describeResultEditability` 证明过：认得出是单表 SELECT，
  // 键来自目录，且键列在投影里。这里只读结论，不再自己拼条件判断
  const editability = result.editability;
  const canEdit = editability?.editable === true;
  const keyColumns = React.useMemo(
    () => new Set(editability?.editable ? editability.keyColumns : []),
    [editability]
  );
  const readOnlyReason = (() => {
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
  
  const saveEdit = async () => {
    if (!editingCell || !canEdit) return;
    
    const columnName = result.columns[editingCell.columnIndex];
    await updateRowData(statementId, editingCell.rowIndex + startIndex, columnName, editValue);
    cancelEditing();
  };
  
  const deleteRow = async (rowIndex: number) => {
    if (!canEdit) return;
    
    if (confirm(t('result.deleteRowConfirm'))) {
      await deleteRowData(statementId, rowIndex + startIndex);
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
  
  const saveNewRow = async () => {
    if (!canEdit) return;

    try {
      // 值原样交给数据库按目标列的类型解析。此前这里按**列名**猜类型，
      // 并把看起来像数字的字符串过一遍 Number()
      await insertRowData(statementId, newRowData);
      cancelAddRow();
    } catch (error) {
      console.error('保存新行失败:', error);
    }
  };

  const updateNewRowData = (column: string, value: CellInput) => {
    setNewRowData(prev => ({ ...prev, [column]: value }));
  };
  
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
          <span className="text-fg-subtle">{t('result.copyHint')}</span>
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

      {/* 导出的是排序后的整份结果，不是当前这一页——用户看到的次序就是文件里的次序 */}
      {showExport && (
        <ExportResultDialog
          columns={result.columns}
          rows={sortedRows}
          sourceName={editability?.editable ? editability.table : t('result.queryResult')}
          truncated={result.truncated}
          onClose={() => setShowExport(false)}
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
            maxHeight: '600px',
            width: '100%'
          }}
        >
        <div style={{ width: `${tableWidth}px`, minWidth: '100%' }}>
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
                    className="relative border-r border-line px-2 py-1 text-left text-xs font-medium text-fg"
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
                  <th className="px-2 py-1 text-left text-xs font-medium text-fg">{t('result.actions')}</th>
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
                      className="border-r border-line px-2 py-1"
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
                    <td className="px-2 py-1">
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
              {currentRows.map((row, rowIndex) => (
                <tr key={startIndex + rowIndex} className="hover:bg-surface-hover">
                  {row.map((cell, cellIndex) => {
                    const isEditing = editingCell?.rowIndex === rowIndex && editingCell?.columnIndex === cellIndex;
                    return (
                      <td
                        key={cellIndex}
                        className={clsx(
                          'relative border-r border-line px-2 py-1 font-mono text-[13px]',
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
                    <td className="px-2 py-1">
                      <button
                        onClick={() => deleteRow(rowIndex)}
                        className="p-1 text-danger hover:bg-danger-soft rounded-control"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
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
