type LexerState =
  | { type: 'normal' }
  | { type: 'single-quote' }
  | { type: 'double-quote' }
  | { type: 'backtick' }
  | { type: 'line-comment' }
  | { type: 'block-comment'; depth: number }
  | { type: 'dollar-quote'; tag: string };

const NORMAL_STATE: LexerState = { type: 'normal' };

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

export const isSelectStatement = (sql: string): boolean =>
  sql.trimStart().toLowerCase().startsWith('select');

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
