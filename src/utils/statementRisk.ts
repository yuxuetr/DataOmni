import type { ConnectionEnvironment } from '../contracts';
import {
  DEFAULT_CONFIRMATION_POLICY,
  type ConfirmationPolicy
} from './confirmationPolicy';
import type { SqlDialect } from '../contracts/queryExecution';
import { splitSqlStatements, sqlWords, topLevelKeywords, type SqlWord } from './sqlStatements';
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

// TABLE 是 PostgreSQL 与 MySQL 8 的 `TABLE t`；FROM、SUMMARIZE、PIVOT、UNPIVOT 是 DuckDB 的查询；
// EXISTS 是 ClickHouse 的 `EXISTS TABLE t`。别家不认这几个开头，当成读也误伤不到
const READ_KEYWORDS = [
  'SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'PRAGMA', 'VALUES',
  'TABLE', 'FROM', 'SUMMARIZE', 'PIVOT', 'UNPIVOT', 'EXISTS'
];

export function classifyStatementRisk(sql: string, dialect?: SqlDialect): StatementRisk {
  return riskOfWords(sqlWords(sql, dialect));
}

/** `EXPLAIN ANALYZE` 后面被解释（也就被执行）的那条语句的开头 */
const EXPLAINED_VERBS = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'WITH', 'REPLACE', 'TABLE', 'VALUES',
  'CREATE', 'EXECUTE'
]);

/** IF / WHILE / ELSE 后面会被执行的语句的开头 */
const CONTROLLED_VERBS = new Set([
  'DROP', 'TRUNCATE', 'DELETE', 'UPDATE', 'INSERT', 'MERGE', 'ALTER', 'SELECT'
]);

function riskOfWords(words: readonly SqlWord[]): StatementRisk {
  const keywords = words.filter((word) => word.group === 0).map((word) => word.word);
  // 括号开头的只能是查询，`(SELECT 1) UNION (SELECT 2)` 的顶层第一个词是 UNION，
  // 动词在括号里
  const first = words[0] && words[0].group !== 0 ? words[0].word : keywords[0];

  if (!first) {
    return 'read';
  }

  // PostgreSQL 与 MySQL 8 的 `EXPLAIN ANALYZE` 真的执行那条语句，只是不交回结果。
  // `EXPLAIN (ANALYZE, BUFFERS)` 的选项在括号里，所以不只看顶层
  if (first === 'EXPLAIN') {
    if (!words.some((word) => word.word === 'ANALYZE' || word.word === 'ANALYSE')) {
      return 'read';
    }
    const verb = words.findIndex(
      (word, index) => index > 0 && word.group === 0 && EXPLAINED_VERBS.has(word.word)
    );
    return verb < 0 ? 'read' : riskOfWords(words.slice(verb));
  }

  // T-SQL 的流程控制：IF / WHILE 后面先是条件，再是此刻就执行的语句（`IF OBJECT_ID(…) IS NOT NULL
  // DROP TABLE t`）。条件里的子查询在括号里，不算；每条到下一个 ELSE 为止，两个分支取更危险的
  if (first === 'IF' || first === 'WHILE' || first === 'ELSE') {
    return words.reduce<StatementRisk>((risk, word, index) => {
      if (index === 0 || word.group !== 0 || !CONTROLLED_VERBS.has(word.word)) {
        return risk;
      }
      const elseAt = words.findIndex((other, at) => at > index && other.group === 0 && other.word === 'ELSE');
      return worse(risk, riskOfWords(words.slice(index, elseAt < 0 ? undefined : elseAt)));
    }, 'scoped-write');
  }

  if (first === 'DROP' || first === 'TRUNCATE' || replacesTable(keywords)) {
    return 'destructive';
  }

  // ALTER 本身不一定危险，但 ALTER … DROP COLUMN 会丢掉一整列的数据，
  // TRUNCATE PARTITION（MySQL、Oracle）清掉整个分区，ClickHouse 的 CLEAR COLUMN 清空一整列
  if (first === 'ALTER') {
    const clearsColumn = keywords.some((keyword, index) => keyword === 'CLEAR' && keywords[index + 1] === 'COLUMN');
    return keywords.includes('DROP') || keywords.includes('TRUNCATE') || clearsColumn
      ? 'destructive'
      : 'scoped-write';
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
    const outer: StatementRisk = action === 'INSERT'
      ? 'append'
      : action === 'DELETE' || action === 'UPDATE'
        ? keywords.includes('WHERE') ? 'scoped-write' : 'bulk-write'
        : 'read';
    return worse(outer, nestedWriteRisk(words));
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

/**
 * 整张换掉已有的表：DuckDB、MariaDB、ClickHouse 的 `CREATE OR REPLACE [TEMP] TABLE`，ClickHouse 的
 * `REPLACE TABLE`。原表连同数据一起没了。换掉视图、函数不丢数据，`REPLACE INTO` 是插入
 */
function replacesTable(keywords: readonly string[]): boolean {
  const [first, ...rest] = keywords;
  const afterReplace = first === 'CREATE' && rest[0] === 'OR' && rest[1] === 'REPLACE'
    ? rest.slice(2)
    : first === 'REPLACE' ? rest : null;
  const object = afterReplace?.find((keyword) => keyword !== 'TEMP' && keyword !== 'TEMPORARY');
  return object === 'TABLE';
}

/**
 * PostgreSQL 的 CTE 本身就能写：`WITH gone AS (DELETE FROM t RETURNING *) SELECT …`。
 * 括号里那条写语句只受它自己括号里的 WHERE 限制。`FOR UPDATE` 是锁、
 * `ON CONFLICT DO UPDATE` 是插入的一部分，都不是另一条改写语句
 */
function nestedWriteRisk(words: readonly SqlWord[]): StatementRisk {
  return words.reduce<StatementRisk>((risk, word, index) => {
    if (word.group === 0) {
      return risk;
    }
    if (word.word === 'INSERT') {
      return worse(risk, 'append');
    }
    if (word.word === 'MERGE') {
      return worse(risk, 'bulk-write');
    }
    if (word.word !== 'DELETE' && word.word !== 'UPDATE') {
      return risk;
    }
    const previous = words.slice(0, index).reverse().find((other) => other.group === word.group);
    if (word.word === 'UPDATE' && ['FOR', 'KEY', 'DO'].includes(previous?.word ?? '')) {
      return risk;
    }
    const scoped = words
      .slice(index + 1)
      .some((other) => other.group === word.group && other.word === 'WHERE');
    return worse(risk, scoped ? 'scoped-write' : 'bulk-write');
  }, 'read');
}

function worse(left: StatementRisk, right: StatementRisk): StatementRisk {
  return RISK_ORDER.indexOf(right) > RISK_ORDER.indexOf(left) ? right : left;
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
  const [first, second, third, fourth] = topLevelKeywords(sql, dialect);
  const definesRoutine = (first === 'CREATE' || first === 'ALTER')
    && (ROUTINE_KINDS.has(second) || (second === 'OR' && ROUTINE_KINDS.has(fourth ?? third)));
  // 匿名块（BEGIN … END）此刻就执行，要看里面的每一条
  const parts = definesRoutine ? [sql] : splitSqlStatements(sql, dialect, { plsqlBlocks: false });
  return parts
    // 块开头的 `BEGIN`（T-SQL 还有 `BEGIN TRY`）不是语句本身：`BEGIN DELETE FROM t`
    // 按第一个词定级就成了带条件的写入
    .map((part) => classifyStatementRisk(part.replace(/^\s*(?:BEGIN(?:\s+(?:TRY|CATCH))?\b\s*)+/i, ''), dialect))
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
