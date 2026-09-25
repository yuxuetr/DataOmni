import type { ConnectionEnvironment } from '../contracts';
import type { ConfirmationPolicy } from './confirmationPolicy';
import { cypherKeywords } from './cypherStatements';
import { RISK_ORDER, requiresConfirmation, type StatementRisk } from './statementRisk';
import type { TranslationKey } from '../i18n/translate';

/**
 * Cypher 这一条要不要先确认：等级沿用 SQL 那一套（`StatementRisk`），门槛也沿用
 * 「设置 → 危险语句确认」里按环境配的那一份。
 *
 * 判断分两步。第一步只看字：一个会写的词都没有的，一定是读，不必再问服务端。
 * 有的，再问服务端（`EXPLAIN` 给出的查询类型）——`CALL` 一个过程可能写也可能只读，
 * 字符串里出现 `DELETE` 并不删东西，只有服务端说得准。服务端说是读，就是读。
 */

/** 出现任何一个都「可能写」。`CALL` 在里面：过程可以写 */
const WRITE_WORDS: ReadonlySet<string> = new Set([
  'CREATE', 'MERGE', 'SET', 'DELETE', 'DETACH', 'REMOVE', 'DROP', 'ALTER', 'RENAME',
  'GRANT', 'DENY', 'REVOKE', 'CALL', 'FOREACH', 'LOAD', 'START', 'STOP', 'TERMINATE',
  'ENABLE', 'DEALLOCATE', 'REALLOCATE'
]);

/** 改权限、改用户：影响面不在数据里，按批量写对待 */
const SECURITY_WORDS: ReadonlySet<string> = new Set(['GRANT', 'DENY', 'REVOKE', 'ALTER', 'RENAME', 'USER', 'ROLE']);

export function cypherMayWrite(text: string): boolean {
  return cypherKeywords(text).some((word) => WRITE_WORDS.has(word));
}

/**
 * 服务端给的查询类型：`r` 读、`w` 写、`rw` 读写、`s` 改 schema；`null` 是没问到
 * （`EXPLAIN` 不支持的管理命令，或者问的时候出错）——按字面从严
 */
export type CypherQueryType = 'r' | 'w' | 'rw' | 's' | null;

export function classifyCypherRisk(text: string, queryType: CypherQueryType): StatementRisk {
  if (!cypherMayWrite(text) || queryType === 'r') {
    return 'read';
  }
  const words = new Set(cypherKeywords(text));
  if (words.has('DROP') || words.has('TERMINATE')) {
    return 'destructive';
  }
  // 删与摘标签的范围看不出来：`MATCH (n) DETACH DELETE n` 就清空整个库
  if (words.has('DELETE') || words.has('REMOVE') || [...SECURITY_WORDS].some((word) => words.has(word))) {
    return 'bulk-write';
  }
  if (words.has('SET')) {
    return 'scoped-write';
  }
  // 只建不改：建节点、建关系、建索引
  if ((words.has('CREATE') || words.has('MERGE')) && !words.has('CALL') && !words.has('FOREACH')) {
    return 'append';
  }
  return 'scoped-write';
}

/**
 * 确认框里风险那半句，只有和 SQL 说法不同的等级才列：SQL 的批量写说的是「没有 WHERE」，
 * Cypher 的批量写是删节点、关系或摘标签，删多少看匹配到多少
 */
export const CYPHER_RISK_DESCRIPTION_KEYS: Partial<Record<StatementRisk, TranslationKey>> = {
  'bulk-write': 'cypher.risk.bulkWrite'
};

/** 这一批里最该确认的那条；都不必确认时是 `null`。与 SQL 那边 `highestRiskNeedingConfirmation` 同一个规矩 */
export function riskiestCypherStatement(
  statements: ReadonlyArray<{ text: string; queryType: CypherQueryType }>,
  environment: ConnectionEnvironment,
  policy?: ConfirmationPolicy
): { text: string; risk: StatementRisk } | null {
  let worst: { text: string; risk: StatementRisk } | null = null;
  for (const { text, queryType } of statements) {
    const risk = classifyCypherRisk(text, queryType);
    if (requiresConfirmation(risk, environment, policy)
      && (!worst || RISK_ORDER.indexOf(risk) > RISK_ORDER.indexOf(worst.risk))) {
      worst = { text, risk };
    }
  }
  return worst;
}
