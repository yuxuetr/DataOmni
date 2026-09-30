import type { ColumnInfo } from '../contracts';
import type { ColumnSort } from './resultSorting';
import type { SqlIdentifierDialect } from './sqlIdentifiers';
import { quoteQualifiedSqlIdentifier, quoteSqlIdentifier } from './sqlIdentifiers';
import { translateNow } from '../stores/languageStore';
import { primaryKeyColumns } from './rowIdentity';
import { columnTypeToken } from './columnTypes';

export type TablePaginationOrderStrategy =
  | 'primary-key'
  | 'sqlite-rowid'
  | 'postgres-ctid'
  | 'all-columns';

export interface TablePaginationOrder {
  clause: string;
  strategy: TablePaginationOrderStrategy;
  columns: string[];
  stableAcrossChanges: boolean;
}

export function createTablePaginationOrder(
  columns: ColumnInfo[],
  dialect: SqlIdentifierDialect
): TablePaginationOrder {
  const keyColumns = primaryKeyColumns(columns);
  // ClickHouse 的主键不唯一（它是稀疏索引的排序前缀），按它排序时同键的行每页次序不定，
  // 翻页会重复或漏掉。主键列在前、其余列跟在后面：顺序是确定的（只有整行相同的才分不出，
  // 而那些本来就分不出），服务端按排序键顺序读、只给同键的那一截补排，不是每页整表排序
  if (dialect === 'clickhouse') {
    const rest = columns.map(column => column.name).filter(name => !keyColumns.includes(name));
    return createOrder([...keyColumns, ...rest], dialect, 'all-columns', false);
  }
  if (keyColumns.length > 0) {
    return createOrder(keyColumns, dialect, 'primary-key', true);
  }

  // DuckDB 的表同样有 `rowid` 伪列（没有另外两个别名）。分析用的表大多没有主键，
  // 退回按全部列排序的话，每翻一页都是一次整表排序
  if (dialect === 'sqlite' || dialect === 'duckdb') {
    const columnNames = new Set(columns.map(column => column.name.toLowerCase()));
    const rowIdentifier = (dialect === 'duckdb' ? ['rowid'] : ['rowid', '_rowid_', 'oid'])
      .find(candidate => !columnNames.has(candidate));
    if (!rowIdentifier) {
      return createOrder(
        columns.map(column => column.name),
        dialect,
        'all-columns',
        false
      );
    }
    return {
      clause: `ORDER BY ${rowIdentifier}`,
      strategy: 'sqlite-rowid',
      columns: [rowIdentifier],
      stableAcrossChanges: false
    };
  }

  if (dialect === 'postgresql') {
    return {
      clause: 'ORDER BY ctid',
      strategy: 'postgres-ctid',
      columns: ['ctid'],
      stableAcrossChanges: false
    };
  }

  // SQL Server 不许按这几种类型排序（Msg 249 / 305 / 306），ORDER BY 里有一列，
  // 这张表整张打不开。一列都不剩时给空子句，分页那一步补 ORDER BY (SELECT NULL)
  if (dialect === 'sqlserver') {
    const sortable = columns
      .filter(column => !SQL_SERVER_UNSORTABLE_TYPES.has(columnTypeToken(column.data_type)))
      .map(column => column.name);
    return sortable.length > 0
      ? createOrder(sortable, dialect, 'all-columns', false)
      : { clause: '', strategy: 'all-columns', columns: [], stableAcrossChanges: false };
  }

  return createOrder(
    columns.map(column => column.name),
    dialect,
    'all-columns',
    false
  );
}

const SQL_SERVER_UNSORTABLE_TYPES = new Set(['xml', 'text', 'ntext', 'image', 'geography', 'geometry']);

function createOrder(
  columns: string[],
  dialect: SqlIdentifierDialect,
  strategy: TablePaginationOrderStrategy,
  stableAcrossChanges: boolean
): TablePaginationOrder {
  if (columns.length === 0) {
    throw new Error(translateNow('error.paginationNoColumns'));
  }

  return {
    clause: `ORDER BY ${columns.map(column => quoteSqlIdentifier(column, dialect)).join(', ')}`,
    strategy,
    columns,
    stableAcrossChanges
  };
}

/**
 * 把用户选的排序列拼进分页排序。
 *
 * 关键在于末尾必须保留分页排序的列作为决胜条件：按一个不唯一的列排序时，
 * 数据库对同值行的返回次序是不保证的，翻页时同一行可能重复出现或整行消失。
 * 追加主键（或 rowid / ctid）之后每一行都有唯一次序，分页才是确定的。
 *
 * 空值位置交给数据库的默认行为，不额外拼 NULLS LAST——MySQL 不支持这个语法，
 * 为它做方言分支不值得。客户端排序（resultSorting）的约定是空值恒在末尾，
 * 两者在空值位置上可能不同，已在那边注明。
 */
