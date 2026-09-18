import React, { useState, useRef, useEffect } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Square,
  Trash2,
  Edit
} from 'lucide-react';
import { clsx } from 'clsx';
import type { QueryResult } from '../contracts/query';
import { useQueryStore } from '../stores/queryStore';

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
  
  // 滚动容器引用
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [hasHorizontalOverflow, setHasHorizontalOverflow] = useState(false);
  
  // 计算分页数据
  const totalRows = result.rows.length;
  const totalPages = Math.ceil(totalRows / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalRows);
  const currentRows = result.rows.slice(startIndex, endIndex);
  
  // 判断是否可以编辑
  const canEdit = Boolean(result.table_name && result.primary_key);
  
  // 计算表格宽度
  const COLUMN_WIDTH = 180; // 每列宽度
  const ACTION_COLUMN_WIDTH = 100; // 操作列宽度
  const tableWidth = result.columns.length * COLUMN_WIDTH + (canEdit ? ACTION_COLUMN_WIDTH : 0);
  
  // 检测是否需要水平滚动
  useEffect(() => {
    const checkOverflow = () => {
      const container = scrollContainerRef.current;
      if (!container) return;
      
      const hasOverflow = container.scrollWidth > container.clientWidth;
      setHasHorizontalOverflow(hasOverflow);
    };
    
    checkOverflow();
    
    // 监听窗口大小变化
    window.addEventListener('resize', checkOverflow);
    
    return () => window.removeEventListener('resize', checkOverflow);
  }, [result.columns.length, tableWidth]);
  
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
    setEditValue(currentValue === null ? '' : String(currentValue));
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
    <div className="border rounded-lg overflow-hidden bg-white relative">
      {/* 头部信息栏 */}
      <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
        <div className="flex items-center space-x-4 text-sm text-gray-600">
          <span>共 {totalRows} 行</span>
          {result.truncated && (
            <span className="text-amber-700">
              {result.truncation_reason === 'byte_limit'
                ? `已达到 ${Math.round((result.byte_limit ?? 0) / 1024 / 1024)} MiB 内存上限，结果已截断`
                : `已达到 ${result.row_limit?.toLocaleString()} 行上限，结果已截断`}
            </span>
          )}
          <span>影响行数: {result.affected_rows}</span>
          <span>执行时间: {formatExecutionTime(result.execution_time)}</span>
          {canEdit && <span className="text-green-600">✓ 支持数据编辑</span>}
        </div>
        
        {canEdit && (
          <button
            onClick={showAddRowForm}
            className="flex items-center space-x-1 px-3 py-1.5 text-sm text-green-600 border border-green-300 rounded hover:bg-green-50"
          >
            <Edit size={14} />
            <span>新增</span>
          </button>
        )}
      </div>
      
      {/* 滚动提示 */}
      {hasHorizontalOverflow && (
        <div className="px-4 py-2 bg-blue-50 text-xs text-blue-700">
          <span>💡 表格包含 {result.columns.length} 列，可以水平滚动查看所有内容</span>
        </div>
      )}
      
      {/* 表格滚动容器 */}
      <div className="relative">
        <div 
          ref={scrollContainerRef}
          className={clsx(
            "overflow-y-auto query-result-scroll",
            hasHorizontalOverflow ? "overflow-x-auto" : "overflow-x-hidden"
          )}
          style={{
            maxHeight: '600px',
            width: '100%'
          }}
        >
        <div style={{ width: `${tableWidth}px`, minWidth: '100%' }}>
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-gray-50 border-b">
                {result.columns.map((column, index) => (
                  <th
                    key={index}
                    className="px-3 py-2 text-left text-xs font-medium text-gray-700 uppercase tracking-wider border-r border-gray-200"
                    style={{ width: `${COLUMN_WIDTH}px` }}
                  >
                    <div className="flex items-center space-x-1">
                      <div className="flex flex-col">
                        <span>{column}</span>
                        {result.column_metadata?.[index] && (
                          <span className="text-[10px] font-normal normal-case text-gray-400">
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
                        <span className="text-yellow-600" title="主键">🔑</span>
                      )}
                    </div>
                  </th>
                ))}
                {canEdit && (
                  <th 
                    className="px-3 py-2 text-left text-xs font-medium text-gray-700 uppercase tracking-wider"
                    style={{ width: `${ACTION_COLUMN_WIDTH}px` }}
                  >
                    操作
                  </th>
                )}
              </tr>
            </thead>
            
            <tbody className="divide-y divide-gray-200">
              {/* 新增行表单 */}
              {showAddForm && (
                <tr className="bg-green-50">
                  {result.columns.map((column, columnIndex) => (
                    <td 
                      key={columnIndex} 
                      className="px-3 py-2 border-r border-gray-200"
                      style={{ width: `${COLUMN_WIDTH}px` }}
                    >
                      {column === result.primary_key ? (
                        <span className="text-gray-400 italic text-xs">自动生成</span>
                      ) : isTimeField(column) ? (
                        <div className="flex items-center space-x-1">
                          <input
                            type="datetime-local"
                            value={newRowData[column] || ''}
                            onChange={(e) => updateNewRowData(column, e.target.value)}
                            className="flex-1 px-2 py-1 text-sm border border-green-300 rounded"
                          />
                          <button
                            type="button"
                            onClick={() => updateNewRowData(column, 'NOW')}
                            className="px-2 py-1 text-xs text-green-600 border border-green-300 rounded hover:bg-green-50"
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
                          className="w-full px-2 py-1 text-sm border border-green-300 rounded"
                        />
                      )}
                    </td>
                  ))}
                  {canEdit && (
                    <td className="px-3 py-2" style={{ width: `${ACTION_COLUMN_WIDTH}px` }}>
                      <div className="flex items-center space-x-1">
                        <button
                          onClick={saveNewRow}
                          className="p-1 text-green-600 hover:bg-green-50 rounded"
                        >
                          <Edit size={14} />
                        </button>
                        <button
                          onClick={cancelAddRow}
                          className="p-1 text-gray-600 hover:bg-gray-50 rounded"
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
                <tr key={startIndex + rowIndex} className="hover:bg-gray-50">
                  {row.map((cell, cellIndex) => {
                    const isEditing = editingCell?.rowIndex === rowIndex && editingCell?.columnIndex === cellIndex;
                    return (
                      <td
                        key={cellIndex}
                        className={clsx(
                          "px-3 py-2 text-sm border-r border-gray-200",
                          canEdit && !isEditing ? "cursor-pointer hover:bg-blue-50" : ""
                        )}
                        style={{ width: `${COLUMN_WIDTH}px` }}
                        onClick={() => canEdit && !isEditing && startEditing(rowIndex, cellIndex, cell)}
                      >
                        {isEditing ? (
                          <input
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={handleKeyDown}
                            onBlur={cancelEditing}
                            className="w-full px-2 py-1 text-sm border border-blue-300 rounded"
                            autoFocus
                          />
                        ) : (
                          <div className="truncate" title={String(cell)}>
                            {cell === null ? <span className="text-gray-400 italic">NULL</span> : String(cell)}
                          </div>
                        )}
                      </td>
                    );
                  })}
                  {canEdit && (
                    <td className="px-3 py-2" style={{ width: `${ACTION_COLUMN_WIDTH}px` }}>
                      <button
                        onClick={() => deleteRow(rowIndex)}
                        className="p-1 text-red-600 hover:bg-red-50 rounded"
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
      
      {/* 底部滚动提示 */}
      {hasHorizontalOverflow && (
        <div className="h-6 bg-gradient-to-t from-gray-100 to-transparent flex items-center justify-center text-xs text-gray-500">
          <span className="animate-pulse">⟵ 水平滚动查看更多内容 ⟶</span>
        </div>
      )}
    </div>
      

      
      {/* 分页控件 */}
      {totalPages > 1 && (
        <div className="px-4 py-3 bg-gray-50 border-t flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <span className="text-sm text-gray-700">
              显示 {startIndex + 1}-{endIndex} 行，共 {totalRows} 行
            </span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setCurrentPage(1);
              }}
              className="text-sm border border-gray-300 rounded px-2 py-1"
            >
              <option value={10}>10条/页</option>
              <option value={25}>25条/页</option>
              <option value={50}>50条/页</option>
              <option value={100}>100条/页</option>
            </select>
          </div>
          
          <div className="flex items-center space-x-1">
            <button
              onClick={() => setCurrentPage(1)}
              disabled={currentPage === 1}
              className="p-1 rounded hover:bg-gray-200 disabled:opacity-50"
            >
              <ChevronsLeft size={16} />
            </button>
            <button
              onClick={() => setCurrentPage(currentPage - 1)}
              disabled={currentPage === 1}
              className="p-1 rounded hover:bg-gray-200 disabled:opacity-50"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="px-3 py-1 text-sm text-gray-700">
              第 {currentPage} 页，共 {totalPages} 页
            </span>
            <button
              onClick={() => setCurrentPage(currentPage + 1)}
              disabled={currentPage === totalPages}
              className="p-1 rounded hover:bg-gray-200 disabled:opacity-50"
            >
              <ChevronRight size={16} />
            </button>
            <button
              onClick={() => setCurrentPage(totalPages)}
              disabled={currentPage === totalPages}
              className="p-1 rounded hover:bg-gray-200 disabled:opacity-50"
            >
              <ChevronsRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}; 
