import type Database from '@tauri-apps/plugin-sql';
import { invoke } from '@tauri-apps/api/core';
import type { ColumnInfo } from '../contracts';
import { describeRowIdentity, type RowIdentityResult } from './rowIdentity';
import { groupIndexRows } from './schemaObjects';
import { requireDatabase } from './requireDatabase';
import { catalogQueryParams, type SchemaMetadataQueries } from './catalogQueries';

/**
 * 表的列与键，从目录里读。
 *
 * 表视图和 SQL 结果表都要回答「这张表靠哪几列定位一行」，而它们此前各有一套
 * 做法：表视图查目录，SQL 结果表先猜列名（「有没有一列叫 id」）再查一个
 * **不带 schema 条件**、`LIMIT 1` 的目录查询。猜出来的键在一张冗余存了别人
 * id 的表上指向完全错误的行；`LIMIT 1` 则把复合主键砍成一列。两者拼出的
 * UPDATE 都语法正确、执行成功、不报任何错。
 */

/**
 * 目录行转成 `ColumnInfo`。
 *
 * 三段查询已经在 Rust 侧对齐成同一组列名与同一种类型，这里不再按方言认字段。
 * 只有布尔的**表示**还有差别：PostgreSQL 给真布尔，MySQL 与 SQLite 给 1/0，
 * 所以统一用真值判断而不是 `=== true`。
 */
export function toColumnInfo(rows: unknown): ColumnInfo[] {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.map((row) => {
    const col = row as Record<string, unknown>;
    const primaryKeyOrdinal = Number(col.primary_key_ordinal ?? 0);
    return {
      name: String(col.column_name ?? ''),
      data_type: String(col.data_type ?? ''),
      is_nullable: Boolean(col.is_nullable),
      is_primary_key: Boolean(col.is_primary_key),
      primary_key_ordinal: primaryKeyOrdinal > 0 ? primaryKeyOrdinal : undefined,
      default_value: (col.column_default ?? undefined) as string | undefined,
      is_generated: Boolean(col.is_generated),
      collation: (col.collation ?? null) as string | null,
      comment: (col.comment ?? null) as string | null,
      column_extra: (col.column_extra ?? null) as string | null
    };
  });
}

/** `get_schema_metadata_queries` 的返回里这里用得上列与索引两条 */
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
  try {
    const handle = requireDatabase(database);
    const queries = await invoke<SchemaMetadataQueries>('get_schema_metadata_queries', { dbType });
    const params = catalogQueryParams(queries.parameter_count, tableName, schema);
    const [columnRows, indexRows] = await Promise.all([
      handle.select(queries.columns, params),
      handle.select(queries.indexes, params)
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
