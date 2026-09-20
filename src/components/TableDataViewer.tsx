import React, { useState, useEffect, useRef } from 'react';
import { useQueryStore } from '../stores/queryStore';
import {
  X,
  // Database as DatabaseIcon,
  ChevronLeft,
  ChevronRight,
  FileText,
  Table,
  GitBranch,
  Calendar,
  Clock,
  RefreshCw,
  Info,
  Plus,
  Save,
  AlertCircle,
  Edit,
  Trash2,
  Check,
  ChevronsLeft,
  ChevronsRight,
  BarChart3
} from 'lucide-react';
import clsx from 'clsx';
import type {
  ColumnInfo,
  ConnectionProfile,
  TableSchema
} from '../contracts';
import { assertSingleRowAffected } from '../utils/executeResult';
import { quoteQualifiedSqlIdentifier, quoteSqlIdentifier } from '../utils/sqlIdentifiers';
import {
  createTablePaginationOrder,
  type TablePaginationOrder
} from '../utils/tablePagination';

// 编辑模式类型
type EditMode = 'view' | 'edit' | 'add';

// 编辑状态接口
interface EditState {
  mode: EditMode;
  rowIndex?: number;
  originalData?: any;
  editedData?: any;
}

// 日期时间选择器状态
interface DateTimePickerState {
  isOpen: boolean;
  field: string;
  value: string;
}

interface TableDataViewerProps {
  connection: ConnectionProfile;
  tableName: string;
  schema?: string;
  initialTab?: TabType;
  onClose?: () => void;
}

// 标签页类型
type TabType = 'schema' | 'data' | 'er';

