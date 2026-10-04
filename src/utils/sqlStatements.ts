import type { SqlDialect } from '../contracts/queryExecution';

type LexerState =
  | { type: 'normal' }
  | { type: 'bracket' }
  | { type: 'single-quote'; backslashEscapes: boolean }
  | { type: 'double-quote'; backslashEscapes: boolean }
  | { type: 'backtick'; backslashEscapes: boolean }
  | { type: 'line-comment' }
  | { type: 'block-comment'; depth: number }
  | { type: 'dollar-quote'; tag: string }
  | { type: 'q-quote'; terminator: string };

const NORMAL_STATE: LexerState = { type: 'normal' };

export interface SqlStatementRange {
  index: number;
  sql: string;
  from: number;
  to: number;
}

/**
 * 把一段脚本切成一条条语句。
 *
 * `dialect` 不给时按最宽的规则切（`#` 也算注释），给了就按那一家的写法：
 *
 * - `#` 只有 MySQL 与 ClickHouse 是注释。PostgreSQL 里它是按位异或，SQL Server 里 `#t` 是
 *   临时表——当成注释的话 `SELECT 1 INTO #t;` 那一行的分号就被吞了。
 * - SQL Server 与 SQLite 的 `[...]` 是标识符，里面的 `'` 与 `;` 不算数。
 * - 反斜杠只在 MySQL / ClickHouse 的引号里、PostgreSQL 的 `E'…'` 里是转义。别处 `'C:\'`
 *   就是一个完整的字面量，当成转义的话后面整段脚本都被吞进字符串，切成一条发出去。
 * - SQL Server 的脚本常用单独一行的 `GO` 分批（SSMS 的约定，不是 T-SQL 语法）。
 *   脚本里只要有一行 `GO`，就**只按 GO 切**：`CREATE PROCEDURE` 的过程体里
 *   满是分号，按分号切会把一个过程切成几段发出去。`GO 5` 这种带次数的不认——
 *   它要把这一批跑五遍，当成普通分隔符等于悄悄少跑四遍；留在批里让服务端报错。
 *   没有 GO 时，`CREATE PROCEDURE` / `FUNCTION` / `TRIGGER` 到脚本末尾为止——T-SQL 的过程体
 *   本来就到批的末尾，没有 GO 整段就是一批；之前的语句照旧按分号切。
 * - SQLite 的 `CREATE TRIGGER … BEGIN … END`、PostgreSQL 的 `BEGIN ATOMIC … END` 里的分号不切。
 * - Oracle 的 `q'[…]'` 里的引号与分号都是字面量。
 * - Oracle 照 SQL*Plus 的约定：PL/SQL 块（`BEGIN`、`DECLARE`、`CREATE … PROCEDURE`
 *   这一类）里的分号不切，块一直到单独一行的 `/` 为止，没有 `/` 就到脚本末尾。
 *   `plsqlBlocks: false` 关掉这一条——风险判定要看块里面的每一条语句。
 */
export const splitSqlStatements = (
  sqlText: string,
  dialect?: SqlDialect,
  options: { plsqlBlocks?: boolean } = {}
): string[] => {
  const blocks = dialect === 'oracle' && options.plsqlBlocks !== false;
  const byLine = scanStatements(sqlText, dialect, true, blocks);
  return byLine.sawBatchSeparator
    ? scanStatements(sqlText, dialect, false, blocks).statements
    : byLine.statements;
};

/**
 * `--` 是不是行注释。MySQL 要求后面跟空白或控制字符（或已到末尾）：`5--x` 是 5 减负 x，
 * 当成注释会吞掉同一行后面的分号。别家的 `--` 后面是什么都算
 */
function startsDashComment(sqlText: string, index: number, dialect?: SqlDialect): boolean {
  if (!sqlText.startsWith('--', index)) return false;
  if (dialect !== 'mysql') return true;
  const next = sqlText.charCodeAt(index + 2);
  return Number.isNaN(next) || next <= 0x20;
}

/** 单独一行的 `/`：SQL*Plus 里执行缓冲区、结束 PL/SQL 块的那一行 */
function matchSlashLine(sqlText: string, index: number): number | null {
  if (index > 0 && sqlText[index - 1] !== '\n' && sqlText[index - 1] !== '\r') {
    return null;
  }
  const match = sqlText.slice(index).match(/^[\t ]*\/[\t ]*(?:\r\n|\r|\n|$)/);
  return match ? index + match[0].length : null;
}

