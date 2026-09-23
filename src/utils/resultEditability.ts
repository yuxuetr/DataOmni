import type { RowIdentityResult } from './rowIdentity';
import type { SqlIdentifierDialect } from './sqlIdentifiers';
import { topLevelKeywords } from './sqlStatements';

/**
 * 一份查询结果能不能就地改。
 *
 * 判断必须是**证明**，不是猜测。此前这里先按列名猜主键（「有没有一列叫 id」），
 * 在一张把别人的 id 冗余存下来的表上，那一列指向的是完全错误的行，而拼出的
 * UPDATE 语法正确、执行成功、不报任何错。
 *
 * 所以只承认能一眼看穿的形态：单表、投影里每一项都是**裸列名**（没有别名、
 * 没有表达式、没有函数）、没有 JOIN / UNION / GROUP BY / DISTINCT。认不出来
 * 就只读——漏判一个本可编辑的查询，代价是用户去表视图里改；错判一个不可编辑的，
 * 代价是改掉别人的数据。
 */

export interface SingleTableSelect {
  schema: string | null;
  table: string;
  /** 投影里的列名；`null` 表示 `SELECT *`（含全部列） */
  projection: string[] | null;
}

export type ResultReadOnlyReason =
  /** 不是一条能映射到单表的 SELECT */
  | 'complex-query'
  /** 这张表没有能定位到唯一一行的键 */
  | 'missing-unique-key'
  /** 有键，但键列没被投影出来，拿不到键值 */
  | 'key-not-projected'
  /** 元数据还在读 */
  | 'metadata-pending';

export type ResultEditability =
  | { editable: true; schema: string | null; table: string; keyColumns: string[] }
  | { editable: false; reason: ResultReadOnlyReason };

/** 顶层出现就说明这条查询的行不再一一对应到某张表的行 */
const DISQUALIFYING_KEYWORDS = new Set([
  'JOIN', 'UNION', 'INTERSECT', 'EXCEPT', 'GROUP', 'HAVING', 'DISTINCT', 'WINDOW'
]);

const IDENTIFIER = String.raw`(?:"[^"]+"|\`[^\`]+\`|\[(?:[^\]]|\]\])+\]|[A-Za-z_][A-Za-z0-9_$]*)`;
const COLUMN_LIST = String.raw`${IDENTIFIER}(?:\s*,\s*${IDENTIFIER})*`;

const SELECT_SHAPE = new RegExp(
  // `TOP n` 只有 SQL Server 有，SSMS 的「选择前 1000 行」就是这个形状；
  // 它只截断行数，不改变每一行对应哪一行
  String.raw`^select\s+(?:top\s+(?:\(\s*\d+\s*\)|\d+)\s+)?(\*|${COLUMN_LIST})\s+from\s+(${IDENTIFIER})(?:\s*\.\s*(${IDENTIFIER}))?([\s\S]*)$`,
  'i'
);

/** `rest` 只能是这些子句开头。其余（别名、逗号连接、FOR UPDATE、INTO OUTFILE…）一律不认 */
const ALLOWED_TAIL = /^(where\b|order\s+by\b|limit\b|offset\b|fetch\b)/i;

/**
 * 去掉标识符的引号。
 *
 * PostgreSQL 会把**不带引号**的标识符折成小写，所以 `FROM Users` 指的是表
 * `users`；原样拿去查目录会一行都查不到，而现象是「这张表好像没有主键」。
 */
function unquoteIdentifier(raw: string, dialect: SqlIdentifierDialect): string {
  if (raw.startsWith('"') || raw.startsWith('`')) {
    return raw.slice(1, -1);
  }
  if (raw.startsWith('[')) {
    return raw.slice(1, -1).split(']]').join(']');
  }
  return dialect === 'postgresql' ? raw.toLowerCase() : raw;
}

export function parseSingleTableSelect(
  sql: string,
  dialect: SqlIdentifierDialect
): SingleTableSelect | null {
  const normalized = sql.trim().replace(/;\s*$/, '').trim();

  // 顶层关键字扫描会跳过字符串、注释和括号内容：`WHERE note = 'group by'`
  // 不该被当成分组，而子查询里的 JOIN 影响不了外层每行对应哪一行
  if (topLevelKeywords(normalized).some((keyword) => DISQUALIFYING_KEYWORDS.has(keyword))) {
    return null;
  }

  const match = SELECT_SHAPE.exec(normalized);
  if (!match) {
    return null;
  }

  const [, projectionText, first, second, rest] = match;
  const tail = rest.trim();
  if (tail !== '' && !ALLOWED_TAIL.test(tail)) {
    return null;
  }

  // 两段式名字里前一段是 schema。只有一段时 schema 交给目录查询按当前库补
  const qualified = second !== undefined;
  return {
    schema: qualified ? unquoteIdentifier(first, dialect) : null,
    table: unquoteIdentifier(qualified ? second : first, dialect),
    projection: projectionText === '*'
      ? null
      : projectionText.split(',').map((item) => unquoteIdentifier(item.trim(), dialect))
  };
}

export function describeResultEditability(
  parsed: SingleTableSelect | null,
  identity: RowIdentityResult
): ResultEditability {
  if (!parsed) {
    return { editable: false, reason: 'complex-query' };
  }
  if (!identity.identity) {
    return {
      editable: false,
      reason: identity.absence === 'no-unique-key' ? 'missing-unique-key' : 'metadata-pending'
    };
  }

  const keyColumns = identity.identity.columns;
  // 键列没被投影出来就拿不到键值，拼不出 WHERE。`SELECT *` 一定包含它们
  if (parsed.projection && keyColumns.some((name) => !parsed.projection?.includes(name))) {
    return { editable: false, reason: 'key-not-projected' };
  }

  return { editable: true, schema: parsed.schema, table: parsed.table, keyColumns: [...keyColumns] };
}