export function createSortedOrderClause(
  paginationOrder: TablePaginationOrder,
  sort: ColumnSort | null,
  dialect: SqlIdentifierDialect
): string {
  if (!sort) {
    return paginationOrder.clause;
  }

  const direction = sort.direction === 'asc' ? 'ASC' : 'DESC';
  const terms = [`${quoteSqlIdentifier(sort.column, dialect)} ${direction}`];

  for (const column of paginationOrder.columns) {
    // 排序列已经在最前面了，不重复追加
    if (column === sort.column) {
      continue;
    }
    // rowid / ctid 是伪列，createTablePaginationOrder 生成时就没加引号
    const isPseudoColumn = paginationOrder.strategy === 'sqlite-rowid'
      || paginationOrder.strategy === 'postgres-ctid';
    terms.push(isPseudoColumn ? column : quoteSqlIdentifier(column, dialect));
  }

  return `ORDER BY ${terms.join(', ')}`;
}

/**
 * 排序子句之后的那一段：取第几页。
 *
 * SQL Server 没有 `LIMIT`，要写 `OFFSET … ROWS FETCH NEXT … ROWS ONLY`，而且
 * **必须**跟在 `ORDER BY` 后面。分页排序总是给得出列，这里仍然兜一句
 * `ORDER BY (SELECT NULL)`：少了它是一条语法错误，而不是一页顺序不稳的数据。
 */
export function pageClause(
  orderClause: string,
  limit: number,
  offset: number,
  dialect: SqlIdentifierDialect
): string {
  if (dialect === 'sqlserver') {
    const order = orderClause.trim() || 'ORDER BY (SELECT NULL)';
    return `${order} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }
  // Oracle 12c 起有同样的写法，而且不要求 ORDER BY；没有 LIMIT
  if (dialect === 'oracle') {
    return `${orderClause} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`.trim();
  }
  return `${orderClause} LIMIT ${limit} OFFSET ${offset}`;
}

/**
 * tiberius 解不了的列类型：`sql_variant` 与 CLR 类型的列元数据是 `todo!()`，结果里有一列
 * 这种类型，整条查询就失败。服务端转成文本再取——四种都认 `CAST(… AS nvarchar(max))`，
 * 改回去时文本也能隐式转回原类型（2022 上试过）
 */
const SQL_SERVER_UNREADABLE_TYPES = new Set(['sql_variant', 'geography', 'geometry', 'hierarchyid']);

/** 投影里的一列；驱动读不了的列转成文本，别名仍是列名，网格按列名取值 */
export function projectedColumn(column: ColumnInfo, dialect: SqlIdentifierDialect): string {
  const name = quoteSqlIdentifier(column.name, dialect);
  return dialect === 'sqlserver' && SQL_SERVER_UNREADABLE_TYPES.has(columnTypeToken(column.data_type))
    ? `CAST(${name} AS nvarchar(max)) AS ${name}`
    : name;
}

/**
 * 取表数据时 SELECT 后面那一段。
 *
 * 多数方言是 `*`。SQL Server 有驱动读不了的列时要点名，好把那几列转成文本。ClickHouse 的 `*` 不含 MATERIALIZED 与 ALIAS 列（网格里那几列会整列是 NULL），
 * 要一个个点名；打开 `asterisk_include_materialized_columns` 也行，但那是个设置，`readonly = 1`
 * 的账号改不了。EPHEMERAL 列不点：它不存值，点名去查报「There is no column」（25.8 上试过）；
 * 网格上那一列是空的，本来也没有值
 */
export function tableProjection(columns: readonly ColumnInfo[], dialect: SqlIdentifierDialect): string {
  if (dialect === 'sqlserver') {
    return columns.some(column => SQL_SERVER_UNREADABLE_TYPES.has(columnTypeToken(column.data_type)))
      ? columns.map(column => projectedColumn(column, dialect)).join(', ')
      : '*';
  }
  if (dialect !== 'clickhouse' || !columns.some(column => column.is_generated)) {
    return '*';
  }
  return columns
    .filter(column => !(column.column_extra ?? '').startsWith('EPHEMERAL'))
    .map(column => quoteSqlIdentifier(column.name, dialect))
    .join(', ');
}

/** 「先看前几行」的那条查询。名字要引用：带空格或保留字的表名此前直接语法错误 */
export function firstRowsQuery(
  table: string,
  schema: string | undefined,
  count: number,
  dialect: SqlIdentifierDialect
): string {
  const name = quoteQualifiedSqlIdentifier(schema ? [schema, table] : [table], dialect);
  if (dialect === 'sqlserver') {
    return `SELECT TOP ${count} * FROM ${name};`;
  }
  return dialect === 'oracle'
    ? `SELECT * FROM ${name} FETCH FIRST ${count} ROWS ONLY;`
    : `SELECT * FROM ${name} LIMIT ${count};`;
}
