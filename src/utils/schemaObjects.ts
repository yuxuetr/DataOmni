/**
 * 把目录查询返回的「每列一行」结果合成结构对象。
 *
 * 分组本身就是逻辑：复合键的列顺序必须按 ordinal 决定，不能按行到达的顺序。
 * 驱动不保证行序，而一旦本表列与被引用列错位，结果看上去完全正常——
 * 三列外键指向了三个错的列，页面上却是一行整齐的 `(a, b, c) → (x, y, z)`。
 */

/** 数据库给不出列名时的占位。SQLite 的表达式索引既没有列名也没有表达式原文。 */
export const EXPRESSION_COLUMN_PLACEHOLDER = '<表达式>';

export interface IndexInfo {
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  /** btree / hash 等；SQLite 没有 */
  method: string | null;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  referencedSchema: string | null;
  referencedTable: string;
  /** SQLite 允许省略被引用列（默认父表主键），那一位是 null */
  referencedColumns: Array<string | null>;
  onUpdate: string | null;
  onDelete: string | null;
}

export interface CheckConstraintInfo {
  name: string;
  expression: string;
}

type MetadataRow = Record<string, unknown>;

export function groupIndexRows(rows: readonly MetadataRow[]): IndexInfo[] {
  const byName = new Map<string, { row: MetadataRow; columns: Array<{ ordinal: number; name: string }> }>();

  for (const row of rows) {
    const name = text(row.index_name);
    if (!name) {
      continue;
    }

    const group = byName.get(name) ?? { row, columns: [] };
    group.columns.push({
      ordinal: number(row.ordinal),
      name: text(row.column_name) || EXPRESSION_COLUMN_PLACEHOLDER
    });
    byName.set(name, group);
  }

  const indexes = [...byName.entries()].map(([name, group]) => ({
    name,
    columns: byOrdinal(group.columns).map(column => column.name),
    isUnique: boolean(group.row.is_unique),
    isPrimary: boolean(group.row.is_primary),
    method: text(group.row.method) || null
  }));

  // 主键 → 唯一 → 其它，同类按名字。找「这张表靠什么唯一」是最常见的问题，
  // 答案不该埋在一串自动生成的索引名中间。
  return indexes.sort((left, right) =>
    rank(left) - rank(right) || left.name.localeCompare(right.name)
  );
}

export function groupForeignKeyRows(rows: readonly MetadataRow[]): ForeignKeyInfo[] {
  const byName = new Map<
    string,
    { row: MetadataRow; pairs: Array<{ ordinal: number; column: string; referenced: string | null }> }
  >();

  for (const row of rows) {
    const name = text(row.constraint_name);
    if (!name) {
      continue;
    }

    const group = byName.get(name) ?? { row, pairs: [] };
    group.pairs.push({
      ordinal: number(row.ordinal),
      column: text(row.column_name),
      referenced: text(row.referenced_column) || null
    });
    byName.set(name, group);
  }

  return [...byName.entries()].map(([name, group]) => {
    const pairs = byOrdinal(group.pairs);
    return {
      name,
      columns: pairs.map(pair => pair.column),
      referencedSchema: text(group.row.referenced_schema) || null,
      referencedTable: text(group.row.referenced_table),
      referencedColumns: pairs.map(pair => pair.referenced),
      onUpdate: text(group.row.on_update) || null,
      onDelete: text(group.row.on_delete) || null
    };
  });
}

export function toCheckConstraints(rows: readonly MetadataRow[]): CheckConstraintInfo[] {
  return rows.map(row => ({
    name: text(row.constraint_name),
    expression: text(row.expression)
  }));
}

function byOrdinal<T extends { ordinal: number }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.ordinal - right.ordinal);
}

function rank(index: IndexInfo): number {
  if (index.isPrimary) {
    return 0;
  }
  return index.isUnique ? 1 : 2;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** MySQL 与 SQLite 的布尔是 1 / 0，PostgreSQL 才是真布尔。 */
function boolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  return value === '1' || value === 'true';
}
