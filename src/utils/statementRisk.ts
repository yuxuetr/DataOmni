import type { ConnectionEnvironment } from '../contracts';
import { topLevelKeywords } from './sqlStatements';

/**
 * 一条语句的破坏性等级。
 *
 * 分级依据是「执行错了要付多大代价」，不是「它改不改数据」：
 * INSERT 是追加，撤销代价小；带 WHERE 的 UPDATE / DELETE 影响面有界；
 * 不带 WHERE 的会扫掉整张表；DROP / TRUNCATE 连结构和全部数据一起没。
 */
export type StatementRisk =
  | 'read'
  | 'append'
  | 'scoped-write'
  | 'bulk-write'
  | 'destructive';

const READ_KEYWORDS = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'PRAGMA', 'VALUES'];

export function classifyStatementRisk(sql: string): StatementRisk {
  const keywords = topLevelKeywords(sql);
  const first = keywords[0];

  if (!first) {
    return 'read';
  }

  if (first === 'DROP' || first === 'TRUNCATE') {
    return 'destructive';
  }

  // ALTER 本身不一定危险，但 ALTER … DROP COLUMN 会丢掉一整列的数据
  if (first === 'ALTER') {
    return keywords.includes('DROP') ? 'destructive' : 'scoped-write';
  }

  if (first === 'DELETE' || first === 'UPDATE') {
    // WHERE 在顶层才算数：子查询里的 WHERE 限制不了外层影响的行数
    return keywords.includes('WHERE') ? 'scoped-write' : 'bulk-write';
  }

  if (first === 'INSERT' || first === 'REPLACE') {
    return 'append';
  }

  if (first === 'WITH') {
    // CTE 的头是 WITH，真正做事的是后面那个动词
    const action = keywords.find(
      (keyword) => keyword === 'DELETE' || keyword === 'UPDATE' || keyword === 'INSERT'
    );
    if (action === 'INSERT') {
      return 'append';
    }
    if (action === 'DELETE' || action === 'UPDATE') {
      return keywords.includes('WHERE') ? 'scoped-write' : 'bulk-write';
    }
    return 'read';
  }

  if (READ_KEYWORDS.includes(first)) {
    return 'read';
  }

  // CREATE、GRANT、SET、BEGIN 等：会改状态，但不会抹掉已有数据
  return 'scoped-write';
}

/**
 * 要不要拦一道。
 *
 * 「拦不拦」只看语句本身，「说得多重」才看环境——见下面的文案。
 * 有界的写入只在生产上拦：预发和开发上每改一行都弹窗，弹到第三次就没人看了，
 * 真正危险的那次也会被顺手点掉。
 */
export function requiresConfirmation(
  risk: StatementRisk,
  environment: ConnectionEnvironment
): boolean {
  if (risk === 'read' || risk === 'append') {
    return false;
  }

  if (risk === 'bulk-write' || risk === 'destructive') {
    return true;
  }

  return environment === 'production';
}

/** 给人看的一句话说明，用在确认框标题里 */
export function describeStatementRisk(risk: StatementRisk): string {
  switch (risk) {
    case 'destructive':
      return '删除表或清空数据';
    case 'bulk-write':
      return '没有 WHERE 条件，将影响整张表';
    case 'scoped-write':
      return '会修改数据';
    case 'append':
      return '会新增数据';
    case 'read':
      return '只读';
  }
}

/** 一批语句里最危险的那个等级；没有需要确认的就返回 null */
export function highestRiskNeedingConfirmation(
  statements: readonly string[],
  environment: ConnectionEnvironment
): { sql: string; risk: StatementRisk } | null {
  const order: StatementRisk[] = ['read', 'append', 'scoped-write', 'bulk-write', 'destructive'];
  let worst: { sql: string; risk: StatementRisk } | null = null;

  for (const sql of statements) {
    const risk = classifyStatementRisk(sql);
    if (!requiresConfirmation(risk, environment)) {
      continue;
    }
    if (!worst || order.indexOf(risk) > order.indexOf(worst.risk)) {
      worst = { sql, risk };
    }
  }

  return worst;
}
