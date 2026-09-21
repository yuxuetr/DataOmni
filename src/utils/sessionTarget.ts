/**
 * 连上去之后，一条不带前缀的语句默认落在哪。
 *
 * 刻意不叫「会话状态」：`tauri-plugin-sql` 用的是 sqlx 默认的连接池（最多 10
 * 条连接），`SET search_path` 只改动其中一条，下一条查询可能落在另一条上。
 * 所以这里说的是**新查询拿到的默认值**，不是「会话现在在哪」——后者在一个
 * 连接池上根本不是一个有定义的概念。
 */
export interface SessionTarget {
  /** 服务端报的库名。SQLite 没有这个概念（库就是那个文件），为 null */
  database: string | null;
  /** 服务端报的 schema。只有 PostgreSQL 有，其余为 null */
  schema: string | null;
  /** 服务端拒绝写入：只读副本，或 SQLite 打开了 query_only */
  readOnly: boolean;
}

export const UNKNOWN_SESSION_TARGET: SessionTarget = {
  database: null,
  schema: null,
  readOnly: false
};

export function normalizeSessionTarget(
  row: Record<string, unknown> | undefined
): SessionTarget {
  if (!row) {
    return UNKNOWN_SESSION_TARGET;
  }

  return {
    database: text(row.database_name),
    schema: text(row.schema_name),
    readOnly: flag(row.read_only)
  };
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  // 空串和 NULL 是一回事：都表示「这里没有可显示的名字」
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * PostgreSQL 的布尔表达式解码成 boolean，MySQL 与 SQLite 的解码成 0 / 1。
 * 只认这两种写法：认不出的东西按「不是只读」处理，因为把一个可写的连接
 * 标成只读会让人绕开本来能做的事。
 */
function flag(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  return false;
}
