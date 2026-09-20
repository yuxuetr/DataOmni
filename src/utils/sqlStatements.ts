type LexerState =
  | { type: 'normal' }
  | { type: 'single-quote' }
  | { type: 'double-quote' }
  | { type: 'backtick' }
  | { type: 'line-comment' }
  | { type: 'block-comment'; depth: number }
  | { type: 'dollar-quote'; tag: string };

const NORMAL_STATE: LexerState = { type: 'normal' };

export interface SqlStatementRange {
  index: number;
  sql: string;
  from: number;
  to: number;
}

export const splitSqlStatements = (sqlText: string): string[] => {
  const statements: string[] = [];
  let buffer = '';
  let delimiter = ';';
  let state: LexerState = NORMAL_STATE;
  let index = 0;

  const flush = () => {
    const statement = buffer.trim();
    if (statement) {
      statements.push(statement);
    }
    buffer = '';
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

      if (sqlText.startsWith(delimiter, index)) {
        flush();
        index += delimiter.length;
        continue;
      }

      const dollarQuoteTag = matchDollarQuoteTag(sqlText, index);
      if (dollarQuoteTag) {
        buffer += dollarQuoteTag;
        state = { type: 'dollar-quote', tag: dollarQuoteTag };
        index += dollarQuoteTag.length;
        continue;
      }

      if (sqlText.startsWith('--', index) || sqlText[index] === '#') {
        const markerLength = sqlText[index] === '#' ? 1 : 2;
        buffer += sqlText.slice(index, index + markerLength);
        state = { type: 'line-comment' };
        index += markerLength;
        continue;
      }

      if (sqlText.startsWith('/*', index)) {
        buffer += '/*';
        state = { type: 'block-comment', depth: 1 };
        index += 2;
        continue;
      }

      const character = sqlText[index];
      buffer += character;
      if (character === "'") {
        state = { type: 'single-quote' };
      } else if (character === '"') {
        state = { type: 'double-quote' };
      } else if (character === '`') {
        state = { type: 'backtick' };
      }
      index += 1;
      continue;
    }

    if (state.type === 'dollar-quote') {
      if (sqlText.startsWith(state.tag, index)) {
        buffer += state.tag;
        index += state.tag.length;
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

    if (character === '\\' && index < sqlText.length) {
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
  return statements;
};

export const getSqlStatementRanges = (sqlText: string): SqlStatementRange[] => {
  const statements = splitSqlStatements(sqlText);
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
  offset: number
): SqlStatementRange | undefined => {
  const ranges = getSqlStatementRanges(sqlText);
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
  const keywords: string[] = [];
  let state: LexerState = NORMAL_STATE;
  let depth = 0;
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
      if (character === "'" || character === '"' || character === '`') {
        state = character === "'"
          ? { type: 'single-quote' }
          : character === '"'
            ? { type: 'double-quote' }
            : { type: 'backtick' };
        index += 1;
        continue;
      }

      if (character === '(') {
        depth += 1;
        index += 1;
        continue;
      }

      if (character === ')') {
        depth = Math.max(0, depth - 1);
        index += 1;
        continue;
      }

      if (depth === 0 && /[A-Za-z_]/.test(character)) {
        const match = sql.slice(index).match(/^[A-Za-z_][A-Za-z0-9_$]*/);
        if (match) {
          keywords.push(match[0].toUpperCase());
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
