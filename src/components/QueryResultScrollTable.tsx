import React, { useState, useRef } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Square,
  Trash2,
  Edit,
  Download
} from 'lucide-react';
import { clsx } from 'clsx';
import type { QueryResult } from '../contracts/query';
import { useQueryStore } from '../stores/queryStore';
import { formatResultValue, formatResultValueOneLine } from '../utils/resultValues';
import { useResizableColumns } from '../hooks/useResizableColumns';
import { ColumnResizeHandle } from './ColumnResizeHandle';
import { GRID_PAGE_SIZE_OPTIONS } from '../utils/gridPagination';
import { ColumnSortButton } from './ColumnSortButton';
import { nextColumnSort, sortRowsByColumn, type ColumnSort } from '../utils/resultSorting';
import { useCellSelection } from '../hooks/useCellSelection';
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
  const { updateRowData, deleteRowData, insertRowData } = useQueryStore();
  
  // 分页状态
  const [currentPage, setCurrentPage] = useState(1);
  const [sort, setSort] = useState<ColumnSort | null>(null);
  const [pageSize, setPageSize] = useState(25);
  
  // 编辑状态
  const [editingCell, setEditingCell] = useState<{
    rowIndex: number;
    columnIndex: number;
  } | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  
  // 新增行状态
  const [showAddForm, setShowAddForm] = useState(false);
  const [newRowData, setNewRowData] = useState<Record<string, string>>({});
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
  // 必须是稳定引用：useCellSelection 靠引用变化判断「换了一份数据」，
  // 每次渲染现 slice 一个新数组会让选区刚选中就被清掉
  const currentRows = React.useMemo(
    () => sortedRows.slice(startIndex, endIndex),
    [sortedRows, startIndex, endIndex]
  );
  const cells = useCellSelection(currentRows, result.columns.length);
  
  // 判断是否可以编辑
  const canEdit = Boolean(result.table_name && result.primary_key);
  
  const ACTION_COLUMN_WIDTH = 72;
  // 列宽按当前页的内容估算，可拖动覆盖
  const { widths, alignments, totalWidth, startResize, autoFitColumn, resizingIndex } =
    useResizableColumns(result.columns, currentRows);
  const tableWidth = totalWidth + (canEdit ? ACTION_COLUMN_WIDTH : 0);
  
  // 判断是否为时间字段
  const isTimeField = (columnName: string): boolean => {
    const lowerName = columnName.toLowerCase();
    return lowerName.includes('time') || 
           lowerName.includes('date') || 
           lowerName.includes('created') || 
           lowerName.includes('updated') ||
           lowerName.includes('timestamp');
  };
  
  // 编辑相关函数
  const startEditing = (rowIndex: number, columnIndex: number, currentValue: any) => {
    if (!canEdit) return;
    setEditingCell({ rowIndex, columnIndex });
    setEditValue(currentValue === null ? '' : formatResultValue(currentValue));
  };
  
  const cancelEditing = () => {
    setEditingCell(null);
    setEditValue('');
  };
  
  const saveEdit = async () => {
    if (!editingCell || !canEdit) return;
    
    const columnName = result.columns[editingCell.columnIndex];
    await updateRowData(statementId, editingCell.rowIndex + startIndex, columnName, editValue);
    cancelEditing();
  };
  
  const deleteRow = async (rowIndex: number) => {
    if (!canEdit) return;
    
    if (confirm('确定要删除这行数据吗？此操作不可恢复。')) {
      await deleteRowData(statementId, rowIndex + startIndex);
    }
  };
  
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      saveEdit();
    } else if (e.key === 'Escape') {
      cancelEditing();
    }
  };
  
  // 新增行相关函数
  const showAddRowForm = () => {
    if (!canEdit) return;
    
    const initialData: Record<string, string> = {};
    result.columns.forEach(column => {
      if (column !== result.primary_key) {
        initialData[column] = '';
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
      const filteredData: Record<string, any> = {};
      Object.entries(newRowData).forEach(([key, value]) => {
        if (value.trim() !== '') {
          if (isTimeField(key)) {
            if (value === 'NOW' || value === 'now' || value === 'CURRENT_TIMESTAMP') {
              filteredData[key] = 'CURRENT_TIMESTAMP';
            } else {
              try {
                const parsedDate = new Date(value);
                if (!isNaN(parsedDate.getTime())) {
                  filteredData[key] = parsedDate.toISOString();
                } else {
                  filteredData[key] = value;
                }
              } catch {
                filteredData[key] = value;
              }
            }
          } else if (value === 'NULL' || value === 'null') {
            filteredData[key] = null;
          } else if (!isNaN(Number(value)) && value.trim() !== '' && !isTimeField(key)) {
            filteredData[key] = Number(value);
          } else {
            filteredData[key] = value;
          }
        }
      });
      
      await insertRowData(statementId, filteredData);
      cancelAddRow();
    } catch (error) {
      console.error('保存新行失败:', error);
    }
  };
  
  const updateNewRowData = (column: string, value: string) => {
    setNewRowData(prev => ({
      ...prev,
      [column]: value
    }));
  };
  
  return (
    <div className="border rounded-panel overflow-hidden bg-surface relative">
      {/* 头部信息栏 */}
      <div className="px-4 py-3 bg-surface-sunken border-b flex items-center justify-between">
        <div className="flex items-center space-x-4 text-sm text-fg-muted">
          <span>共 {totalRows} 行</span>
          {result.truncated && (
            <span className="text-warning">
              {result.truncation_reason === 'byte_limit'
                ? `已达到 ${Math.round((result.byte_limit ?? 0) / 1024 / 1024)} MiB 内存上限，结果已截断`
                : `已达到 ${result.row_limit?.toLocaleString()} 行上限，结果已截断`}
            </span>
          )}
          <span>影响行数: {result.affected_rows}</span>
          <span>执行时间: {formatExecutionTime(result.execution_time)}</span>
          {canEdit && <span className="text-fg-subtle">双击单元格编辑</span>}
          <span className="text-fg-subtle">点选单元格后 ⌘C 复制</span>
        </div>
        
        <div className="flex items-center gap-2">
          {canEdit && (
            <button
              onClick={showAddRowForm}
              className="flex items-center space-x-1 px-3 py-1.5 text-sm text-success border border-success-line rounded-control hover:bg-success-soft"
            >
              <Edit size={14} />
              <span>新增</span>
            </button>
          )}
          <button
            onClick={() => setShowExport(true)}
            disabled={totalRows === 0}
            className="flex items-center gap-1 rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover disabled:opacity-50"
            title="导出当前结果"
          >
            <Download size={14} />
            <span>导出</span>
          </button>
        </div>
      </div>

      {/* 导出的是排序后的整份结果，不是当前这一页——用户看到的次序就是文件里的次序 */}
      {showExport && (
        <ExportResultDialog
          columns={result.columns}
          rows={sortedRows}
          sourceName={result.table_name ?? '查询结果'}
          truncated={result.truncated}
          onClose={() => setShowExport(false)}
        />
      )}
      
      {cells.copyError && (
        <div className="border-b border-danger-line bg-danger-soft px-3 py-1.5 text-xs text-danger">
          复制失败：{cells.copyError}
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
                                ? 'NULL 未知'
                                : result.column_metadata[index].nullable ? 'NULL' : 'NOT NULL'
                            }`}
                          >
                            {result.column_metadata[index].database_type}
                            {' · '}
                            {result.column_metadata[index].nullable === null
                              ? 'NULL 未知'
                              : result.column_metadata[index].nullable
                                ? 'NULL'
                                : 'NOT NULL'}
                          </span>
                        )}
                      </div>
                      {result.primary_key === column && (
                        <span className="shrink-0 text-warning" title="主键">🔑</span>
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
                  <th className="px-2 py-1 text-left text-xs font-medium text-fg">操作</th>
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
                      {column === result.primary_key ? (
                        <span className="text-fg-subtle italic text-xs">自动生成</span>
                      ) : isTimeField(column) ? (
                        <div className="flex items-center space-x-1">
                          <input
                            type="datetime-local"
                            value={newRowData[column] || ''}
                            onChange={(e) => updateNewRowData(column, e.target.value)}
                            className="flex-1 px-2 py-1 text-sm border border-success-line rounded-control"
                          />
                          <button
                            type="button"
                            onClick={() => updateNewRowData(column, 'NOW')}
                            className="px-2 py-1 text-xs text-success border border-success-line rounded-control hover:bg-success-soft"
                          >
                            NOW
                          </button>
                        </div>
                      ) : (
                        <input
                          type="text"
                          value={newRowData[column] || ''}
                          onChange={(e) => updateNewRowData(column, e.target.value)}
                          placeholder={`输入${column}`}
                          className="w-full px-2 py-1 text-sm border border-success-line rounded-control"
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
                    const displayValue = formatResultValueOneLine(cell);
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
                        onDoubleClick={() => canEdit && !isEditing
                          && startEditing(rowIndex, cellIndex, cell)}
                      >
                        {isEditing ? (
                          <input
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={handleKeyDown}
                            onBlur={cancelEditing}
                            className="w-full rounded-control border border-accent-line px-1 py-0.5 text-sm"
                            autoFocus
                          />
                        ) : cell === null ? (
                          <span className="italic text-fg-subtle">NULL</span>
                        ) : (
                          // 每格再挂一个类型标签是重复——表头已经写了 BIGINT · NOT NULL，
                          // 而且标签会占掉列宽，让本来放得下的值反而被截断
                          <span className="block truncate" title={formatResultValue(cell)}>
                            {displayValue}
                          </span>
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
              显示 {startIndex + 1}-{endIndex} 行，共 {totalRows} 行
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
                <option key={option} value={option}>{option} 条/页</option>
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
              第 {currentPage} 页，共 {totalPages} 页
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
    </div>
  );
}; 
