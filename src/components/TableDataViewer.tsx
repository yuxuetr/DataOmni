import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useLanguageStore } from '../stores/languageStore';
import { runReadQuery, useQueryStore } from '../stores/queryStore';
import { isTaggedResultValue, unwrapResultValue } from '../utils/resultValues';
import { describeError } from '../utils/describeError';
import type { SerializedResultValue } from '../contracts/resultSet';
import {
  X,
  // Database as DatabaseIcon,
  ChevronLeft,
  ChevronRight,
  FileText,
  Table,
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
  Download,
  Lock,
  Filter,
  Columns3,
  Undo2
} from 'lucide-react';
import clsx from 'clsx';
import type { ConnectionProfile, TableSchema } from '../contracts';
import { quoteQualifiedSqlIdentifier } from '../utils/sqlIdentifiers';
import {
  createSortedOrderClause,
  createTablePaginationOrder,
  type TablePaginationOrder
} from '../utils/tablePagination';
import { nextColumnSort, type ColumnSort } from '../utils/resultSorting';
import { ColumnSortButton } from './ColumnSortButton';
import { useCellSelection } from '../hooks/useCellSelection';
import { toPositionalRows } from '../utils/columnWidths';
import { useResizableColumns } from '../hooks/useResizableColumns';
import { ColumnResizeHandle } from './ColumnResizeHandle';
import { ExportResultDialog } from './ExportResultDialog';
import {
  extractDdlStatements,
  groupForeignKeyRows,
  groupIndexRows,
  joinDdlStatements,
  toCheckConstraints,
  toTriggers
} from '../utils/schemaObjects';
import { SchemaObjectSections, type SchemaObjects } from './SchemaObjectSections';
import { GRID_PAGE_SIZE_OPTIONS } from '../utils/gridPagination';
import { requireDatabase } from '../utils/requireDatabase';
import { tableColumnsQuery, toColumnInfo } from '../utils/tableMetadata';
import { describeRowIdentity, type IndexMetadata } from '../utils/rowIdentity';
import type { RowKey, TableTarget } from '../utils/rowStatements';
import {
  cellInputFromValue,
  missingRequiredColumns,
  type BoundValue,
  type CellInput
} from '../utils/cellInput';
import { CellInputEditor } from './CellInputEditor';
import { PendingChangesBar } from './PendingChangesBar';
import { ChangeDiffDialog, type CommitFailure } from './ChangeDiffDialog';
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
import { ROW_COUNT_MISMATCH_CODE, toQueryExecutionError } from '../utils/queryError';
import { GridCellValue } from './GridCellValue';
import { TableFilterBar } from './TableFilterBar';
import { GridColumnMenu } from './GridColumnMenu';
import { GridContextMenu, type GridContextTarget } from './GridContextMenu';
import {
  DENSITY_CELL_CLASS,
  frozenLeftOffsets,
  toggleHiddenColumn,
  visibleColumnIndexes,
  type GridDensity
} from '../utils/gridColumns';
import { buildFilterClause, isCompleteFilter, type ColumnFilter } from '../utils/tableFilters';

// 编辑模式类型
type EditMode = 'view' | 'edit' | 'add';

// 编辑状态接口
interface EditState {
  mode: EditMode;
  rowIndex?: number;
  /** 这一行加载时的值，用来判断哪些列真的改了，并回到 WHERE 里 */
  originalData?: Record<string, BoundValue>;
  /** 每一列「要写什么」；空串和 NULL 在这里是两件事 */
  editedData?: Record<string, CellInput>;
}

interface TableDataViewerProps {
  connection: ConnectionProfile;
  tableName: string;
  schema?: string;
  initialTab?: TabType;
  onClose?: () => void;
}

// 标签页类型
type TabType = 'schema' | 'data';

/** `get_schema_metadata_queries` 的返回；字段名按 Rust 侧的 snake_case */
interface SchemaMetadataQueries {
  indexes: string;
  foreign_keys: string;
  check_constraints: string | null;
  /** 对象定义原文；PostgreSQL 只对视图有 */
  ddl: DdlQuery | null;
  triggers: string;
}

/** `bound` 走绑定参数，`interpolated` 要把 `{table}` 换成引用过的标识符 */
type DdlQuery =
  | { kind: 'bound'; sql: string }
  | { kind: 'interpolated'; sql: string };

function asRows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