/**
 * 语句体里带分号、靠 `BEGIN … END` 收尾的：SQLite 的触发器、PostgreSQL 14 起的 `BEGIN ATOMIC`
 * 函数与过程体。只在这两种语句里数 BEGIN / CASE 与 END——单独的 `BEGIN;` 是开事务，照旧切
 */
const BODY_STATEMENT_START: Partial<Record<SqlDialect, RegExp>> = {
  sqlite: /^\s*CREATE\s+(?:(?:TEMP|TEMPORARY)\s+)?TRIGGER\b/i,
  postgresql: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i
};

/** T-SQL 里这几种定义的体到批的末尾为止（批里只能有它一条），没有 GO 就到脚本末尾 */
const SQL_SERVER_ROUTINE_START = /^\s*(?:CREATE\s+(?:OR\s+ALTER\s+)?|ALTER\s+)(?:PROC|PROCEDURE|FUNCTION|TRIGGER)\b/i;

const PLSQL_BLOCK_START = /^\s*(?:BEGIN|DECLARE|CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE))\b/i;

/** 单独一行的 `GO`，前后可以有空白，后面可以跟行注释 */
function matchBatchSeparator(sqlText: string, index: number): number | null {
  if (index > 0 && sqlText[index - 1] !== '\n' && sqlText[index - 1] !== '\r') {
    return null;
  }
  const match = sqlText.slice(index).match(/^[\t ]*go[\t ]*(?:--[^\r\n]*)?(?:\r\n|\r|\n|$)/i);
  return match ? index + match[0].length : null;
}