export default function TableDataViewer({ 
  connection,
  tableName, 
  schema, 
  initialTab,
  onClose 
}: TableDataViewerProps) {
  const [tableSchema, setTableSchema] = useState<TableSchema | null>(null);
  const [tableSchemaKey, setTableSchemaKey] = useState<string | null>(null);
  const [tableData, setTableData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [totalRows, setTotalRows] = useState(0);
  const [paginationOrder, setPaginationOrder] = useState<TablePaginationOrder | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>(initialTab ?? 'data');
  
  // 编辑功能相关状态
  const [editState, setEditState] = useState<EditState>({ mode: 'view' });
  const [editingLoading, setEditingLoading] = useState(false);
  const [editingError, setEditingError] = useState<string | null>(null);
  
  // 日期时间选择器状态
  const [dateTimePicker, setDateTimePicker] = useState<DateTimePickerState>({
    isOpen: false,
    field: '',
    value: ''
  });
  
  const { database, connectionId } = useQueryStore();
  const currentTableKey = `${connection.id}:${schema ?? ''}:${tableName}`;

  // COUNT(*) 在大表上是全表扫描（InnoDB 与 PostgreSQL 都没有常数级行数），
  // 按数据集身份缓存，使翻页和调整页大小不再重复付这笔代价。
  // 用 ref 而非 state：调用方在同一次事件中失效缓存并立即加载，
  // 若用 state，loadTableData 闭包里仍是旧值，会读到本应失效的计数。
  const rowCountCacheRef = useRef<{ key: string; total: number } | null>(null);

  // 标签页配置
  const tabs = [
    {
      id: 'schema' as TabType,
      label: 'Schema',
      icon: <FileText size={16} />,
      description: '表结构信息'
    },
    {
      id: 'data' as TabType,
      label: '数据',
      icon: <Table size={16} />,
      description: '表数据内容'
    },
    {
      id: 'er' as TabType,
      label: 'ER 图',
      icon: <GitBranch size={16} />,
      description: '数据库关系图'
    }
  ];

  // 检查并确保数据库连接
  const ensureDatabaseConnection = async () => {
    if (!database) {
      setError('数据库会话不可用，请先重新连接');
      return false;
    }

    // 标签永久绑定到打开它的连接。活跃会话切到别的连接时必须停下：
    // database 是全局唯一会话，继续执行会拿本表的表名去查另一个库。
    if (connectionId !== connection.id) {
      setError(`此标签绑定的连接「${connection.name}」当前未激活，请在左侧重新选择该连接后再操作`);
      return false;
    }

    return true;
  };

  // 加载表结构信息
  const loadTableSchema = async (): Promise<TableSchema | null> => {
    if (!await ensureDatabaseConnection()) return null;
    
    try {
      let schemaQuery = '';
      
      switch (connection.db_type) {
        case 'postgresql':
          schemaQuery = `
            SELECT 
              c.column_name,
              c.data_type,
              c.is_nullable,
              c.column_default,
              CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary_key,
              pk.primary_key_ordinal
            FROM information_schema.columns c
            LEFT JOIN (
              SELECT kcu.table_schema, kcu.table_name, kcu.column_name,
                     kcu.ordinal_position as primary_key_ordinal
              FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu
                ON tc.constraint_schema = kcu.constraint_schema
               AND tc.constraint_name = kcu.constraint_name
               AND tc.table_schema = kcu.table_schema
               AND tc.table_name = kcu.table_name
              WHERE tc.constraint_type = 'PRIMARY KEY'
            ) pk ON c.table_schema = pk.table_schema
                AND c.table_name = pk.table_name
                AND c.column_name = pk.column_name
            WHERE c.table_name = $1
              AND c.table_schema = COALESCE($2, current_schema())
            ORDER BY c.ordinal_position
          `;
          break;
        case 'mysql':
          schemaQuery = `
            SELECT 
              c.COLUMN_NAME as column_name,
              c.DATA_TYPE as data_type,
              c.IS_NULLABLE as is_nullable,
              c.COLUMN_DEFAULT as column_default,
              kcu.COLUMN_NAME IS NOT NULL as is_primary_key,
              kcu.ORDINAL_POSITION as primary_key_ordinal
            FROM INFORMATION_SCHEMA.COLUMNS c
            LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
              ON c.TABLE_SCHEMA = kcu.TABLE_SCHEMA
             AND c.TABLE_NAME = kcu.TABLE_NAME
             AND c.COLUMN_NAME = kcu.COLUMN_NAME
             AND kcu.CONSTRAINT_NAME = 'PRIMARY'
            WHERE c.TABLE_NAME = ?
              AND c.TABLE_SCHEMA = COALESCE(?, DATABASE())
            ORDER BY c.ORDINAL_POSITION
          `;
          break;
        case 'sqlite':
          schemaQuery = `PRAGMA table_info(${quoteSqlIdentifier(tableName, 'sqlite')})`;
          break;
      }
      
      const columnsResult = await database!.select(
        schemaQuery,
        connection.db_type === 'sqlite' ? [] : [tableName, schema ?? null]
      );
      
      const columns: ColumnInfo[] = Array.isArray(columnsResult) ? columnsResult.map((col: any) => {
        const primaryKeyOrdinal = Number(col.primary_key_ordinal ?? col.pk ?? 0);
        return {
          name: col.column_name || col.name,
          data_type: col.data_type || col.type,
          is_nullable: col.is_nullable === 'YES' || col.notnull === 0,
          is_primary_key: primaryKeyOrdinal > 0 || col.is_primary_key === true,
          primary_key_ordinal: primaryKeyOrdinal > 0 ? primaryKeyOrdinal : undefined,
          default_value: col.column_default || col.dflt_value
        };
      }) : [];
      
      const loadedSchema = { columns };
      setTableSchema(loadedSchema);
      setTableSchemaKey(currentTableKey);
      return loadedSchema;
    } catch (err) {
      console.error('加载表结构失败:', err);
      setError('加载表结构失败');
      return null;
    }
  };

  // 加载表数据
  const loadTableData = async (page: number = 1, requestedPageSize: number = pageSize) => {
    if (!await ensureDatabaseConnection()) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const dialect = connection.db_type === 'mysql' ? 'mysql' : connection.db_type === 'postgresql' ? 'postgresql' : 'sqlite';
      const tableReference = quoteQualifiedSqlIdentifier(
        schema ? [schema, tableName] : [tableName],
        dialect
      );
      const loadedSchema = tableSchemaKey === currentTableKey
        ? tableSchema
        : await loadTableSchema();
      if (!loadedSchema) {
        throw new Error('无法加载表结构，已停止不稳定的分页查询');
      }
      const order = createTablePaginationOrder(loadedSchema.columns, dialect);
      setPaginationOrder(order);

      // 获取总行数：仅在数据集身份变化或缓存被显式失效时重新统计
      const cachedRowCount = rowCountCacheRef.current;
      let total: number;
      if (cachedRowCount && cachedRowCount.key === currentTableKey) {
        total = cachedRowCount.total;
      } else {
        const countQuery = `SELECT COUNT(*) as total FROM ${tableReference}`;
        const countResult = await database!.select(countQuery);
        total = Array.isArray(countResult) && countResult.length > 0
          ? countResult[0].total || 0
          : 0;
        rowCountCacheRef.current = { key: currentTableKey, total };
      }

      setTotalRows(total);
      
      // 获取分页数据
      const offset = (page - 1) * requestedPageSize;
      let dataQuery = '';
      
      switch (connection.db_type) {
        case 'postgresql':
          dataQuery = `SELECT * FROM ${tableReference} ${order.clause} LIMIT $1 OFFSET $2`;
          break;
        case 'mysql':
          dataQuery = `SELECT * FROM ${tableReference} ${order.clause} LIMIT ? OFFSET ?`;
          break;
        case 'sqlite':
          dataQuery = `SELECT * FROM ${tableReference} ${order.clause} LIMIT ${requestedPageSize} OFFSET ${offset}`;
          break;
      }
      
      const dataResult = await database!.select(dataQuery, 
        connection.db_type === 'sqlite' ? [] : [requestedPageSize, offset]
      );
      
      setTableData(Array.isArray(dataResult) ? dataResult : []);
    } catch (err) {
      console.error('加载表数据失败:', err);
      setError('加载表数据失败');
    } finally {
      setLoading(false);
    }
  };

  // 组件挂载时加载数据
  useEffect(() => {
    const initializeViewer = async () => {
      if (tableName) {
        // 确保数据库连接
        if (await ensureDatabaseConnection()) {
          // 根据当前标签页加载相应数据
          if (activeTab === 'schema') {
            loadTableSchema();
          } else if (activeTab === 'data') {
            loadTableData(1);
          }
        }
      }
    };
    
    initializeViewer();
  }, [tableName, schema, activeTab, connectionId]); // connectionId：绑定的连接重新激活后自动恢复加载

  // 点击外部关闭日期时间选择器
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dateTimePicker.isOpen) {
        const target = event.target as Element;
        if (!target.closest('.datetime-picker')) {
          setDateTimePicker({ isOpen: false, field: '', value: '' });
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [dateTimePicker.isOpen]);

  // 处理分页变化
  const handlePageChange = (newPage: number) => {
    setCurrentPage(newPage);
    loadTableData(newPage);
  };

  // 处理页面大小变化
  const handlePageSizeChange = (newPageSize: number) => {
    setPageSize(newPageSize);
    setCurrentPage(1);
    loadTableData(1, newPageSize);
  };

  // 计算总页数
  const totalPages = Math.ceil(totalRows / pageSize);

  // 处理标签页切换
  const handleTabChange = (tabId: TabType) => {
    setActiveTab(tabId);
    
    // 根据标签页类型加载相应数据
    if (tabId === 'schema' && !tableSchema) {
      loadTableSchema();
    } else if (tabId === 'data' && tableData.length === 0) {
      loadTableData(1);
    }
  };

  // 编辑功能工具函数
  
  // 开始编辑行
  const startEditRow = (rowIndex: number) => {
    const rowData = tableData[rowIndex];
    setEditState({
      mode: 'edit',
      rowIndex,
      originalData: { ...rowData },
      editedData: { ...rowData }
    });
    setEditingError(null);
  };

  // 开始添加新行
  const startAddRow = () => {
    const newRowData: any = {};
    if (tableSchema) {
      tableSchema.columns.forEach(col => {
        // 如果是自增主键，设置为null或空字符串
        if (col.is_primary_key && (col.data_type.includes('serial') || col.data_type.includes('auto_increment'))) {
          newRowData[col.name] = null;
        } else if (col.default_value) {
          // 处理默认值
          if (col.data_type.includes('int') || col.data_type.includes('bigint')) {
            newRowData[col.name] = col.default_value === 'NULL' ? null : Number(col.default_value);
          } else if (col.data_type.includes('float') || col.data_type.includes('decimal') || col.data_type.includes('numeric')) {
            newRowData[col.name] = col.default_value === 'NULL' ? null : Number(col.default_value);
          } else if (col.data_type.includes('bool')) {
            newRowData[col.name] = col.default_value === 'true';
          } else {
            // 移除字符串默认值的引号
            let defaultValue = col.default_value;
            if (defaultValue.startsWith("'") && defaultValue.endsWith("'")) {
              defaultValue = defaultValue.slice(1, -1);
            }
            newRowData[col.name] = defaultValue === 'NULL' ? null : defaultValue;
          }
        } else if (col.is_nullable) {
          newRowData[col.name] = null;
        } else {
          // 非空字段设置空字符串，用户需要填写
          newRowData[col.name] = '';
        }
      });
    }
    
    setEditState({
      mode: 'add',
      editedData: newRowData
    });
    setEditingError(null);
  };

  // 取消编辑
  const cancelEdit = () => {
    setEditState({ mode: 'view' });
    setEditingError(null);
  };

  // 保存编辑
  const saveEdit = async () => {
    if (!editState.editedData) return;
    
    setEditingLoading(true);
    setEditingError(null);
    
    try {
      if (editState.mode === 'add') {
        await insertRow(editState.editedData);
        // 新增改变了表的基数，就地编辑不会，因此只在这里失效计数缓存
        rowCountCacheRef.current = null;
      } else if (editState.mode === 'edit' && editState.rowIndex !== undefined) {
        await updateRow(editState.rowIndex, editState.editedData);
      }
      
      setEditState({ mode: 'view' });
      // 重新加载当前页数据
      await loadTableData(currentPage);
    } catch (error) {
      console.error('保存失败:', error);
      setEditingError(error instanceof Error ? error.message : '保存失败');
    } finally {
      setEditingLoading(false);
    }
  };

  // 删除行
  const deleteRow = async (rowIndex: number) => {
    if (!confirm('确定要删除这条数据吗？此操作不可撤销。')) {
      return;
    }
    
    setEditingLoading(true);
    setEditingError(null);
    
    try {
      await removeRow(rowIndex);
      rowCountCacheRef.current = null;
      // 重新加载当前页数据
      await loadTableData(currentPage);
    } catch (error) {
      console.error('删除失败:', error);
      setEditingError(error instanceof Error ? error.message : '删除失败');
    } finally {
      setEditingLoading(false);
    }
  };

  // 更新编辑数据
  const updateEditData = (field: string, value: any) => {
    if (editState.editedData) {
      setEditState({
        ...editState,
        editedData: {
          ...editState.editedData,
          [field]: value
        }
      });
    }
  };

  // 数据库操作函数
  
  // 插入新行
  const insertRow = async (rowData: any) => {
    if (!database || !tableSchema) return;
    
    // 过滤掉空值和主键列（如果是自增主键）
    const columns = Object.keys(rowData).filter(key => {
      const value = rowData[key];
      const column = tableSchema.columns.find(col => col.name === key);
      
      // 如果是自增主键且值为空，则跳过
      if (column?.is_primary_key && (value === null || value === '' || value === undefined)) {
        return false;
      }
      
      // 如果是非空字段且值为空，则跳过
      if (!column?.is_nullable && (value === null || value === '' || value === undefined)) {
        return false;
      }
      
      return true;
    });
    
    if (columns.length === 0) {
      throw new Error('没有有效的列可以插入');
    }
    
    const values = columns.map(key => {
      const value = rowData[key];
      const column = tableSchema.columns.find(col => col.name === key);
      
      // 根据数据类型转换值
      if (value === null || value === '' || value === undefined) {
        return null;
      }
      
      if (column?.data_type.includes('int') || column?.data_type.includes('bigint')) {
        return Number(value);
      } else if (column?.data_type.includes('float') || column?.data_type.includes('decimal') || column?.data_type.includes('numeric')) {
        return Number(value);
      } else if (column?.data_type.includes('bool')) {
        return Boolean(value);
      } else if (column?.data_type.includes('date') || column?.data_type.includes('time') || column?.data_type.includes('timestamp')) {
        // 处理日期时间格式
        if (value === 'CURRENT_TIMESTAMP' || value === 'NOW') {
          return 'CURRENT_TIMESTAMP';
        } else if (typeof value === 'string' && value.trim() !== '') {
          // 确保日期时间格式正确
          return value;
        } else {
          return null;
        }
      } else {
        return String(value);
      }
    });
    
    const placeholders = columns.map((_, index) => {
      switch (connection.db_type) {
        case 'postgresql':
          return `$${index + 1}`;
        case 'mysql':
          return '?';
        case 'sqlite':
          return '?';
        default:
          return '?';
      }
    });
    
    const dialect = connection.db_type === 'mysql' ? 'mysql' : connection.db_type === 'postgresql' ? 'postgresql' : 'sqlite';
    const tableNameWithSchema = quoteQualifiedSqlIdentifier(
      schema ? [schema, tableName] : [tableName],
      dialect
    );
    const quotedColumns = columns.map(column => quoteSqlIdentifier(column, dialect));
    const insertQuery = `INSERT INTO ${tableNameWithSchema} (${quotedColumns.join(', ')}) VALUES (${placeholders.join(', ')})`;
    
    console.log('插入查询:', insertQuery);
    console.log('插入值:', values);
    
    await database.execute(insertQuery, values);
  };

  // 更新行
  const updateRow = async (_rowIndex: number, rowData: any) => {
    if (!database || !tableSchema || !editState.originalData) return;
    
    // 找到主键列
    const primaryKeyColumn = tableSchema.columns.find(col => col.is_primary_key);
    if (!primaryKeyColumn) {
      throw new Error('无法找到主键列，无法更新数据');
    }
    
    const pkValue = editState.originalData[primaryKeyColumn.name];
    const pkColumn = primaryKeyColumn.name;
    
    // 构建更新语句
    const updateColumns = Object.keys(rowData).filter(key => {
      if (key === pkColumn) return false; // 跳过主键列
      
      const newValue = rowData[key];
      const oldValue = editState.originalData![key];
      
      // 检查值是否真的发生了变化
      if (newValue === oldValue) return false;
      
      // 处理 null 值的比较
      if (newValue === null && oldValue === null) return false;
      if (newValue === '' && oldValue === null) return false;
      if (newValue === null && oldValue === '') return false;
      
      return true;
    });
    
    if (updateColumns.length === 0) {
      // 没有变化，直接返回
      return;
    }
    
    const dialect = connection.db_type === 'mysql' ? 'mysql' : connection.db_type === 'postgresql' ? 'postgresql' : 'sqlite';
    const setClause = updateColumns.map((col, index) => {
      const quotedColumn = quoteSqlIdentifier(col, dialect);
      switch (connection.db_type) {
        case 'postgresql':
          return `${quotedColumn} = $${index + 1}`;
        case 'mysql':
        case 'sqlite':
          return `${quotedColumn} = ?`;
        default:
          return `${quotedColumn} = ?`;
      }
    }).join(', ');
    
    const quotedPrimaryKey = quoteSqlIdentifier(pkColumn, dialect);
    const whereClause = connection.db_type === 'postgresql' 
      ? `${quotedPrimaryKey} = $${updateColumns.length + 1}`
      : `${quotedPrimaryKey} = ?`;
    
    const tableNameWithSchema = quoteQualifiedSqlIdentifier(
      schema ? [schema, tableName] : [tableName],
      dialect
    );
    const updateQuery = `UPDATE ${tableNameWithSchema} SET ${setClause} WHERE ${whereClause}`;
    
    // 转换数据类型
    const values = updateColumns.map(col => {
      const value = rowData[col];
      const column = tableSchema.columns.find(c => c.name === col);
      
      if (value === null || value === '' || value === undefined) {
        return null;
      }
      
      if (column?.data_type.includes('int') || column?.data_type.includes('bigint')) {
        return Number(value);
      } else if (column?.data_type.includes('float') || column?.data_type.includes('decimal') || column?.data_type.includes('numeric')) {
        return Number(value);
      } else if (column?.data_type.includes('bool')) {
        return Boolean(value);
      } else if (column?.data_type.includes('date') || column?.data_type.includes('time') || column?.data_type.includes('timestamp')) {
        // 处理日期时间格式
        if (value === 'CURRENT_TIMESTAMP' || value === 'NOW') {
          return 'CURRENT_TIMESTAMP';
        } else if (typeof value === 'string' && value.trim() !== '') {
          // 确保日期时间格式正确
          return value;
        } else {
          return null;
        }
      } else {
        return String(value);
      }
    });
    
    // 添加主键值
    values.push(pkValue);
    
    console.log('更新查询:', updateQuery);
    console.log('更新值:', values);
    
    const updateResult = await database.execute(updateQuery, values);
    assertSingleRowAffected(updateResult, '更新');
  };

  // 删除行
  const removeRow = async (rowIndex: number) => {
    if (!database || !tableSchema) return;
    
    const rowData = tableData[rowIndex];
    
    // 找到主键列
    const primaryKeyColumn = tableSchema.columns.find(col => col.is_primary_key);
    if (!primaryKeyColumn) {
      throw new Error('无法找到主键列，无法删除数据');
    }
    
    const pkValue = rowData[primaryKeyColumn.name];
    const pkColumn = primaryKeyColumn.name;
    
    const dialect = connection.db_type === 'mysql' ? 'mysql' : connection.db_type === 'postgresql' ? 'postgresql' : 'sqlite';
    const tableNameWithSchema = quoteQualifiedSqlIdentifier(
      schema ? [schema, tableName] : [tableName],
      dialect
    );
    const quotedPrimaryKey = quoteSqlIdentifier(pkColumn, dialect);
    
    // 根据数据库类型构建不同的DELETE语句
    let deleteQuery: string;
    let values: any[];
    
    switch (connection.db_type) {
      case 'postgresql':
        deleteQuery = `DELETE FROM ${tableNameWithSchema} WHERE ${quotedPrimaryKey} = $1`;
        values = [pkValue];
        break;
      case 'mysql':
      case 'sqlite':
        deleteQuery = `DELETE FROM ${tableNameWithSchema} WHERE ${quotedPrimaryKey} = ?`;
        values = [pkValue];
        break;
      default:
        deleteQuery = `DELETE FROM ${tableNameWithSchema} WHERE ${quotedPrimaryKey} = ?`;
        values = [pkValue];
    }
    
    console.log('删除查询:', deleteQuery);
    console.log('删除值:', values);
    
    const deleteResult = await database.execute(deleteQuery, values);
    assertSingleRowAffected(deleteResult, '删除');
  };

  // 可编辑单元格组件
  const EditableCell = ({ 
    value, 
    field, 
    isEditing, 
    isPrimaryKey = false,
    dataType = 'text'
  }: {
    value: any;
    field: string;
    isEditing: boolean;
    isPrimaryKey?: boolean;
    dataType?: string;
  }) => {
    // 获取当前编辑的值
    const currentValue = isEditing && editState.editedData ? editState.editedData[field] : value;
    
    // 判断是否为日期时间字段
    const isDateTimeField = dataType.includes('date') || 
                           dataType.includes('time') || 
                           dataType.includes('timestamp');
    
    if (!isEditing || isPrimaryKey) {
      // 非编辑状态或主键列，显示只读
      return (
        <td className="px-4 py-3 text-sm text-gray-900 border-r border-gray-200 min-w-[180px]">
          <div className="truncate" title={currentValue === null || currentValue === undefined ? 'NULL' : String(currentValue)}>
            {currentValue === null || currentValue === undefined ? (
              <span className="text-gray-400 italic">NULL</span>
            ) : typeof currentValue === 'object' ? (
              <span className="text-gray-500">{JSON.stringify(currentValue)}</span>
            ) : (
              String(currentValue)
            )}
          </div>
        </td>
      );
    }

    // 编辑状态
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      let newValue: any = e.target.value;
      
      // 根据数据类型转换值
      if (dataType.includes('int') || dataType.includes('bigint') || dataType.includes('number')) {
        newValue = newValue === '' ? null : Number(newValue);
      } else if (dataType.includes('float') || dataType.includes('decimal') || dataType.includes('numeric')) {
        newValue = newValue === '' ? null : Number(newValue);
      } else if (dataType.includes('bool')) {
        newValue = newValue === 'true';
      } else if (newValue === '') {
        newValue = null;
      }
      
      updateEditData(field, newValue);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        saveEdit();
      } else if (e.key === 'Escape') {
        cancelEdit();
      }
    };

    const inputValue = currentValue === null ? '' : String(currentValue);

    return (
      <td className="px-4 py-3 border-r border-gray-200 min-w-[180px]">
        {isDateTimeField ? (
          <DateTimePicker
            field={field}
            value={inputValue}
            onChange={(value) => updateEditData(field, value)}
            dataType={dataType}
          />
        ) : (
          <input
            type={dataType.includes('int') || dataType.includes('bigint') || dataType.includes('number') || dataType.includes('float') || dataType.includes('decimal') || dataType.includes('numeric') ? 'number' : 'text'}
            value={inputValue}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onBlur={cancelEdit}
            className="w-full px-2 py-1 text-sm border border-blue-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder={dataType.includes('int') || dataType.includes('bigint') || dataType.includes('number') || dataType.includes('float') || dataType.includes('decimal') || dataType.includes('numeric') ? '0' : '输入值'}
            autoFocus
          />
        )}
      </td>
    );
  };

  // 日期时间选择器组件
  const DateTimePicker = ({ 
    field, 
    value, 
    onChange, 
    dataType = 'timestamp' 
  }: {
    field: string;
    value: string;
    onChange: (value: string) => void;
    dataType?: string;
  }) => {
    const isOpen = dateTimePicker.isOpen && dateTimePicker.field === field;
    
    const openPicker = () => {
      setDateTimePicker({
        isOpen: true,
        field,
        value: value || new Date().toISOString().slice(0, 16)
      });
    };
    
    const closePicker = () => {
      setDateTimePicker({ isOpen: false, field: '', value: '' });
    };
    
    const handleDateTimeChange = (newValue: string) => {
      setDateTimePicker(prev => ({ ...prev, value: newValue }));
    };
    
    const applyDateTime = () => {
      onChange(dateTimePicker.value);
      closePicker();
    };
    
    const setCurrentTime = () => {
      const now = new Date();
      let formattedValue = '';
      
      if (dataType.includes('date')) {
        formattedValue = now.toISOString().split('T')[0];
      } else if (dataType.includes('time')) {
        formattedValue = now.toTimeString().split(' ')[0];
      } else {
        formattedValue = now.toISOString().slice(0, 19).replace('T', ' ');
      }
      
      onChange(formattedValue);
      closePicker();
    };
    
    const setNull = () => {
      onChange('');
      closePicker();
    };
    
    return (
      <div className="relative datetime-picker">
        <div className="flex items-center space-x-1">
          <input
            type={dataType.includes('date') ? 'date' : dataType.includes('time') ? 'time' : 'datetime-local'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder={dataType.includes('date') ? '选择日期' : dataType.includes('time') ? '选择时间' : '选择日期时间'}
          />
          <button
            type="button"
            onClick={openPicker}
            className="px-2 py-1 text-xs text-blue-600 border border-blue-300 rounded hover:bg-blue-50"
            title="打开日期时间选择器"
          >
            <Calendar size={12} />
          </button>
        </div>
        
        {isOpen && (
          <div className="absolute top-full left-0 mt-1 bg-white border border-gray-300 rounded-lg shadow-lg z-50 min-w-[280px]">
            <div className="p-3 border-b border-gray-200">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-medium text-gray-900">日期时间选择</h4>
                <button
                  onClick={closePicker}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <X size={16} />
                </button>
              </div>
              
              <div className="space-y-2">
                <input
                  type={dataType.includes('date') ? 'date' : dataType.includes('time') ? 'time' : 'datetime-local'}
                  value={dateTimePicker.value}
                  onChange={(e) => handleDateTimeChange(e.target.value)}
                  className="w-full px-2 py-1 text-sm border border-gray-300 rounded"
                />
                
                <div className="flex items-center space-x-2">
                  <button
                    onClick={setCurrentTime}
                    className="flex-1 px-2 py-1 text-xs text-green-600 border border-green-300 rounded hover:bg-green-50"
                  >
                    <Clock size={12} className="mr-1" />
                    当前时间
                  </button>
                  <button
                    onClick={setNull}
                    className="px-2 py-1 text-xs text-gray-600 border border-gray-300 rounded hover:bg-gray-50"
                  >
                    清空
                  </button>
                </div>
                
                <div className="flex items-center space-x-2 pt-2 border-t border-gray-200">
                  <button
                    onClick={applyDateTime}
                    className="flex-1 px-3 py-1 text-sm text-white bg-blue-600 rounded hover:bg-blue-700"
                  >
                    确定
                  </button>
                  <button
                    onClick={closePicker}
                    className="flex-1 px-3 py-1 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50"
                  >
                    取消
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  if (!database) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500">
        数据库未连接
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-white">
      {/* 头部 */}
      <div className="flex flex-col bg-white">
        {/* 标题栏 */}
        <div className="flex items-center justify-between p-4 border-b bg-gray-50">
          <div className="flex items-center space-x-3">
            <Table className="text-blue-600" size={20} />
            <div>
              <h1 className="text-lg font-semibold text-gray-900">
                {schema ? `${schema}.${tableName}` : tableName}
              </h1>
              <p className="text-sm text-gray-600">
                {connection.name} • {connection.db_type}
              </p>
            </div>
          </div>
          
          <div className="flex items-center space-x-2">
            <button
              onClick={() => {
                if (activeTab === 'schema') {
                  loadTableSchema();
                } else if (activeTab === 'data') {
                  // 刷新是用户显式要求读取最新数据，行数也要重新统计
                  rowCountCacheRef.current = null;
                  loadTableData(currentPage);
                }
              }}
              className="flex items-center space-x-1 px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50 transition-colors"
              disabled={loading}
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              <span>刷新</span>
            </button>
            
            {onClose && (
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
              >
                关闭
              </button>
            )}
          </div>
        </div>

        {/* 标签页导航 */}
        <div className="flex border-b border-gray-200 bg-white">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              className={clsx(
                "flex items-center space-x-2 px-6 py-3 text-sm font-medium border-b-2 transition-colors",
                activeTab === tab.id
                  ? "border-blue-500 text-blue-600 bg-blue-50"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50"
              )}
              title={tab.description}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="p-4 bg-red-50 border-b border-red-200">
          <div className="flex items-center space-x-2">
            <Info className="text-red-500" size={16} />
            <span className="text-red-700 text-sm">{error}</span>
          </div>
        </div>
      )}

      {/* 内容区域 */}
      <div className="flex-1 overflow-hidden">
        {/* Schema 标签页 */}
        {activeTab === 'schema' && tableSchema && (
          <div className="h-full flex flex-col">
            <div className="p-4 border-b bg-gray-50">
              <h2 className="text-sm font-semibold text-gray-700">表结构信息</h2>
              <p className="text-xs text-gray-500 mt-1">
                {tableSchema.columns.length} 个字段
              </p>
            </div>
            <div className="flex-1 overflow-y-auto">
              <table className="w-full">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      列名
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      数据类型
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      可空
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      主键
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      默认值
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {tableSchema.columns.map((column, index) => (
                    <tr key={index} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">
                        {column.name}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">
                        <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-blue-100 text-blue-800">
                          {column.data_type}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">
                        {column.is_nullable ? (
                          <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-green-100 text-green-800">
                            是
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-red-100 text-red-800">
                            否
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">
                        {column.is_primary_key ? (
                          <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-purple-100 text-purple-800">
                            主键
                          </span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">
                        {column.default_value ? (
                          <code className="text-xs bg-gray-100 px-2 py-1 rounded">
                            {column.default_value}
                          </code>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 数据标签页 */}
        {activeTab === 'data' && (
          <div className="h-full flex flex-col">
            <div className="p-4 border-b bg-gray-50 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-gray-700">表数据</h2>
                <p className="text-xs text-gray-500 mt-1">
                  共 {totalRows} 行数据
                </p>
                {paginationOrder && (
                  <p
                    className={clsx(
                      'text-xs mt-1',
                      paginationOrder.stableAcrossChanges ? 'text-green-600' : 'text-amber-600'
                    )}
                  >
                    {paginationOrder.strategy === 'primary-key'
                      ? `按主键 ${paginationOrder.columns.join(', ')} 稳定分页`
                      : '表没有主键，正在使用数据库回退顺序；数据变更时页边界可能移动'}
                  </p>
                )}
              </div>
              
              <div className="flex items-center space-x-2">
                {/* 编辑操作按钮 */}
                {editState.mode === 'view' && (
                  <>
                    <button
                      onClick={startAddRow}
                      className="flex items-center space-x-1 px-3 py-1.5 text-sm text-green-600 border border-green-300 rounded-md hover:bg-green-50 transition-colors"
                    >
                      <Plus size={14} />
                      <span>添加</span>
                    </button>
                  </>
                )}
                
                {/* 保存/取消按钮 */}
                {editState.mode !== 'view' && (
                  <>
                    <button
                      onClick={saveEdit}
                      disabled={editingLoading}
                      className="flex items-center space-x-1 px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50 transition-colors disabled:opacity-50"
                    >
                      {editingLoading ? (
                        <RefreshCw size={14} className="animate-spin" />
                      ) : (
                        <Save size={14} />
                      )}
                      <span>保存</span>
                    </button>
                    
                    <button
                      onClick={cancelEdit}
                      disabled={editingLoading}
                      className="flex items-center space-x-1 px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors disabled:opacity-50"
                    >
                      <X size={14} />
                      <span>取消</span>
                    </button>
                  </>
                )}
                
                <span className="text-sm text-gray-600">每页显示:</span>
                <select
                  value={pageSize}
                  onChange={(e) => handlePageSizeChange(Number(e.target.value))}
                  className="text-sm border border-gray-300 rounded px-2 py-1"
                >
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                  <option value={200}>200</option>
                </select>
              </div>
            </div>

            {/* 编辑错误提示 */}
            {editingError && (
              <div className="p-3 bg-red-50 border-b border-red-200">
                <div className="flex items-center space-x-2">
                  <AlertCircle className="text-red-500" size={14} />
                  <span className="text-red-700 text-sm">{editingError}</span>
                </div>
              </div>
            )}

            {/* 添加新行表单 */}
            {editState.mode === 'add' && editState.editedData && tableSchema && (
              <div className="p-4 bg-blue-50 border-b border-blue-200">
                <div className="flex items-center space-x-2 mb-3">
                  <Plus className="text-blue-600" size={16} />
                  <h3 className="text-sm font-medium text-blue-900">添加新数据</h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {tableSchema.columns.map((column) => {
                    const isAutoIncrement = column.is_primary_key && (
                      column.data_type.includes('serial') || 
                      column.data_type.includes('auto_increment')
                    );
                    
                    const isDateTimeField = column.data_type.includes('date') || 
                                          column.data_type.includes('time') || 
                                          column.data_type.includes('timestamp');
                    
                    return (
                      <div key={column.name} className="flex flex-col">
                        <label className="text-xs font-medium text-gray-700 mb-1">
                          {column.name}
                          {column.is_primary_key && (
                            <span className="ml-1 text-purple-600">(主键)</span>
                          )}
                          {isAutoIncrement && (
                            <span className="ml-1 text-green-600">(自增)</span>
                          )}
                          {!column.is_nullable && !isAutoIncrement && (
                            <span className="ml-1 text-red-600">*</span>
                          )}
                        </label>
                        {isAutoIncrement ? (
                          <input
                            type="text"
                            value="自动生成"
                            disabled
                            className="px-2 py-1 text-sm border border-gray-300 rounded bg-gray-100 text-gray-500 cursor-not-allowed"
                          />
                        ) : isDateTimeField ? (
                          <DateTimePicker
                            field={column.name}
                            value={editState.editedData[column.name] === null ? '' : String(editState.editedData[column.name] || '')}
                            onChange={(value) => updateEditData(column.name, value)}
                            dataType={column.data_type}
                          />
                        ) : (
                          <input
                            type={column.data_type.includes('int') || column.data_type.includes('bigint') || column.data_type.includes('number') || column.data_type.includes('float') || column.data_type.includes('decimal') || column.data_type.includes('numeric') ? 'number' : 'text'}
                            value={editState.editedData[column.name] === null ? '' : String(editState.editedData[column.name] || '')}
                            onChange={(e) => {
                              let newValue: any = e.target.value;
                              
                              // 根据数据类型转换值
                              if (column.data_type.includes('int') || column.data_type.includes('bigint') || column.data_type.includes('number')) {
                                newValue = newValue === '' ? null : Number(newValue);
                              } else if (column.data_type.includes('float') || column.data_type.includes('decimal') || column.data_type.includes('numeric')) {
                                newValue = newValue === '' ? null : Number(newValue);
                              } else if (column.data_type.includes('bool')) {
                                newValue = newValue === 'true';
                              } else if (newValue === '') {
                                newValue = null;
                              }
                              
                              updateEditData(column.name, newValue);
                            }}
                            className="px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                            placeholder={column.default_value && column.default_value !== 'NULL' ? column.default_value : '输入值'}
                            required={!column.is_nullable && !isAutoIncrement}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 滚动表格容器 */}
            <div className="flex-1 overflow-hidden">
              {loading ? (
                <div className="flex items-center justify-center h-full">
                  <RefreshCw className="animate-spin text-gray-400" size={20} />
                  <span className="ml-2 text-gray-600">加载中...</span>
                </div>
              ) : tableData.length > 0 ? (
                <div className="h-full flex flex-col">
                  {/* 滚动提示 */}
                  <div className="px-4 py-2 bg-blue-50 text-xs text-blue-700 border-b">
                    <span>💡 表格包含 {tableSchema?.columns.length || 0} 列，可以水平滚动查看所有内容</span>
                  </div>
                  
                  {/* 表格滚动容器 */}
                  <div className="flex-1 overflow-auto">
                    <div className="min-w-full">
                      <table className="w-full border-collapse">
                        <thead className="bg-gray-50 sticky top-0">
                          <tr>
                            {tableSchema?.columns.map((column, index) => (
                              <th key={index} className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider border-r border-gray-200 min-w-[180px]">
                                <div className="flex items-center space-x-1">
                                  <span>{column.name}</span>
                                  {column.is_primary_key && (
                                    <span className="text-yellow-600" title="主键">🔑</span>
                                  )}
                                  {!column.is_nullable && (
                                    <span className="text-red-600" title="非空">*</span>
                                  )}
                                </div>
                                <div className="text-xs text-gray-500 font-normal mt-1">
                                  {column.data_type}
                                </div>
                              </th>
                            ))}
                            {/* 操作列 */}
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider min-w-[100px]">
                              操作
                            </th>
                          </tr>
                        </thead>
                        
                        <tbody className="bg-white divide-y divide-gray-200">
                          {tableData.map((row, rowIndex) => (
                            <tr key={rowIndex} className="hover:bg-gray-50">
                              {tableSchema?.columns.map((column, colIndex) => (
                                <EditableCell
                                  key={colIndex}
                                  value={row[column.name]}
                                  field={column.name}
                                  isEditing={editState.mode === 'edit' && editState.rowIndex === rowIndex}
                                  isPrimaryKey={column.is_primary_key}
                                  dataType={column.data_type}
                                />
                              ))}
                              {/* 操作列 */}
                              <td className="px-4 py-3 text-sm border-l border-gray-200">
                                {editState.mode === 'view' ? (
                                  <div className="flex items-center space-x-1">
                                    <button
                                      onClick={() => startEditRow(rowIndex)}
                                      className="p-1 text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded"
                                      title="编辑"
                                    >
                                      <Edit size={14} />
                                    </button>
                                    <button
                                      onClick={() => deleteRow(rowIndex)}
                                      className="p-1 text-red-600 hover:text-red-800 hover:bg-red-50 rounded"
                                      title="删除"
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </div>
                                ) : editState.mode === 'edit' && editState.rowIndex === rowIndex ? (
                                  <div className="flex items-center space-x-1">
                                    <button
                                      onClick={saveEdit}
                                      disabled={editingLoading}
                                      className="p-1 text-green-600 hover:text-green-800 hover:bg-green-50 rounded disabled:opacity-50"
                                      title="保存"
                                    >
                                      {editingLoading ? (
                                        <RefreshCw size={14} className="animate-spin" />
                                      ) : (
                                        <Check size={14} />
                                      )}
                                    </button>
                                    <button
                                      onClick={cancelEdit}
                                      disabled={editingLoading}
                                      className="p-1 text-gray-600 hover:text-gray-800 hover:bg-gray-50 rounded disabled:opacity-50"
                                      title="取消"
                                    >
                                      <X size={14} />
                                    </button>
                                  </div>
                                ) : null}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  
                  {/* 分页控件 */}
                  {totalPages > 1 && (
                    <div className="px-4 py-3 bg-gray-50 border-t flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <span className="text-sm text-gray-700">
                          显示 {(currentPage - 1) * pageSize + 1}-{Math.min(currentPage * pageSize, totalRows)} 行，共 {totalRows} 行
                        </span>
                      </div>
                      
                      <div className="flex items-center space-x-1">
                        <button
                          onClick={() => handlePageChange(1)}
                          disabled={currentPage === 1}
                          className="p-1 rounded hover:bg-gray-200 disabled:opacity-50"
                        >
                          <ChevronsLeft size={16} />
                        </button>
                        <button
                          onClick={() => handlePageChange(currentPage - 1)}
                          disabled={currentPage === 1}
                          className="p-1 rounded hover:bg-gray-200 disabled:opacity-50"
                        >
                          <ChevronLeft size={16} />
                        </button>
                        <span className="px-3 py-1 text-sm text-gray-700">
                          第 {currentPage} 页，共 {totalPages} 页
                        </span>
                        <button
                          onClick={() => handlePageChange(currentPage + 1)}
                          disabled={currentPage === totalPages}
                          className="p-1 rounded hover:bg-gray-200 disabled:opacity-50"
                        >
                          <ChevronRight size={16} />
                        </button>
                        <button
                          onClick={() => handlePageChange(totalPages)}
                          disabled={currentPage === totalPages}
                          className="p-1 rounded hover:bg-gray-200 disabled:opacity-50"
                        >
                          <ChevronsRight size={16} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-gray-500">
                  暂无数据
                </div>
              )}
            </div>
          </div>
        )}

        {/* ER 图标签页 */}
        {activeTab === 'er' && (
          <div className="h-full flex flex-col">
            <div className="p-4 border-b bg-gray-50">
              <h2 className="text-sm font-semibold text-gray-700">数据库关系图 (ER 图)</h2>
              <p className="text-xs text-gray-500 mt-1">
                显示数据库中所有表的关系结构
              </p>
            </div>
            <div className="flex-1 flex items-center justify-center bg-gray-50">
              <div className="text-center text-gray-500">
                <BarChart3 size={48} className="mx-auto mb-4 text-gray-300" />
                <p className="text-sm font-medium mb-2">ER 图功能开发中</p>
                <p className="text-xs">该功能将展示数据库中所有表的关系结构</p>
                <p className="text-xs mt-1">包括外键关系、表间连线等</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
} 