export default function TableDataViewer({ 
  connection,
  tableName, 
  schema, 
  initialTab,
  onClose 
}: TableDataViewerProps) {
  const t = useLanguageStore((state) => state.t);
  const [tableSchema, setTableSchema] = useState<TableSchema | null>(null);
  const [tableSchemaKey, setTableSchemaKey] = useState<string | null>(null);
  const [tableData, setTableData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  // 排序在数据库里做：只排当前页得到的是「这一页内部的次序」
  const [sort, setSort] = useState<ColumnSort | null>(null);
  // 草稿与已应用分开：每敲一个字符就查一次库，在大表上等于连续的全表扫描
  const [filters, setFilters] = useState<ColumnFilter[]>([]);
  const [appliedFilters, setAppliedFilters] = useState<ColumnFilter[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [hiddenColumns, setHiddenColumns] = useState<ReadonlySet<string>>(new Set());
  const [frozenCount, setFrozenCount] = useState(0);
  const [density, setDensity] = useState<GridDensity>('default');
  const [showColumnMenu, setShowColumnMenu] = useState(false);
  const [contextTarget, setContextTarget] = useState<GridContextTarget | null>(null);
  // 与 sortRef 同理：loadTableData 的闭包里读不到刚 set 进去的新值
  const appliedFiltersRef = useRef<ColumnFilter[]>([]);
  appliedFiltersRef.current = appliedFilters;
  const [showExport, setShowExport] = useState(false);
  const [schemaObjects, setSchemaObjects] = useState<SchemaObjects | null>(null);
  const sortRef = useRef<ColumnSort | null>(null);
  sortRef.current = sort;
  const [totalRows, setTotalRows] = useState(0);
  const [paginationOrder, setPaginationOrder] = useState<TablePaginationOrder | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>(initialTab ?? 'data');
  
  // 编辑功能相关状态
  const [editState, setEditState] = useState<EditState>({ mode: 'view' });
  const [editingLoading, setEditingLoading] = useState(false);
  const [editingError, setEditingError] = useState<string | null>(null);
  /** 待提交的变更。改动不再一改一提交，全部先落在这里 */
  const [changes, setChanges] = useState<PendingChange[]>([]);
  const [showChanges, setShowChanges] = useState(false);
  const [commitFailure, setCommitFailure] = useState<CommitFailure | null>(null);
  const [commitNotice, setCommitNotice] = useState<string | null>(null);
  
  const { database, connectionId } = useQueryStore();
  const currentTableKey = `${connection.id}:${schema ?? ''}:${tableName}`;
  // 标识符引用方言。此前这行三元式在四个函数里各抄了一份
  const dialect = connection.db_type === 'mysql'
    ? 'mysql'
    : connection.db_type === 'postgresql'
      ? 'postgresql'
      : 'sqlite';

  // COUNT(*) 在大表上是全表扫描（InnoDB 与 PostgreSQL 都没有常数级行数），
  // 按数据集身份缓存，使翻页和调整页大小不再重复付这笔代价。
  // 用 ref 而非 state：调用方在同一次事件中失效缓存并立即加载，
  // 若用 state，loadTableData 闭包里仍是旧值，会读到本应失效的计数。
  const rowCountCacheRef = useRef<{ key: string; total: number } | null>(null);

  // 标签页配置
  const tabs = [
    {
      id: 'schema' as TabType,
      label: t('table.tab.schema'),
      icon: <FileText size={16} />,
      description: t('table.tab.schema.desc')
    },
    {
      id: 'data' as TabType,
      label: t('table.tab.data'),
      icon: <Table size={16} />,
      description: t('table.tab.data.desc')
    }
  ];

  // 检查并确保数据库连接
  const ensureDatabaseConnection = async () => {
    if (!database) {
      setError(t('table.sessionUnavailable'));
      return false;
    }

    // 标签永久绑定到打开它的连接。活跃会话切到别的连接时必须停下：
    // database 是全局唯一会话，继续执行会拿本表的表名去查另一个库。
    if (connectionId !== connection.id) {
      setError(t('table.connectionInactive', { name: connection.name }));
      return false;
    }

    return true;
  };

  const runDdlQuery = (ddl: DdlQuery | null) => {
    if (!ddl) {
      return Promise.resolve(null);
    }
    if (ddl.kind === 'bound') {
      return requireDatabase(database).select(ddl.sql, [tableName]);
    }
    // SHOW CREATE TABLE 不接受占位符，表名只能作为引用过的标识符插进去
    const quoted = quoteQualifiedSqlIdentifier(schema ? [schema, tableName] : [tableName], dialect);
    return requireDatabase(database).select(ddl.sql.replace('{table}', quoted), []);
  };

  /**
   * 索引、外键与检查约束。
   *
   * `checkConstraints` 为 null 表示这个方言没有检查约束目录（SQLite），
   * 与「查过了，一条也没有」是两回事——后者会让人以为表上没写 CHECK。
   */
  const loadSchemaObjects = async () => {
    setSchemaObjects(null);

    try {
      const queries = await invoke<SchemaMetadataQueries>('get_schema_metadata_queries', {
        dbType: connection.db_type
      });

      // SQLite 的 pragma 表值函数只认一个表名参数，没有 schema 概念
      const params = connection.db_type === 'sqlite' ? [tableName] : [tableName, schema ?? null];
      const [indexRows, foreignKeyRows, checkRows, ddlRows, triggerRows] = await Promise.all([
        requireDatabase(database).select(queries.indexes, params),
        requireDatabase(database).select(queries.foreign_keys, params),
        queries.check_constraints
          ? requireDatabase(database).select(queries.check_constraints, params)
          : Promise.resolve(null),
        runDdlQuery(queries.ddl),
        // SQLite 的 pragma 之外的目录查询同样只认一个表名参数
        requireDatabase(database).select(queries.triggers, params)
      ]);

      setSchemaObjects({
        indexes: groupIndexRows(asRows(indexRows), t('schema.expressionColumn')),
        foreignKeys: groupForeignKeyRows(asRows(foreignKeyRows)),
        checkConstraints: checkRows === null ? null : toCheckConstraints(asRows(checkRows)),
        ddl: ddlRows === null ? null : joinDdlStatements(extractDdlStatements(asRows(ddlRows))),
        triggers: toTriggers(asRows(triggerRows))
      });
    } catch (err) {
      // 结构对象读失败不该把已经拿到的列信息一起打掉：列是主体，这里是补充
      console.error('加载索引与约束失败:', err);
      setSchemaObjects({
        indexes: [],
        foreignKeys: [],
        checkConstraints: null,
        ddl: null,
        triggers: [],
        error: describeError(err, t('schema.readObjectsFailed'))
      });
    }
  };

  // 加载表结构信息
  const loadTableSchema = async (): Promise<TableSchema | null> => {
    if (!await ensureDatabaseConnection()) return null;
    
    try {
      const columnsQuery = tableColumnsQuery(connection.db_type, tableName, schema);
      if (!columnsQuery) {
        throw new Error(t('table.schemaLoadFailedStopped'));
      }
      const columnsResult = await requireDatabase(database).select(
        columnsQuery.sql,
        columnsQuery.params
      );
      const columns = toColumnInfo(columnsResult);

      const loadedSchema = { columns };
      setTableSchema(loadedSchema);
      setTableSchemaKey(currentTableKey);
      // 不 await：列已经可以画了，索引和约束到了再补上
      void loadSchemaObjects();
      return loadedSchema;
    } catch (err) {
      console.error('加载表结构失败:', err);
      setError(describeError(err));
      return null;
    }
  };

  // 加载表数据
  const loadTableData = async (page: number = 1, requestedPageSize: number = pageSize) => {
    if (!await ensureDatabaseConnection()) return;
    
    setLoading(true);
    setError(null);
    
    try {
        const tableReference = quoteQualifiedSqlIdentifier(
        schema ? [schema, tableName] : [tableName],
        dialect
      );
      const loadedSchema = tableSchemaKey === currentTableKey
        ? tableSchema
        : await loadTableSchema();
      if (!loadedSchema) {
        throw new Error(t('table.schemaLoadFailedStopped'));
      }
      const order = createTablePaginationOrder(loadedSchema.columns, dialect);
      setPaginationOrder(order);

      // 筛选在数据库里做：只筛当前页得到的是「这一页里恰好符合的行」，
      // 而用户问的是「整张表里符合的行」——两者在第二页就会分道扬镳
      const whereClause = buildFilterClause(appliedFiltersRef.current, loadedSchema.columns, dialect);
      // 行数缓存按「数据集身份」缓存，而筛选条件正是身份的一部分：
      // 漏掉它，加完条件后分页控件还按全表行数算，末几页会是空的
      const dataSetKey = `${currentTableKey}|${whereClause}`;

      // 获取总行数：仅在数据集身份变化或缓存被显式失效时重新统计
      const cachedRowCount = rowCountCacheRef.current;
      let total: number;
      if (cachedRowCount && cachedRowCount.key === dataSetKey) {
        total = cachedRowCount.total;
      } else {
        const countQuery = `SELECT COUNT(*) as total FROM ${tableReference} ${whereClause}`;
        const countResult = await runReadQuery(countQuery);
        // COUNT(*) 由自建执行器返回为 tagged bigint，取出字面值再转数
        const rawTotal = countResult[0]?.total ?? 0;
        total = Number(
          isTaggedResultValue(rawTotal) ? rawTotal.value : rawTotal
        ) || 0;
        rowCountCacheRef.current = { key: dataSetKey, total };
      }

      setTotalRows(total);
      
      // 获取分页数据。
      //
      // LIMIT / OFFSET 直接内联，不走绑定参数：tauri-plugin-sql 把所有数字
      // 一律按 f64 绑定（wrapper.rs 的 `bind(number.as_f64())`），MySQL 与
      // PostgreSQL 都不接受 DOUBLE 作为 LIMIT，会直接报错。这两个值是内部
      // 算出来的页长与偏移，不是用户输入，下面再收敛成非负整数兜底。
      const limitValue = Math.max(1, Math.trunc(requestedPageSize));
      const offsetValue = Math.max(0, Math.trunc((page - 1) * requestedPageSize));
      // 用户排序列拼在前，分页排序列追加在后作决胜条件——按不唯一的列排序时，
      // 没有决胜条件翻页会重复或漏行
      const orderClause = createSortedOrderClause(order, sortRef.current, dialect);
      const dataQuery =
        `SELECT * FROM ${tableReference} ${whereClause} ${orderClause} `
        + `LIMIT ${limitValue} OFFSET ${offsetValue}`;

      const dataResult = await runReadQuery(dataQuery);

      setTableData(dataResult);
    } catch (err) {
      console.error('加载表数据失败:', err);
      // 原始错误必须可见，否则无从判断是类型解码、权限还是语法问题
      setError(describeError(err));
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
            // 回到当前页而不是第一页：去结构页看一眼再回来，不该把翻了半天的
            // 位置丢掉。首次挂载时 currentPage 本来就是 1
            loadTableData(currentPage);
          }
        }
      }
    };
    
    initializeViewer();
  }, [tableName, schema, activeTab, connectionId]); // connectionId：绑定的连接重新激活后自动恢复加载

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

  // 只比「填完了的」条件：草稿里多出一行还没填值的空条件不该让「未应用」亮起来
  const filterSignature = (list: readonly ColumnFilter[]) => JSON.stringify(
    list.filter(isCompleteFilter).map((filter) => [filter.column, filter.operator, filter.value])
  );
  const appliedFilterCount = appliedFilters.filter(isCompleteFilter).length;
  const filtersPending = filterSignature(filters) !== filterSignature(appliedFilters);

  const applyFilters = (next: ColumnFilter[] = filters) => {
    setAppliedFilters(next);
    appliedFiltersRef.current = next;
    setCurrentPage(1);
    void loadTableData(1);
  };

  // 换表时草稿必须清掉：旧条件指着另一张表的列，buildFilterClause 会把它们丢掉，
  // 于是筛选栏上明明列着条件而结果却没有被筛过
  useEffect(() => {
    setFilters([]);
    setAppliedFilters([]);
    appliedFiltersRef.current = [];
    // 列偏好同理：隐藏集里存的是列名，换表后指的是另一张表的列
    setHiddenColumns(new Set());
    setFrozenCount(0);
    // 待提交的变更也清掉：它们的键指着另一张表的行，发出去会改错东西。
    // 这里没法征求同意（换表已经发生了），所以关标签页那一步会先问一次
    setChanges([]);
    setCommitFailure(null);
    setCommitNotice(null);
  }, [currentTableKey]);

  // 计算总页数
  const totalPages = Math.ceil(totalRows / pageSize);

  // 列宽按当前页内容估算，可拖动覆盖。表结构还没加载出来时列表为空，
  // 估算返回空数组，那时表格本来也还没渲染。
  const ACTION_COLUMN_WIDTH = 72;
  const columnNames = React.useMemo(
    () => tableSchema?.columns.map((column) => column.name) ?? [],
    [tableSchema]
  );
  // 索引和列信息是两次查询，列先到。这中间「有没有唯一键」的答案是「还不知道」，
  // 不是「没有」——后者会先给用户一句随后被推翻的断言
  const indexMetadata = React.useMemo((): IndexMetadata => {
    if (!schemaObjects) {
      return { status: 'pending' };
    }
    if (schemaObjects.error) {
      return { status: 'unavailable' };
    }
    return { status: 'loaded', indexes: schemaObjects.indexes };
  }, [schemaObjects]);
  const rowIdentity = React.useMemo(
    () => describeRowIdentity(tableSchema?.columns ?? [], indexMetadata),
    [tableSchema, indexMetadata]
  );
  // 键列不可改：改它等于换一行的身份，那是删一行加一行，不是更新
  const keyColumnSet = React.useMemo(
    () => new Set(rowIdentity.identity?.columns ?? []),
    [rowIdentity]
  );
  const editable = rowIdentity.identity !== null;
  const readOnlyMessage = (() => {
    switch (rowIdentity.absence) {
      case 'no-unique-key':
        return t('table.readOnly.noUniqueKey');
      case 'metadata-unavailable':
        return t('table.readOnly.metadataUnavailable');
      default:
        // metadata-pending 不说：它在同一次加载里就有结论，先闪一条警告再收回去
        // 比什么都不说更让人不安
        return null;
    }
  })();
  const positionalRows = React.useMemo(
    () => toPositionalRows(columnNames, tableData),
    [columnNames, tableData]
  );
  const {
    widths: columnWidths,
    alignments,
    startResize,
    autoFitColumn,
    resizingIndex
  } = useResizableColumns(columnNames, positionalRows);

  const visibleIndexes = React.useMemo(
    () => visibleColumnIndexes(columnNames, hiddenColumns),
    [columnNames, hiddenColumns]
  );
  // 选区按**看得见的**列建立：用户框住的是他看到的那几格，复制出来的却混进
  // 藏起来的列，是这类网格最难自查的一种错
  const visibleRows = React.useMemo(
    () => positionalRows.map((row) => visibleIndexes.map((index) => row[index] ?? null)),
    [positionalRows, visibleIndexes]
  );
  const visibleWidths = visibleIndexes.map((index) => columnWidths[index] ?? 0);
  const frozenOffsets = frozenLeftOffsets(visibleWidths, frozenCount);
  // 冻结区的最后一列画一道粗边：没有分界线时，滚过去的内容看上去是凭空消失的，
  // 而不是被压在冻住的列下面
  const lastFrozenPosition = frozenOffsets.filter((offset) => offset !== null).length - 1;
  const gridWidth = visibleWidths.reduce((sum, width) => sum + width, 0) + ACTION_COLUMN_WIDTH;
  const densityClass = DENSITY_CELL_CLASS[density];
  // visibleRows 是 memo 过的稳定引用，符合 useCellSelection 的要求
  const visibleColumnNames = React.useMemo(
    () => visibleIndexes.map((index) => columnNames[index] ?? ''),
    [visibleIndexes, columnNames]
  );
  // 刷新是「同一份数据再取一遍」，选区要留着；翻页 / 改排序 / 改筛选 / 换表
  // 是换了一份数据，同一个坐标指的是另一行。两者的区别只有这里知道
  const datasetKey = [
    currentTableKey,
    filterSignature(appliedFilters),
    `${sort?.column ?? ''}:${sort?.direction ?? ''}`,
    currentPage,
    pageSize
  ].join('|');
  const cells = useCellSelection(visibleRows, visibleColumnNames, datasetKey);

  /**
   * 这一列的值由数据库生成（自增 / serial / identity）。
   *
   * 新增时它的起点是「默认值」而不是空文本：填一个空串进去，数据库要么报错，
   * 要么真的写了个 0 覆盖掉自增序列该给的那个值。
   */
  const isGeneratedKeyColumn = (column: { data_type: string; default_value?: string }): boolean => {
    const type = column.data_type.toLowerCase();
    return type.includes('serial')
      || type.includes('auto_increment')
      || type.includes('identity')
      || (column.default_value ?? '').toLowerCase().includes('nextval(');
  };

  // 处理标签页切换
  const handleTabChange = (tabId: TabType) => {
    setActiveTab(tabId);
    
    // 根据标签页类型加载相应数据
    if (tabId === 'schema' && !tableSchema) {
      loadTableSchema();
    } else if (tabId === 'data' && tableData.length === 0) {
      loadTableData(currentPage);
    }
  };

  // 编辑功能工具函数
  
  // 开始编辑行
  const startEditRow = (rowIndex: number) => {
    // 编辑态一律用拆包后的原始值：主键原值要回到 WHERE 里，
    // 「是否被改过」的比较也要对着字面量做，tagged 对象两者都会破坏
    const rowData = Object.fromEntries(
      Object.entries(tableData[rowIndex] ?? {}).map(([column, value]) => [
        column,
        unwrapResultValue(value as SerializedResultValue)
      ])
    );
    setEditState({
      mode: 'edit',
      rowIndex,
      originalData: { ...rowData },
      // NULL 回到 `null` 档而不是空文本：否则打开编辑框再直接关掉，
      // 就把一个 NULL 变成了空字符串
      editedData: Object.fromEntries(
        Object.entries(rowData).map(([column, value]) => [column, cellInputFromValue(value)])
      )
    });
    setEditingError(null);
  };

  // 开始添加新行
  const startAddRow = () => {
    // 三档起点，对应三件不同的事：有默认值（含自增主键）的列交给数据库；
    // 可空的列先摆成 NULL；非空又没有默认值的列留成「未填写」，
    // 由 `missingRequiredColumns` 在提交前点名，而不是让数据库去拒绝
    const newRowData: Record<string, CellInput> = {};
    for (const column of tableSchema?.columns ?? []) {
      if (column.default_value != null || isGeneratedKeyColumn(column)) {
        newRowData[column.name] = { kind: 'default' };
      } else if (column.is_nullable) {
        newRowData[column.name] = { kind: 'null' };
      } else {
        newRowData[column.name] = { kind: 'unset' };
      }
    }

    setEditState({ mode: 'add', editedData: newRowData });
    setEditingError(null);
  };

  // 取消编辑
  const cancelEdit = () => {
    setEditState({ mode: 'view' });
    setEditingError(null);
  };

  // 保存编辑
  /**
   * 写入目标：表名、方言和全表列元数据。
   *
   * 列元数据是给 `rowStatements` 查类型用的——数值列上的比较要内联成不带引号
   * 的字面量，否则 MySQL 会把两边都转成 DOUBLE，超过 2^53 的 BIGINT 主键
   * 会定位到邻近的另一行。
   */
  const writeTarget = (): TableTarget => ({
    schema: schema ?? null,
    table: tableName,
    columns: tableSchema?.columns ?? [],
    dialect
  });

  /**
   * 取这一行的键值。
   *
   * 键列由 `describeRowIdentity` 给出——全部键列，不是第一列。原值要从 tagged
   * 包装里拆出来：包装只服务于展示，绑进 SQL 的必须是字面量。
   */
  const rowKeyFrom = (values: Record<string, unknown>): RowKey => {
    const keyColumns = rowIdentity.identity?.columns ?? [];
    return {
      columns: keyColumns,
      values: Object.fromEntries(
        keyColumns.map((name) => [name, unwrapResultValue(values[name] as SerializedResultValue)])
      )
    };
  };

  /**
   * 一次提交整批，在**一个事务**里。
   *
   * 失败时数据库里什么都没变，`changes` 原样留着——用户改一处再提交一次就行，
   * 而不是去猜前面几条到底落库了没有。
   */
  const commitChanges = async () => {
    if (changes.length === 0 || !rowIdentity.identity) {
      return;
    }
    setEditingLoading(true);
    setEditingError(null);
    setCommitFailure(null);

    try {
      const statements = pendingStatements(changes, writeTarget());
      await invoke<number[]>('execute_write_batch', {
        connectionId: connection.id,
        statements
      });
      const committed = changes.length;
      setChanges([]);
      setShowChanges(false);
      setEditingError(null);
      // 新增与删除改变了表的基数，就地编辑不会——一律失效，简单且不会算错
      rowCountCacheRef.current = null;
      // 重新读：自增键、默认值和表达式的结果只有数据库算得出来
      await loadTableData(currentPage);
      setCommitNotice(t('changes.committed', { count: committed }));
    } catch (error) {
      const failure = toQueryExecutionError(error);
      const index = typeof (error as { statement_index?: unknown })?.statement_index === 'number'
        ? (error as { statement_index: number }).statement_index
        : 0;
      setCommitFailure({ index, error: failure });
      setEditingError(
        failure.code === ROW_COUNT_MISMATCH_CODE
          ? t('changes.conflict', { index: index + 1 })
          : failure.message
      );
      // 失败时不关预览：出错的那一条就标在里面
      setShowChanges(true);
    } finally {
      setEditingLoading(false);
    }
  };

  // 更新编辑数据
  const updateEditData = (field: string, value: CellInput) => {
    setCommitNotice(null);
    if (editState.editedData) {
      setEditState({
        ...editState,
        editedData: { ...editState.editedData, [field]: value }
      });
    }
  };

  /** 这一行上有没有排队中的改动 */
  const pendingFor = (row: Record<string, unknown>) => {
    if (!rowIdentity.identity) {
      return undefined;
    }
    return pendingForRow(changes, rowIdOf(rowKeyFrom(row)));
  };

  const revertAllChanges = () => {
    setChanges([]);
    setCommitFailure(null);
    setEditingError(null);
    setShowChanges(false);
  };

  /** 保存 = 把这次编辑放进待提交队列，不发语句 */
  const saveEdit = () => {
    if (!editState.editedData) return;
    setEditingError(null);

    try {
      if (editState.mode === 'add') {
        const missing = missingRequiredColumns(editState.editedData, tableSchema?.columns ?? []);
        if (missing.length > 0) {
          setEditingError(t('cellInput.requiredMissing', {
            columns: missing.join(', '),
            count: missing.length
          }));
          return;
        }
        const values = editState.editedData;
        setChanges((current) => stageInsert(current, values));
      } else if (editState.mode === 'edit' && editState.originalData) {
        const original = editState.originalData;
        const key = rowKeyFrom(original);
        const keySet = new Set(key.columns);
        // 键列不进 SET：改键等于换一行的身份，那是删一行加一行，不是更新
        const assignments = Object.fromEntries(
          Object.entries(editState.editedData).filter(([column]) => !keySet.has(column))
        );
        setChanges((current) => stageUpdate(current, key, original, assignments));
      }
      setEditState({ mode: 'view' });
    } catch (error) {
      setEditingError(describeError(error, t('table.saveFailed')));
    }
  };

  /** 删除同样只是排队。确认对话框因此不在这里——此刻还什么都没发生 */
  const deleteRow = (rowIndex: number) => {
    const row = tableData[rowIndex];
    if (!row) return;
    setEditingError(null);
    const original = Object.fromEntries(
      Object.entries(row).map(([column, value]) => [
        column,
        unwrapResultValue(value as SerializedResultValue)
      ])
    );
    try {
      setChanges((current) => stageDelete(current, rowKeyFrom(original), original));
    } catch (error) {
      setEditingError(describeError(error, t('table.deleteFailed')));
    }
  };

  // 可编辑单元格组件
  const EditableCell = ({
    value,
    field,
    isEditing,
    isKeyColumn = false,
    dataType = '',
    align = 'left',
    densityClass = 'px-2 py-1',
    frozenLeft = null,
    lastFrozen = false,
    selected = false,
    focused = false,
    onSelect,
    onContextMenu
  }: {
    value: any;
    field: string;
    isEditing: boolean;
    /** 这一列参与定位行：改它等于换一行的身份，所以不让改 */
    isKeyColumn?: boolean;
    /** 列的声明类型，决定编辑时用哪种控件 */
    dataType?: string;
    align?: 'left' | 'right';
    densityClass?: string;
    /** 冻结列的左偏移；null 表示这一列跟着横向滚动 */
    frozenLeft?: number | null;
    /** 冻结区的最后一列，画一道分界线 */
    lastFrozen?: boolean;
    selected?: boolean;
    focused?: boolean;
    onSelect?: (extend: boolean) => void;
    onContextMenu?: (event: React.MouseEvent) => void;
  }) => {
    if (!isEditing || isKeyColumn) {
      // 非编辑状态或键列，显示只读
      // 自建执行器把 BigInt / Decimal / 二进制等包成 tagged value 以保住精度，
      // 显示时统一交给 formatResultValue 还原成人能读的形式
      return (
        <td
          onClick={(event) => onSelect?.(event.shiftKey)}
          onContextMenu={onContextMenu}
          style={frozenLeft === null ? undefined : { left: `${frozenLeft}px` }}
          className={clsx(
            'border-r border-line font-mono text-[13px] text-fg',
            densityClass,
            align === 'right' && 'text-right',
            // 冻结列必须自带不透明底色，否则滚过来的内容会从它下面透出来。
            // 选中时让选区色盖过它——那才是此刻要表达的状态
            frozenLeft !== null && 'sticky z-10',
            frozenLeft !== null && !selected && 'bg-surface',
            lastFrozen && 'border-r-2 border-r-line-strong',
            selected && 'bg-accent-soft',
            focused && 'outline outline-1 -outline-offset-1 outline-accent'
          )}
        >
          {/* 单行形态、NULL / 空串 / 空白 / 二进制的区分都在 GridCellValue 里，
              与 SQL 结果表共用同一套约定 */}
          <GridCellValue value={(value ?? null) as SerializedResultValue} />
        </td>
      );
    }

    // 编辑状态
    const input = editState.editedData?.[field] ?? { kind: 'unset' as const };
    return (
      <td className={clsx('border-r border-line', densityClass)}>
        <CellInputEditor
          value={input}
          onChange={(next) => updateEditData(field, next)}
          // SQLite 的 UPDATE 没有 `SET 列 = DEFAULT`，那一档在这里不给选
          allowDefault={dialect !== 'sqlite'}
          dataType={dataType}
          dialect={dialect}
          autoFocus
          onCommit={saveEdit}
          onCancel={cancelEdit}
        />
      </td>
    );
  };

  if (!database) {
    return (
      <div className="h-full flex items-center justify-center text-fg-muted">
        {t('table.notConnected')}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-surface">
      {/* 头部 */}
      <div className="flex flex-col bg-surface">
        {/* 标题栏 */}
        <div className="flex items-center justify-between p-4 border-b bg-surface-sunken">
          <div className="flex items-center space-x-3">
            <Table className="text-accent" size={20} />
            <div>
              <h1 className="text-lg font-semibold text-fg">
                {schema ? `${schema}.${tableName}` : tableName}
              </h1>
              <p className="text-sm text-fg-muted">
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
              className="flex items-center space-x-1 px-3 py-1.5 text-sm text-accent border border-accent-line rounded-control hover:bg-accent-soft transition-colors"
              disabled={loading}
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              <span>{t('table.refresh')}</span>
            </button>
            
            {onClose && (
              <button
                onClick={() => {
                  // 待提交的变更只活在这个组件里，关掉就没了
                  if (changes.length > 0
                    && !confirm(t('changes.discardConfirm', { count: changes.length }))) {
                    return;
                  }
                  onClose();
                }}
                className="px-3 py-1.5 text-sm text-fg-muted border border-line-strong rounded-control hover:bg-surface-hover transition-colors"
              >
                {t('table.close')}
              </button>
            )}
          </div>
        </div>

        {/* 标签页导航 */}
        <div className="flex border-b border-line bg-surface">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              className={clsx(
                "flex items-center space-x-2 px-6 py-3 text-sm font-medium border-b-2 transition-colors",
                activeTab === tab.id
                  ? "border-accent text-accent bg-accent-soft"
                  : "border-transparent text-fg-muted hover:text-fg hover:bg-surface-hover"
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
        <div className="p-4 bg-danger-soft border-b border-danger-line">
          <div className="flex items-center space-x-2">
            <Info className="text-danger" size={16} />
            <span className="text-danger text-sm">{error}</span>
          </div>
        </div>
      )}

      {/* 内容区域 */}
      <div className="flex-1 overflow-hidden">
        {/* Schema 标签页 */}
        {activeTab === 'schema' && tableSchema && (
          <div className="h-full flex flex-col">
            <div className="p-4 border-b bg-surface-sunken">
              <h2 className="text-sm font-semibold text-fg">{t('table.structureTitle')}</h2>
              <p className="text-xs text-fg-muted mt-1">
                {t('table.fieldCount', { count: tableSchema.columns.length })}
              </p>
            </div>
            <div className="flex-1 overflow-y-auto">
              <table className="w-full">
                <thead className="bg-surface-sunken sticky top-0">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-fg-muted uppercase tracking-wider">
                      {t('table.column.name')}
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-fg-muted uppercase tracking-wider">
                      {t('table.column.type')}
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-fg-muted uppercase tracking-wider">
                      {t('table.column.nullable')}
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-fg-muted uppercase tracking-wider">
                      {t('table.column.primaryKey')}
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-fg-muted uppercase tracking-wider">
                      {t('table.column.default')}
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-surface divide-y divide-line">
                  {tableSchema.columns.map((column, index) => (
                    <tr key={index} className="hover:bg-surface-hover">
                      <td className="px-4 py-3 text-sm font-medium text-fg">
                        {column.name}
                      </td>
                      <td className="px-4 py-3 text-sm text-fg-muted">
                        <span className="inline-flex items-center px-2 py-1 rounded-control text-xs font-medium bg-accent-soft text-accent">
                          {column.data_type}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-fg-muted">
                        {column.is_nullable ? (
                          <span className="inline-flex items-center px-2 py-1 rounded-control text-xs font-medium bg-success-soft text-success">
                            {t('table.yes')}
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-1 rounded-control text-xs font-medium bg-danger-soft text-danger">
                            {t('table.no')}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-fg-muted">
                        {column.is_primary_key ? (
                          <span className="inline-flex items-center px-2 py-1 rounded-control text-xs font-medium bg-accent-soft text-accent">
                            {t('table.column.primaryKey')}
                          </span>
                        ) : (
                          <span className="text-fg-subtle">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-fg-muted">
                        {column.default_value ? (
                          <code className="text-xs bg-surface-hover px-2 py-1 rounded-control">
                            {column.default_value}
                          </code>
                        ) : (
                          <span className="text-fg-subtle">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <SchemaObjectSections objects={schemaObjects} dbType={connection.db_type} />
            </div>
          </div>
        )}

        {/* 数据标签页 */}
        {activeTab === 'data' && (
          <div className="h-full flex flex-col">
            <div className="p-4 border-b bg-surface-sunken flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-fg">{t('table.dataTitle')}</h2>
                <p className="text-xs text-fg-muted mt-1">
                  {t('table.rowCount', { count: totalRows })}
                </p>
                {paginationOrder?.strategy === 'primary-key' && (
                  <p className="text-xs mt-1 text-success">
                    {t('table.stablePagination', { columns: paginationOrder.columns.join(', ') })}
                  </p>
                )}
              </div>
              
              <div className="flex items-center space-x-2">
                {/* 编辑操作按钮 */}
                {editState.mode === 'view' && (
                  <>
                    {editable && (
                    <button
                      onClick={startAddRow}
                      className="flex items-center space-x-1 px-3 py-1.5 text-sm text-success border border-success-line rounded-control hover:bg-success-soft transition-colors"
                    >
                      <Plus size={14} />
                      <span>{t('table.add')}</span>
                    </button>
                    )}

                    <div className="relative">
                      <button
                        onClick={() => setShowColumnMenu((open) => !open)}
                        className={clsx(
                          'flex items-center space-x-1 rounded-control border px-3 py-1.5 text-sm transition-colors',
                          hiddenColumns.size > 0
                            ? 'border-accent-line bg-accent-soft text-accent'
                            : 'border-line-strong text-fg hover:bg-surface-hover'
                        )}
                        title={hiddenColumns.size > 0
                          ? t('columns.hiddenCount', { count: hiddenColumns.size })
                          : t('columns.title')}
                      >
                        <Columns3 size={14} />
                        <span>{t('columns.title')}</span>
                        {hiddenColumns.size > 0 && <span>({visibleIndexes.length}/{columnNames.length})</span>}
                      </button>
                      {showColumnMenu && (
                        <GridColumnMenu
                          columns={columnNames}
                          hidden={hiddenColumns}
                          onToggle={(name) => (
                            setHiddenColumns((current) => toggleHiddenColumn(current, columnNames, name))
                          )}
                          onShowAll={() => setHiddenColumns(new Set())}
                          density={density}
                          onDensityChange={setDensity}
                          frozenCount={frozenCount}
                          onFrozenCountChange={setFrozenCount}
                          onClose={() => setShowColumnMenu(false)}
                        />
                      )}
                    </div>

                    <button
                      onClick={() => setShowFilters((open) => !open)}
                      className={clsx(
                        'flex items-center space-x-1 rounded-control border px-3 py-1.5 text-sm transition-colors',
                        appliedFilterCount > 0
                          ? 'border-accent-line bg-accent-soft text-accent'
                          : 'border-line-strong text-fg hover:bg-surface-hover'
                      )}
                    >
                      <Filter size={14} />
                      <span>{t('filter.title')}</span>
                      {appliedFilterCount > 0 && <span>({appliedFilterCount})</span>}
                    </button>

                    <button
                      onClick={() => setShowExport(true)}
                      disabled={tableData.length === 0}
                      className="flex items-center space-x-1 px-3 py-1.5 text-sm text-fg border border-line-strong rounded-control hover:bg-surface-hover transition-colors disabled:opacity-50"
                      title={t('export.exportCurrentPage')}
                    >
                      <Download size={14} />
                      <span>{t('result.export')}</span>
                    </button>
                  </>
                )}
                
                {/* 保存/取消按钮 */}
                {editState.mode !== 'view' && (
                  <>
                    <button
                      onClick={saveEdit}
                      disabled={editingLoading}
                      className="flex items-center space-x-1 px-3 py-1.5 text-sm text-accent border border-accent-line rounded-control hover:bg-accent-soft transition-colors disabled:opacity-50"
                    >
                      {editingLoading ? (
                        <RefreshCw size={14} className="animate-spin" />
                      ) : (
                        <Save size={14} />
                      )}
                      <span>{t('table.save')}</span>
                    </button>
                    
                    <button
                      onClick={cancelEdit}
                      disabled={editingLoading}
                      className="flex items-center space-x-1 px-3 py-1.5 text-sm text-fg-muted border border-line-strong rounded-control hover:bg-surface-hover transition-colors disabled:opacity-50"
                    >
                      <X size={14} />
                      <span>{t('common.cancel')}</span>
                    </button>
                  </>
                )}
                
                <span className="text-sm text-fg-muted">{t('table.pageSizeLabel')}</span>
                <select
                  value={pageSize}
                  onChange={(e) => handlePageSizeChange(Number(e.target.value))}
                  className="text-sm border border-line-strong rounded-control px-2 py-1"
                >
                  {GRID_PAGE_SIZE_OPTIONS.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>
            </div>

            {(showFilters || filters.length > 0) && tableSchema && (
              <TableFilterBar
                columns={tableSchema.columns}
                filters={filters}
                onChange={setFilters}
                onApply={applyFilters}
                pending={filtersPending}
                activeCount={appliedFilterCount}
                disabled={loading}
              />
            )}

            {/* 编辑错误提示 */}
            {editingError && (
              <div className="p-3 bg-danger-soft border-b border-danger-line">
                <div className="flex items-center space-x-2">
                  <AlertCircle className="text-danger" size={14} />
                  <span className="text-danger text-sm">{editingError}</span>
                </div>
              </div>
            )}

            <PendingChangesBar
              count={changes.length}
              committing={editingLoading}
              error={editingError}
              onPreview={() => setShowChanges(true)}
              onRevertAll={revertAllChanges}
              onCommit={commitChanges}
            />

            {commitNotice && changes.length === 0 && (
              <div className="border-b border-success-line bg-success-soft px-4 py-2 text-xs text-success">
                {commitNotice}
              </div>
            )}

            {/* 不能改就说清为什么。把按钮藏起来却不解释，用户只会以为界面坏了。
                `metadata-pending` 不进这里：它在同一次加载里就会有结论，
                先闪一条警告再收回去，比什么都不说更让人不安 */}
            {readOnlyMessage && (
              <div className="flex items-start gap-2 border-b border-warning-line bg-warning-soft px-4 py-2">
                <Lock className="mt-0.5 shrink-0 text-warning" size={14} />
                <div className="text-xs text-warning">
                  {/* 做成有边框的小标签：贴着后面那句话的裸文字会被读成同一句的开头 */}
                  <span className="mr-1.5 rounded-control border border-warning-line px-1 py-0.5 font-medium">
                    {t('table.readOnly.badge')}
                  </span>
                  {readOnlyMessage}
                </div>
              </div>
            )}

            {/* 添加新行表单 */}
            {editState.mode === 'add' && editState.editedData && tableSchema && (
              <div className="p-4 bg-accent-soft border-b border-accent-line">
                <div className="flex items-center space-x-2 mb-3">
                  <Plus className="text-accent" size={16} />
                  <h3 className="text-sm font-medium text-fg">{t('table.addRowTitle')}</h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {tableSchema.columns.map((column) => (
                    <div key={column.name} className="flex flex-col">
                      <label className="mb-1 text-xs font-medium text-fg">
                        {column.name}
                        {column.is_primary_key && (
                          <span className="ml-1 text-accent">{t('table.primaryKeyTag')}</span>
                        )}
                        {isGeneratedKeyColumn(column) && (
                          <span className="ml-1 text-success">{t('table.autoIncrementTag')}</span>
                        )}
                        {!column.is_nullable && column.default_value == null && (
                          <span className="ml-1 text-danger">*</span>
                        )}
                        <span className="ml-1 font-normal text-fg-subtle">{column.data_type}</span>
                      </label>
                      <CellInputEditor
                        value={editState.editedData?.[column.name] ?? { kind: 'unset' }}
                        onChange={(next) => updateEditData(column.name, next)}
                        dataType={column.data_type}
                        dialect={dialect}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 滚动表格容器 */}
            <div className="flex-1 overflow-hidden">
              {tableData.length === 0 ? (
                loading ? (
                  <div className="flex items-center justify-center h-full">
                    <RefreshCw className="animate-spin text-fg-subtle" size={20} />
                    <span className="ml-2 text-fg-muted">{t('table.loading')}</span>
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-full text-fg-muted">
                    {t('table.empty')}
                  </div>
                )
              ) : (
                <div className="relative h-full flex flex-col">
                  {/* 加载时不把表格拆掉，只盖一层。拆掉的话滚动容器随之销毁，
                      刷新后横竖滚动都回到原点——而用户按刷新正是想看**这几行**
                      的最新值 */}
                  {loading && (
                    <div className="absolute inset-0 z-40 flex items-start justify-center bg-surface/60 pt-8">
                      <span className="flex items-center gap-2 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-fg-muted shadow">
                        <RefreshCw className="animate-spin text-fg-subtle" size={16} />
                        {t('table.loading')}
                      </span>
                    </div>
                  )}
                  {/* 列宽跟着内容走之后横向滚动是常态，不再用提示条解释它 */}
                  {cells.copyError && (
                    <div className="border-b border-danger-line bg-danger-soft px-3 py-1.5 text-xs text-danger">
                      {t('result.copyFailed', { reason: cells.copyError })}
                    </div>
                  )}

                  <div {...cells.gridProps} className="flex-1 overflow-auto focus:outline-none">
                    <div style={{ width: `${gridWidth}px`, minWidth: '100%' }}>
                      {/* 按量出来的宽度铺，不用 w-full：w-full 会把富余宽度按比例
                          摊给各列，量出来的列宽就失去意义了 */}
                      <table
                        className="table-fixed border-collapse"
                        style={{ width: `${gridWidth}px` }}
                      >
                        <colgroup>
                          {visibleWidths.map((width, index) => (
                            <col key={index} style={{ width: `${width}px` }} />
                          ))}
                          <col style={{ width: `${ACTION_COLUMN_WIDTH}px` }} />
                        </colgroup>
                        <thead className="bg-surface-sunken sticky top-0 z-20">
                          <tr>
                            {visibleIndexes.map((index, visiblePosition) => {
                              const column = tableSchema?.columns[index];
                              if (!column) {
                                return null;
                              }
                              const frozenLeft = frozenOffsets[visiblePosition];
                              return (
                              <th
                                key={index}
                                // 冻结列自己接管 sticky：thead 的 sticky top 只管纵向，
                                // 横向要在每个 th 上单独钉住，并压过后面滚过来的列
                                style={frozenLeft === null ? undefined : { left: `${frozenLeft}px` }}
                                className={clsx(
                                  'relative border-r border-line px-2 py-1 text-left text-xs font-medium text-fg',
                                  frozenLeft !== null && 'sticky top-0 z-30 bg-surface-sunken',
                                  visiblePosition === lastFrozenPosition && 'border-r-2 border-r-line-strong'
                                )}
                              >
                                <div className="flex items-center gap-1">
                                  <ColumnSortButton
                                    columnLabel={column.name}
                                    direction={sort?.column === column.name ? sort.direction : null}
                                    onToggle={() => {
                                      const next = nextColumnSort(sortRef.current, column.name);
                                      setSort(next);
                                      sortRef.current = next;
                                      setCurrentPage(1);
                                      void loadTableData(1);
                                    }}
                                  />
                                  <span className="truncate" title={column.name}>{column.name}</span>
                                  {column.is_primary_key && (
                                    <span className="shrink-0 text-warning" title={t('table.column.primaryKey')}>🔑</span>
                                  )}
                                  {!column.is_nullable && (
                                    <span className="shrink-0 text-danger" title={t('table.notNull')}>*</span>
                                  )}
                                </div>
                                <div
                                  className="truncate text-[10px] font-normal text-fg-subtle"
                                  title={column.data_type}
                                >
                                  {column.data_type}
                                </div>
                                <ColumnResizeHandle
                                  active={resizingIndex === index}
                                  onPointerDown={(event) => startResize(index, event)}
                                  onDoubleClick={() => autoFitColumn(index)}
                                />
                              </th>
                              );
                            })}
                            <th className="px-2 py-1 text-left text-xs font-medium text-fg">{t('result.actions')}</th>
                          </tr>
                        </thead>
                        
                        <tbody className="bg-surface divide-y divide-line">
                          {tableData.map((row, rowIndex) => {
                            const pending = pendingFor(row);
                            return (
                            <tr
                              key={rowIndex}
                              className={clsx(
                                'hover:bg-surface-hover',
                                // 排了队的行要看得见：否则「待提交 3 项」和网格上
                                // 这几行毫无关系，用户只能靠预览去对
                                pending?.kind === 'delete' && 'bg-danger-soft line-through opacity-70',
                                pending?.kind === 'update' && 'bg-accent-soft'
                              )}
                            >
                              {visibleIndexes.map((colIndex, visiblePosition) => {
                                const column = tableSchema?.columns[colIndex];
                                if (!column) {
                                  return null;
                                }
                                return (
                                <EditableCell
                                  key={colIndex}
                                  value={row[column.name]}
                                  field={column.name}
                                  isEditing={editState.mode === 'edit' && editState.rowIndex === rowIndex}
                                  isKeyColumn={keyColumnSet.has(column.name)}
                                  dataType={column.data_type}
                                  align={alignments[colIndex]}
                                  densityClass={densityClass}
                                  frozenLeft={frozenOffsets[visiblePosition]}
                                  lastFrozen={visiblePosition === lastFrozenPosition}
                                  selected={cells.isSelected(rowIndex, visiblePosition)}
                                  focused={cells.isFocused(rowIndex, visiblePosition)}
                                  onSelect={(extend) => cells.selectCell(rowIndex, visiblePosition, extend)}
                                  onContextMenu={(event) => {
                                    event.preventDefault();
                                    // 右击一个不在选区里的格子先把它选上：菜单里那几条
                                    // 都作用于选区，否则复制出来的是别处的内容
                                    if (!cells.isSelected(rowIndex, visiblePosition)) {
                                      cells.selectCell(rowIndex, visiblePosition);
                                    }
                                    setContextTarget({
                                      row: rowIndex,
                                      column: visiblePosition,
                                      x: event.clientX,
                                      y: event.clientY
                                    });
                                  }}
                                />
                                );
                              })}
                              {/* 操作列 */}
                              <td className="border-l border-line px-2 py-1 text-sm">
                                {editState.mode === 'view' ? (
                                  pending ? (
                                    // 已经排了队的行只给一个撤销：再编辑一次要么
                                    // 覆盖刚才那次，要么和待删除打架，两种都不好解释
                                    <button
                                      onClick={() => setChanges((current) => revertChange(current, pending.id))}
                                      className="flex items-center gap-1 rounded-control border border-line-strong px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-surface-hover"
                                    >
                                      <Undo2 size={11} />
                                      {t('changes.revert')}
                                    </button>
                                  ) : editable ? (
                                  <div className="flex items-center space-x-1">
                                    <button
                                      onClick={() => startEditRow(rowIndex)}
                                      className="p-1 text-accent hover:text-accent hover:bg-accent-soft rounded-control"
                                      title={t('table.edit')}
                                    >
                                      <Edit size={14} />
                                    </button>
                                    <button
                                      onClick={() => deleteRow(rowIndex)}
                                      className="p-1 text-danger hover:text-danger hover:bg-danger-soft rounded-control"
                                      title={t('table.operation.delete')}
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </div>
                                  ) : (
                                    <span className="text-fg-subtle" title={t('table.readOnly.badge')}>
                                      <Lock size={14} />
                                    </span>
                                  )
                                ) : editState.mode === 'edit' && editState.rowIndex === rowIndex ? (
                                  <div className="flex items-center space-x-1">
                                    <button
                                      onClick={saveEdit}
                                      disabled={editingLoading}
                                      className="p-1 text-success hover:text-success hover:bg-success-soft rounded-control disabled:opacity-50"
                                      title={t('table.save')}
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
                                      className="p-1 text-fg-muted hover:text-fg hover:bg-surface-hover rounded-control disabled:opacity-50"
                                      title={t('common.cancel')}
                                    >
                                      <X size={14} />
                                    </button>
                                  </div>
                                ) : null}
                              </td>
                            </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  
                  {/* 分页控件 */}
                  {totalPages > 1 && (
                    <div className="px-4 py-3 bg-surface-sunken border-t flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <span className="text-sm text-fg">
                          {t('result.range', { from: (currentPage - 1) * pageSize + 1, to: Math.min(currentPage * pageSize, totalRows), total: totalRows })}
                        </span>
                      </div>
                      
                      <div className="flex items-center space-x-1">
                        <button
                          onClick={() => handlePageChange(1)}
                          disabled={currentPage === 1}
                          className="p-1 rounded-control hover:bg-surface-active disabled:opacity-50"
                        >
                          <ChevronsLeft size={16} />
                        </button>
                        <button
                          onClick={() => handlePageChange(currentPage - 1)}
                          disabled={currentPage === 1}
                          className="p-1 rounded-control hover:bg-surface-active disabled:opacity-50"
                        >
                          <ChevronLeft size={16} />
                        </button>
                        <span className="px-3 py-1 text-sm text-fg">
                          {t('result.pageOf', { page: currentPage, total: totalPages })}
                        </span>
                        <button
                          onClick={() => handlePageChange(currentPage + 1)}
                          disabled={currentPage === totalPages}
                          className="p-1 rounded-control hover:bg-surface-active disabled:opacity-50"
                        >
                          <ChevronRight size={16} />
                        </button>
                        <button
                          onClick={() => handlePageChange(totalPages)}
                          disabled={currentPage === totalPages}
                          className="p-1 rounded-control hover:bg-surface-active disabled:opacity-50"
                        >
                          <ChevronsRight size={16} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ER 图标签页 */}
      </div>

      {/* 表数据是服务端分页的，内存里只有当前这一页——导出必须如实说明范围 */}
      {contextTarget && (
        <GridContextMenu
          target={contextTarget}
          onCopy={(withHeaders) => cells.copy(withHeaders)}
          onCopyRow={(row) => cells.copyRow(row)}
          onCopyColumn={(column) => cells.copyColumn(column, true)}
          onClose={() => setContextTarget(null)}
        />
      )}

      {showChanges && (
        <ChangeDiffDialog
          changes={changes}
          target={writeTarget()}
          committing={editingLoading}
          failure={commitFailure}
          onRevert={(id) => setChanges((current) => revertChange(current, id))}
          onRevertAll={revertAllChanges}
          onCommit={commitChanges}
          onClose={() => setShowChanges(false)}
        />
      )}

      {showExport && (
        <ExportResultDialog
          columns={visibleIndexes.map((index) => columnNames[index] ?? '')}
          rows={visibleRows}
          sourceName={tableName}
          scopeNote={
            // 导出跟着可见列走，否则藏起来的列会在文件里冒出来。范围话必须说全：
            // 少了哪几列不写出来，用户直到打开文件才发现
            t('export.scopeCurrentPage', { page: currentPage, rows: tableData.length, total: totalRows })
            + (hiddenColumns.size > 0
              ? ` ${t('export.scopeHiddenColumns', { count: hiddenColumns.size })}`
              : '')
          }
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  );
}
