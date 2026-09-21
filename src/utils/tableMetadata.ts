import type Database from '@tauri-apps/plugin-sql';
import { invoke } from '@tauri-apps/api/core';
import type { ColumnInfo } from '../contracts';
import { describeRowIdentity, type RowIdentityResult } from './rowIdentity';
import { groupIndexRows } from './schemaObjects';
import { quoteSqlIdentifier } from './sqlIdentifiers';
import { requireDatabase } from './requireDatabase';

/**
 * 表的列与键，从目录里读。
 *
 * 表视图和 SQL 结果表都要回答「这张表靠哪几列定位一行」，而它们此前各有一套
 * 做法：表视图查目录，SQL 结果表先猜列名（「有没有一列叫 id」）再查一个
 * **不带 schema 条件**、`LIMIT 1` 的目录查询。猜出来的键在一张冗余存了别人
 * id 的表上指向完全错误的行；`LIMIT 1` 则把复合主键砍成一列。两者拼出的
 * UPDATE 都语法正确、执行成功、不报任何错。
 */

const COLUMNS_QUERY: Record<string, string> = {
  postgresql: `
    SELECT
      c.column_name::text AS column_name,
      c.data_type::text AS data_type,
      c.is_nullable::text AS is_nullable,
      c.column_default::text AS column_default,
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
  `,
  mysql: `
    SELECT
      CAST(c.COLUMN_NAME AS CHAR) as column_name,
      CAST(c.DATA_TYPE AS CHAR) as data_type,
      CAST(c.IS_NULLABLE AS CHAR) as is_nullable,
      CAST(c.COLUMN_DEFAULT AS CHAR) as column_default,
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
  `
};

/**
 * 列查询与它的参数。
 *
 * SQLite 走 `PRAGMA table_info`，表名是**标识符**不是字符串字面量，只能插值；
 * 它也没有 schema 这一层。另外两家按绑定参数传表名与 schema。
 */
export function tableColumnsQuery(
  dbType: string,
  tableName: string,
  schema?: string
): { sql: string; params: unknown[] } | null {
  if (dbType === 'sqlite') {
    return { sql: `PRAGMA table_info(${quoteSqlIdentifier(tableName, 'sqlite')})`, params: [] };
  }
  const sql = COLUMNS_QUERY[dbType];
  return sql ? { sql, params: [tableName, schema ?? null] } : null;
}

/** 三种方言的列目录字段名各不相同，在这里合并成一种形状 */
export function toColumnInfo(rows: unknown): ColumnInfo[] {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.map((row) => {
    const col = row as Record<string, unknown>;
    // SQLite 的 pragma 用 `pk` 表示键内次序（0 = 不是主键），另两家用 ordinal_position
    const primaryKeyOrdinal = Number(col.primary_key_ordinal ?? col.pk ?? 0);
    return {
      name: String(col.column_name ?? col.name ?? ''),
      data_type: String(col.data_type ?? col.type ?? ''),
      is_nullable: col.is_nullable === 'YES' || col.notnull === 0,
      is_primary_key: primaryKeyOrdinal > 0 || col.is_primary_key === true,
      primary_key_ordinal: primaryKeyOrdinal > 0 ? primaryKeyOrdinal : undefined,
      default_value: (col.column_default ?? col.dflt_value) as string | undefined
    };
  });
}

/** `get_schema_metadata_queries` 的返回里这里只用得上索引那一条 */
interface IndexQueries {
  indexes: string;
}

export interface TableMetadata {
  columns: ColumnInfo[];
  identity: RowIdentityResult;
}

const UNAVAILABLE: TableMetadata = {
  columns: [],
  identity: { identity: null, absence: 'metadata-unavailable' }
};

/**
 * 读出这张表的列与行标识。
 *
 * 列不只是顺带：写入时要靠它们的声明类型决定数值列上的比较该内联还是绑定。
 *
 * 两次目录查询，只在调用方已经确认「这是一条单表 SELECT」之后才发——复杂查询
 * 本来就不可编辑，没必要为它付这个代价。**不做缓存**：缓存一个键意味着外部
 * 改了结构之后我们仍然拿旧键去定位行，而这条路径是写入。等真的测出目录查询
 * 是瓶颈再按 `schemaVersion` 缓存。
 */
export async function loadTableMetadata(
  database: Database | null,
  dbType: string,
  tableName: string,
  schema?: string
): Promise<TableMetadata> {
  const columnsQuery = tableColumnsQuery(dbType, tableName, schema);
  if (!columnsQuery) {
    return UNAVAILABLE;
  }

  try {
    const handle = requireDatabase(database);
    const queries = await invoke<IndexQueries>('get_schema_metadata_queries', { dbType });
    // SQLite 的 pragma 表值函数只认一个表名参数，没有 schema 概念
    const indexParams = dbType === 'sqlite' ? [tableName] : [tableName, schema ?? null];
    const [columnRows, indexRows] = await Promise.all([
      handle.select(columnsQuery.sql, columnsQuery.params),
      handle.select(queries.indexes, indexParams)
    ]);

    const columns = toColumnInfo(columnRows);
    return {
      columns,
      identity: describeRowIdentity(columns, {
        status: 'loaded',
        indexes: groupIndexRows(Array.isArray(indexRows) ? indexRows : [])
      })
    };
  } catch (error) {
    // 读不到和「确实没有唯一键」是两回事：前者不该让界面说出一句关于用户的表的假话
    console.error('读取表的行标识失败:', error);
    return UNAVAILABLE;
  }
}
