import type { ConnectionEnvironment } from '../contracts';
import {
  DEFAULT_CONFIRMATION_POLICY,
  type ConfirmationPolicy
} from './confirmationPolicy';
import type { SqlDialect } from '../contracts/queryExecution';
import { splitSqlStatements, topLevelKeywords } from './sqlStatements';
import type { TranslationKey } from '../i18n/translate';

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

  // MERGE 没有顶层 WHERE 可看：`WHEN NOT MATCHED BY SOURCE THEN DELETE`
  // 会删掉目标表里所有对不上的行，影响面由数据决定
  if (first === 'MERGE') {
    return 'bulk-write';
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

  // `SELECT … INTO 新表` 在 SQL Server 与 PostgreSQL 里是建表，
  // MySQL 的 `INTO OUTFILE` 是写文件——都不是读
  if (first === 'SELECT' && keywords.includes('INTO')) {
    return 'scoped-write';
  }

  if (READ_KEYWORDS.includes(first)) {
    return 'read';
  }

  // CREATE、GRANT、SET、BEGIN 等：会改状态，但不会抹掉已有数据
  return 'scoped-write';
}

/** 由轻到重。阈值比较和「一批里最危险的那条」都按这个次序。 */
export const RISK_ORDER: readonly StatementRisk[] = [
  'read',
  'append',
  'scoped-write',
  'bulk-write',
  'destructive'
];

/**
 * 要不要拦一道。
 *
 * 判据是「这条语句的风险有没有达到该环境设定的门槛」。门槛可配置，默认值
 * 就是可配置之前的固定行为：有界的写入只在生产上拦，批量与破坏性到哪都拦。
 *
 * 读永远不拦：给每条 SELECT 弹一次确认，弹到第三次就没人看了，真正危险的
 * 那次也会被顺手点掉——那正是这道闸要避免的事。
 */
export function requiresConfirmation(
  risk: StatementRisk,
  environment: ConnectionEnvironment,
  policy: ConfirmationPolicy = DEFAULT_CONFIRMATION_POLICY
): boolean {
  if (risk === 'read') {
    return false;
  }

  const threshold = policy[environment];
  if (threshold === 'never') {
    return false;
  }

  return RISK_ORDER.indexOf(risk) >= RISK_ORDER.indexOf(threshold);
}

/**
 * 风险等级对应的文案键，用在确认框标题里。
 *
 * 返回键不返回文案：这个模块是纯的、被单测直接调用，不该依赖当前语言。
 * 写成完整的 Record，新增风险等级时这里编译不过。
 */
export const RISK_DESCRIPTION_KEYS: Record<StatementRisk, TranslationKey> = {
  destructive: 'risk.destructive',
  'bulk-write': 'risk.bulk-write',
  'scoped-write': 'risk.scoped-write',
  append: 'risk.append',
  read: 'risk.read'
};

const ROUTINE_KINDS = new Set(['PROCEDURE', 'PROC', 'FUNCTION', 'TRIGGER', 'VIEW']);

/**
 * 一「条」里可能不止一条语句：SQL Server 的脚本按 `GO` 分批，一批原样发出去，
 * 里面的分号不切。只按第一个词定级，`SELECT 1; DELETE FROM t` 会被当成只读、
 * 不弹确认。所以一批先按分号拆开，取最危险的那条。
 *
 * 例外是定义过程、函数、触发器、视图的那一批：过程体此刻不执行，里面的
 * `DELETE` 不该让「建一个过程」弹出整表删除的确认。
 */
export function classifyBatchRisk(sql: string, dialect?: SqlDialect): StatementRisk {
  const [first, second, third, fourth] = topLevelKeywords(sql);
  const definesRoutine = (first === 'CREATE' || first === 'ALTER')
    && (ROUTINE_KINDS.has(second) || (second === 'OR' && ROUTINE_KINDS.has(fourth ?? third)));
  const parts = definesRoutine ? [sql] : splitSqlStatements(sql, dialect);
  return parts
    .map(classifyStatementRisk)
    .reduce<StatementRisk>(
      (worst, risk) => (RISK_ORDER.indexOf(risk) > RISK_ORDER.indexOf(worst) ? risk : worst),
      'read'
    );
}

/** 一批语句里最危险的那个等级；没有需要确认的就返回 null */
export function highestRiskNeedingConfirmation(
  statements: readonly string[],
  environment: ConnectionEnvironment,
  policy?: ConfirmationPolicy,
  dialect?: SqlDialect
): { sql: string; risk: StatementRisk } | null {
  let worst: { sql: string; risk: StatementRisk } | null = null;

  for (const sql of statements) {
    const risk = classifyBatchRisk(sql, dialect);
    if (!requiresConfirmation(risk, environment, policy)) {
      continue;
    }
    if (!worst || RISK_ORDER.indexOf(risk) > RISK_ORDER.indexOf(worst.risk)) {
      worst = { sql, risk };
    }
  }

  return worst;
}