function scanStatements(
  sqlText: string,
  dialect: SqlDialect | undefined,
  splitOnDelimiter: boolean,
  plsqlBlocks: boolean
): { statements: string[]; sawBatchSeparator: boolean } {
  let inBlock = false;
  const bodyStart = dialect ? BODY_STATEMENT_START[dialect] : undefined;
  let countsBody = false;
  let bodyDepth = 0;
  const statements: string[] = [];
  let buffer = '';
  let delimiter = ';';
  let state: LexerState = NORMAL_STATE;
  let index = 0;
  let sawBatchSeparator = false;
  const hashComments = dialect === undefined || dialect === 'mysql' || dialect === 'clickhouse';
  const backslashEscapes = hashComments;
  // 这一段里有没有注释以外的东西。只有注释的一段（脚本末尾的 `-- end`）不是语句：
  // 发给 Oracle 是 ORA-00900
  let hasCode = false;

  const flush = () => {
    const statement = buffer.trim();
    if (statement && hasCode) {
      statements.push(statement);
    }
    buffer = '';
    hasCode = false;
    countsBody = false;
    bodyDepth = 0;
  };

  while (index < sqlText.length) {
    if (state.type === 'normal') {
      const delimiterDirective = matchDelimiterDirective(sqlText, index);
      if (delimiterDirective) {
        flush();
        delimiter = delimiterDirective.delimiter;
        index = delimiterDirective.endIndex;
        continue;
      }

      if (dialect === 'sqlserver') {
        const separatorEnd = matchBatchSeparator(sqlText, index);
        if (separatorEnd !== null) {
          flush();
          sawBatchSeparator = true;
          index = separatorEnd;
          continue;
        }
      }

      if (plsqlBlocks) {
        const slashEnd = matchSlashLine(sqlText, index);
        if (slashEnd !== null) {
          flush();
          inBlock = false;
          index = slashEnd;
          continue;
        }
        if (!inBlock && buffer.trim() === '' && PLSQL_BLOCK_START.test(sqlText.slice(index, index + 120))) {
          inBlock = true;
        }
      }

      if (dialect === 'sqlserver' && !inBlock && buffer.trim() === ''
        && SQL_SERVER_ROUTINE_START.test(sqlText.slice(index, index + 60))) {
        inBlock = true;
      }

      if (bodyStart && !countsBody && buffer.trim() === '' && bodyStart.test(sqlText.slice(index, index + 60))) {
        countsBody = true;
      }
      if (countsBody && /[A-Za-z_]/.test(sqlText[index]) && !/[\w$]/.test(sqlText[index - 1] ?? '')) {
        const word = sqlText.slice(index).match(/^[A-Za-z_][\w$]*/)?.[0] ?? sqlText[index];
        const upper = word.toUpperCase();
        if (upper === 'BEGIN' || upper === 'CASE') {
          bodyDepth += 1;
        } else if (upper === 'END') {
          bodyDepth = Math.max(0, bodyDepth - 1);
        }
        buffer += word;
        hasCode = true;
        index += word.length;
        continue;
      }

      if (splitOnDelimiter && !inBlock && bodyDepth === 0 && sqlText.startsWith(delimiter, index)) {
        flush();
        index += delimiter.length;
        continue;
      }

      const qQuote = dialect === 'oracle' ? matchOracleQQuote(sqlText, index) : null;
      if (qQuote) {
        buffer += qQuote.opening;
        hasCode = true;
        state = { type: 'q-quote', terminator: qQuote.terminator };
        index += qQuote.opening.length;
        continue;
      }

      const dollarQuoteTag = matchDollarQuoteTag(sqlText, index);
      if (dollarQuoteTag) {
        buffer += dollarQuoteTag;
        hasCode = true;
        state = { type: 'dollar-quote', tag: dollarQuoteTag };
        index += dollarQuoteTag.length;
        continue;
      }

      if (startsDashComment(sqlText, index, dialect) || (hashComments && sqlText[index] === '#')) {
        const markerLength = sqlText[index] === '#' ? 1 : 2;
        buffer += sqlText.slice(index, index + markerLength);
        state = { type: 'line-comment' };
        index += markerLength;
        continue;
      }

      if (sqlText.startsWith('/*', index)) {
        // MySQL 的 `/*! … */` 是给服务端执行的（mysqldump 的 `/*!40101 SET … */`），不是注释
        if (hashComments && sqlText[index + 2] === '!') {
          hasCode = true;
        }
        buffer += '/*';
        state = { type: 'block-comment', depth: 1 };
        index += 2;
        continue;
      }

      const character = sqlText[index];
      buffer += character;
      if (!/\s/.test(character)) {
        hasCode = true;
      }
      if (character === "'") {
        state = {
          type: 'single-quote',
          backslashEscapes: backslashEscapes || (dialect === 'postgresql' && isEscapeStringPrefix(sqlText, index))
        };
      } else if (character === '"') {
        state = { type: 'double-quote', backslashEscapes };
      } else if (character === '`') {
        state = { type: 'backtick', backslashEscapes };
      } else if (character === '[' && (dialect === 'sqlserver' || dialect === 'sqlite')) {
        // SQLite 为兼容 Access / SQL Server 也认 `[名字]`；它没有数组，`[` 只会是这个
        state = { type: 'bracket' };
      }
      index += 1;
      continue;
    }

    if (state.type === 'bracket') {
      const character = sqlText[index];
      buffer += character;
      index += 1;
      if (character === ']') {
        // `]]` 是转义过的右方括号，标识符还没完
        if (sqlText[index] === ']') {
          buffer += ']';
          index += 1;
        } else {
          state = NORMAL_STATE;
        }
      }
      continue;
    }

    if (state.type === 'dollar-quote' || state.type === 'q-quote') {
      const closing = state.type === 'dollar-quote' ? state.tag : state.terminator;
      if (sqlText.startsWith(closing, index)) {
        buffer += closing;
        index += closing.length;
        state = NORMAL_STATE;
      } else {
        buffer += sqlText[index];
        index += 1;
      }
      continue;
    }

    if (state.type === 'line-comment') {
      const character = sqlText[index];
      buffer += character;
      index += 1;
      if (character === '\n' || character === '\r') {
        state = NORMAL_STATE;
      }
      continue;
    }

    if (state.type === 'block-comment') {
      if (sqlText.startsWith('/*', index)) {
        buffer += '/*';
        state = { type: 'block-comment', depth: state.depth + 1 };
        index += 2;
      } else if (sqlText.startsWith('*/', index)) {
        buffer += '*/';
        index += 2;
        state = state.depth === 1
          ? NORMAL_STATE
          : { type: 'block-comment', depth: state.depth - 1 };
      } else {
        buffer += sqlText[index];
        index += 1;
      }
      continue;
    }

    const quote = state.type === 'single-quote'
      ? "'"
      : state.type === 'double-quote'
        ? '"'
        : '`';
    const character = sqlText[index];
    buffer += character;
    index += 1;

    if (state.backslashEscapes && character === '\\' && index < sqlText.length) {
      buffer += sqlText[index];
      index += 1;
      continue;
    }

    if (character === quote) {
      if (sqlText[index] === quote) {
        buffer += sqlText[index];
        index += 1;
      } else {
        state = NORMAL_STATE;
      }
    }
  }

  flush();
  return { statements, sawBatchSeparator };
}

export const getSqlStatementRanges = (
  sqlText: string,
  dialect?: SqlDialect
): SqlStatementRange[] => {
  const statements = splitSqlStatements(sqlText, dialect);
  let searchFrom = 0;

  return statements.flatMap((statement, index) => {
    const from = sqlText.indexOf(statement, searchFrom);
    if (from === -1) {
      return [];
    }

    const to = from + statement.length;
    searchFrom = to;
    return [{ index, sql: statement, from, to }];
  });
};

export const findSqlStatementAtOffset = (
  sqlText: string,
  offset: number,
  dialect?: SqlDialect
): SqlStatementRange | undefined => {
  const ranges = getSqlStatementRanges(sqlText, dialect);
  const boundedOffset = Math.max(0, Math.min(offset, sqlText.length));
  const containing = ranges.find(
    (statement) => boundedOffset >= statement.from && boundedOffset <= statement.to
  );
  if (containing) {
    return containing;
  }

  return ranges.reduce<SqlStatementRange | undefined>((nearest, statement) => {
    if (!nearest) {
      return statement;
    }

    const nearestDistance = Math.min(
      Math.abs(boundedOffset - nearest.from),
      Math.abs(boundedOffset - nearest.to)
    );
    const statementDistance = Math.min(
      Math.abs(boundedOffset - statement.from),
      Math.abs(boundedOffset - statement.to)
    );
    return statementDistance < nearestDistance ? statement : nearest;
  }, undefined);
};

export const isSelectStatement = (sql: string): boolean =>
  firstTopLevelKeyword(sql) === 'SELECT';

export const returnsResultSet = (sql: string): boolean => {
  const keywords = topLevelKeywords(sql);
  const firstKeyword = keywords[0];

  if (!firstKeyword) {
    return false;
  }

  if (['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'PRAGMA', 'VALUES', 'TABLE'].includes(firstKeyword)) {
    return true;
  }

  if (firstKeyword === 'WITH') {
    const statementKeyword = keywords.find((keyword) =>
      ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(keyword)
    );

    return statementKeyword === 'SELECT'
      || (statementKeyword !== undefined && keywords.includes('RETURNING'));
  }

  return ['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(firstKeyword)
    && keywords.includes('RETURNING');
};

const Q_QUOTE_CLOSERS: Record<string, string> = { '[': ']', '{': '}', '(': ')', '<': '>' };

/**
 * Oracle 的 `q'[…]'`（前面可以有 `n`）：里面的单引号不用双写，到配对的右括号加 `'`
 * 为止；不是括号的定界符就到同一个字符加 `'`
 */
function matchOracleQQuote(sqlText: string, index: number): { opening: string; terminator: string } | null {
  if (/[\w$#]/.test(sqlText[index - 1] ?? '')) {
    return null;
  }
  const match = sqlText.slice(index, index + 4).match(/^[nN]?[qQ]'([^\s])/);
  if (!match) {
    return null;
  }
  const delimiter = match[1];
  return { opening: match[0], terminator: `${Q_QUOTE_CLOSERS[delimiter] ?? delimiter}'` };
}

/** 引号前面是一个独立的 `E` / `e`：PostgreSQL 的转义字符串，前面再连着字母数字就是标识符的一部分 */
function isEscapeStringPrefix(sqlText: string, quoteIndex: number): boolean {
  return /[eE]/.test(sqlText[quoteIndex - 1] ?? '') && !/[\w$]/.test(sqlText[quoteIndex - 2] ?? '');
}

function matchDollarQuoteTag(sqlText: string, index: number): string | null {
  if (sqlText[index] !== '$') {
    return null;
  }

  const match = sqlText.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
  return match?.[0] ?? null;
}

function matchDelimiterDirective(
  sqlText: string,
  index: number
): { delimiter: string; endIndex: number } | null {
  if (index > 0 && sqlText[index - 1] !== '\n' && sqlText[index - 1] !== '\r') {
    return null;
  }

  const match = sqlText
    .slice(index)
    .match(/^[\t ]*delimiter[\t ]+(\S+)[^\r\n]*(?:\r\n|\r|\n|$)/i);
  if (!match) {
    return null;
  }

  return {
    delimiter: match[1],
    endIndex: index + match[0].length
  };
}

function firstTopLevelKeyword(sql: string): string | undefined {
  return topLevelKeywords(sql)[0];
}

/**
 * 语句里处在顶层（不在括号、字符串、注释内）的标识符，全部大写。
 *
 * 导出给风险判定用：识别「DELETE 有没有带 WHERE」需要的正是这种既跳过字符串
 * 和注释、又不把子查询里的词算进来的扫描。再写一个更弱的分词器是重复。
 */
export function topLevelKeywords(sql: string): string[] {
  return sqlWords(sql).filter((word) => word.group === 0).map((word) => word.word);
}

/** 一个标识符（大写），和它所在的那对括号：`group` 0 是顶层，每对括号各一个编号 */
export interface SqlWord {
  word: string;
  group: number;
}

/**
 * 语句里不在字符串、注释内的全部标识符，带上各自所在的括号。
 *
 * 风险判定要看括号里的语句：PostgreSQL 的 `WITH gone AS (DELETE …) SELECT …`
 * 在顶层只看得到 SELECT，而那条 DELETE 的 WHERE 只在同一对括号里才限制它
 */
export function sqlWords(sql: string): SqlWord[] {
  const keywords: SqlWord[] = [];
  let state: LexerState = NORMAL_STATE;
  const groups: number[] = [0];
  let opened = 0;
  let index = 0;

  while (index < sql.length) {
    if (state.type === 'normal') {
      const dollarQuoteTag = matchDollarQuoteTag(sql, index);
      if (dollarQuoteTag) {
        state = { type: 'dollar-quote', tag: dollarQuoteTag };
        index += dollarQuoteTag.length;
        continue;
      }

      if (sql.startsWith('--', index) || sql[index] === '#') {
        state = { type: 'line-comment' };
        index += sql[index] === '#' ? 1 : 2;
        continue;
      }

      if (sql.startsWith('/*', index)) {
        state = { type: 'block-comment', depth: 1 };
        index += 2;
        continue;
      }

      const character = sql[index];
      // 方括号里的东西不是关键字：`DELETE FROM [where]` 删的是整张表。
      // 别家的 `[` 是数组下标，里面同样不会有顶层关键字
      if (character === '[') {
        state = { type: 'bracket' };
        index += 1;
        continue;
      }
      if (character === "'" || character === '"' || character === '`') {
        // 不知道方言，反斜杠一律当转义：认错了只会把后面的 WHERE 藏起来，判定往更危险那边偏
        state = character === "'"
          ? { type: 'single-quote', backslashEscapes: true }
          : character === '"'
            ? { type: 'double-quote', backslashEscapes: true }
            : { type: 'backtick', backslashEscapes: true };
        index += 1;
        continue;
      }

      if (character === '(') {
        opened += 1;
        groups.push(opened);
        index += 1;
        continue;
      }

      if (character === ')') {
        if (groups.length > 1) {
          groups.pop();
        }
        index += 1;
        continue;
      }

      if (/[A-Za-z_]/.test(character)) {
        const match = sql.slice(index).match(/^[A-Za-z_][A-Za-z0-9_$]*/);
        if (match) {
          keywords.push({ word: match[0].toUpperCase(), group: groups[groups.length - 1] });
          index += match[0].length;
          continue;
        }
      }

      index += 1;
      continue;
    }

    if (state.type === 'dollar-quote') {
      if (sql.startsWith(state.tag, index)) {
        index += state.tag.length;
        state = NORMAL_STATE;
      } else {
        index += 1;
      }
      continue;
    }

    if (state.type === 'bracket') {
      if (sql[index] === ']' && sql[index + 1] === ']') {
        index += 2;
      } else {
        if (sql[index] === ']') {
          state = NORMAL_STATE;
        }
        index += 1;
      }
      continue;
    }

    if (state.type === 'line-comment') {
      if (sql[index] === '\n' || sql[index] === '\r') {
        state = NORMAL_STATE;
      }
      index += 1;
      continue;
    }

    if (state.type === 'block-comment') {
      if (sql.startsWith('/*', index)) {
        state = { type: 'block-comment', depth: state.depth + 1 };
        index += 2;
      } else if (sql.startsWith('*/', index)) {
        index += 2;
        state = state.depth === 1
          ? NORMAL_STATE
          : { type: 'block-comment', depth: state.depth - 1 };
      } else {
        index += 1;
      }
      continue;
    }

    const quote = state.type === 'single-quote'
      ? "'"
      : state.type === 'double-quote'
        ? '"'
        : '`';
    const character = sql[index];
    index += 1;

    if (character === '\\') {
      index += 1;
    } else if (character === quote) {
      if (sql[index] === quote) {
        index += 1;
      } else {
        state = NORMAL_STATE;
      }
    }
  }

  return keywords;
}
