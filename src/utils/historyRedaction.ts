/**
 * 写进历史之前把 SQL 里的口令替换掉。
 *
 * 历史落在 localStorage 里，是一份**长期留存**的明文。查询结果从来不进历史
 * （那是另一半保证，见 `queryHistory.ts`），但 SQL 语句本身照抄就会把
 * `CREATE USER app IDENTIFIED BY 'hunter2'` 原样存下来——执行过一次的口令
 * 从此躺在磁盘上，比它本来该有的寿命长得多。
 *
 * 替换在**记录时**做，不在显示时做：存原文、显示时打码，秘密仍然在磁盘上，
 * 等于没做。
 *
 * 代价是被替换过的语句不能原样重跑。这是对的——拿 `'***'` 当口令去执行会
 * 干净地失败，而不是悄悄改成一个谁也不知道的值。
 */

export const REDACTED = "'***'";

export interface RedactedSql {
  sql: string;
  /** 有东西被替换过。界面据此说明「这条不能直接重跑」 */
  redacted: boolean;
}

/**
 * 口令出现在 SQL 里的三种形态，前两种都是「关键字之后紧跟的那个字符串字面量」。
 *
 * `IDENTIFIED WITH caching_sha2_password BY '…'`（MySQL 8）里插件名在中间，
 * 所以 `WITH` 后面允许跟一个标识符。
 */
const CREDENTIAL_KEYWORD =
  /\b(?:IDENTIFIED\s+(?:WITH\s+[\w$.]+\s+)?(?:BY|AS)|(?:UNENCRYPTED\s+|ENCRYPTED\s+)?PASSWORD)\s*=?\s*$/i;

/** `password = '…'`、`` `api_key` := '…' ``：按列名判断，列名可能被引号包着 */
const SECRET_COLUMN =
  /[`"'[]?\b(?:password|passwd|pwd|token|access_token|refresh_token|api_key|apikey|secret|private_key|credential|credentials)\b[`"'\]]?\s*(?::=|=)\s*$/i;

/** 字面量里塞了一整条连接串：`postgres://user:pw@host/db` */
const URL_CREDENTIAL = /([a-z][a-z0-9+.-]*:\/\/[^:/\s?#]+:)([^@\s/?#]*)(@)/gi;

interface Span {
  from: number;
  to: number;
}

/**
 * 扫出所有单引号字符串字面量的位置。
 *
 * 必须整条扫而不能直接 `/'[^']*'/` 去匹配：注释里的撇号（`-- don't`）会把
 * 后面所有字面量的边界整体错位一格，于是该打码的没打、不该动的被动了。
 *
 * 双引号与反引号包的是标识符（PostgreSQL 的 `"col"`、MySQL 的 `` `col` ``），
 * 跳过它们只是为了不把里面的撇号当成字符串开头。
 */
function scanStringLiterals(sql: string): Span[] {
  const literals: Span[] = [];
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];

    if (sql.startsWith('--', index) || character === '#') {
      const lineEnd = sql.indexOf('\n', index);
      index = lineEnd === -1 ? sql.length : lineEnd + 1;
      continue;
    }

    if (sql.startsWith('/*', index)) {
      const blockEnd = sql.indexOf('*/', index + 2);
      index = blockEnd === -1 ? sql.length : blockEnd + 2;
      continue;
    }

    // PostgreSQL 的 $$…$$ / $tag$…$tag$：函数体里什么都可能有，整段跳过，
    // 免得里面的撇号把外面的字面量边界带偏
    const dollarTag = matchDollarTag(sql, index);
    if (dollarTag) {
      const closing = sql.indexOf(dollarTag, index + dollarTag.length);
      index = closing === -1 ? sql.length : closing + dollarTag.length;
      continue;
    }

    if (character === '"' || character === '`') {
      index = skipQuoted(sql, index, character);
      continue;
    }

    if (character === "'") {
      const from = index;
      index = skipQuoted(sql, index, "'");
      literals.push({ from, to: index });
      continue;
    }

    index += 1;
  }

  return literals;
}

/**
 * 从开引号扫到闭引号之后。`''` 是转义的引号，`\'` 在 MySQL 下也是。
 *
 * 反斜杠按 MySQL 算而不按方言分：这里拿不到方言，而两边选错的代价不对称——
 * 按 MySQL 算，PostgreSQL 里以反斜杠结尾的字面量边界会偏（少见）；反过来
 * 按 PostgreSQL 算，MySQL 的 `'it\'s'` 会让**后面整条语句**的字面量全部错位，
 * 该打码的就打不中了。
 */
function skipQuoted(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === '\\' && quote === "'") {
      index += 2;
      continue;
    }
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

function matchDollarTag(sql: string, index: number): string | null {
  if (sql[index] !== '$') {
    return null;
  }
  const match = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.exec(sql.slice(index));
  return match ? match[0] : null;
}

/**
 * `INSERT INTO t (a, password, c) VALUES (1, 'x', 2)` —— 口令进表最常见的
 * 一条路。列名和值隔着老远，只看值本身完全判断不出它是什么。
 *
 * 按**位置**对应：列清单里第 n 个名字是敏感词，就打掉每组 VALUES 里第 n 个
 * 字面量。列数与值数对不上（写错了，或者值里有函数调用）时这一组整个放弃，
 * 宁可不打也不打错位置。
 */
function insertSecretLiterals(sql: string, literals: Span[]): Set<number> {
  const targets = new Set<number>();
  const header =
    /\binsert\s+(?:ignore\s+|low_priority\s+|delayed\s+|high_priority\s+)*into\s+[^(]+\(([^)]*)\)\s*values\s*/gi;

  for (let match = header.exec(sql); match; match = header.exec(sql)) {
    const columns = match[1]
      .split(',')
      .map((column) => column.trim().replace(/^[`"[]|[`"\]]$/g, ''));
    const secretIndices = columns
      .map((column, position) => (SECRET_COLUMN.test(`${column}=`) ? position : -1))
      .filter((position) => position >= 0);
    if (secretIndices.length === 0) {
      continue;
    }

    for (const items of valueTuples(sql, match.index + match[0].length)) {
      if (items.length !== columns.length) {
        // 列数与值数对不上，这条 INSERT 本来就跑不起来，位置对应无从谈起
        continue;
      }
      for (const secretIndex of secretIndices) {
        const literalIndex = literals.findIndex(
          (literal) => literal.from === items[secretIndex].from && literal.to === items[secretIndex].to
        );
        if (literalIndex >= 0) {
          targets.add(literalIndex);
        }
      }
    }
  }

  return targets;
}

/**
 * 从 `VALUES` 之后逐组读 `( … )`，每组按顶层逗号切成一项一项，遇到别的东西就停。
 *
 * 返回的是**每一项的位置**而不是项数：只数个数会在 `md5('x')` 这种地方栽——
 * 括号里恰好也有一个字面量，个数对得上，但那个字面量不是这一列的值。
 * 打掉它既泄了真正的口令又毁了语句。有了位置就能要求「这一项整个就是一个
 * 字面量」，表达式自然被排除在外。
 */
function valueTuples(sql: string, start: number): Span[][] {
  const tuples: Span[][] = [];
  let index = start;

  while (index < sql.length) {
    index = skipWhitespace(sql, index);
    if (sql[index] !== '(') {
      break;
    }

    const items: Span[] = [];
    let depth = 0;
    let itemStart = index + 1;
    while (index < sql.length) {
      const character = sql[index];
      if (character === "'" || character === '"' || character === '`') {
        index = skipQuoted(sql, index, character);
        continue;
      }
      if (character === '(') {
        depth += 1;
      } else if (character === ')') {
        depth -= 1;
        if (depth === 0) {
          items.push(trimmedSpan(sql, itemStart, index));
          index += 1;
          break;
        }
      } else if (character === ',' && depth === 1) {
        items.push(trimmedSpan(sql, itemStart, index));
        itemStart = index + 1;
      }
      index += 1;
    }
    tuples.push(items);

    index = skipWhitespace(sql, index);
    if (sql[index] !== ',') {
      break;
    }
    index += 1;
  }

  return tuples;
}

function skipWhitespace(sql: string, start: number): number {
  let index = start;
  while (index < sql.length && /\s/.test(sql[index])) {
    index += 1;
  }
  return index;
}

function trimmedSpan(sql: string, from: number, to: number): Span {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(sql[start])) {
    start += 1;
  }
  while (end > start && /\s/.test(sql[end - 1])) {
    end -= 1;
  }
  return { from: start, to: end };
}

export function redactSqlForHistory(sql: string): RedactedSql {
  const literals = scanStringLiterals(sql);
  const targets = insertSecretLiterals(sql, literals);

  literals.forEach((literal, index) => {
    // 关键字与列名都在字面量**之前**，所以看它前面那一段就够了。
    // 两个正则都锚在 `$`，中间只允许空白，`ORDER BY 'x'` 不会被误伤。
    // 只看前面 200 个字符：两个正则都锚在 `$` 且能匹配的前缀远短于此，
    // 每个字面量都从头切一次会把长脚本变成平方级
    const preceding = sql.slice(Math.max(0, literal.from - 200), literal.from);
    if (CREDENTIAL_KEYWORD.test(preceding) || SECRET_COLUMN.test(preceding)) {
      targets.add(index);
    }
  });

  let result = '';
  let cursor = 0;
  for (const index of [...targets].sort((a, b) => a - b)) {
    const literal = literals[index];
    result += sql.slice(cursor, literal.from) + REDACTED;
    cursor = literal.to;
  }
  result += sql.slice(cursor);

  const withoutUrlCredentials = result.replace(URL_CREDENTIAL, '$1***$3');
  return {
    sql: withoutUrlCredentials,
    redacted: targets.size > 0 || withoutUrlCredentials !== result
  };
}
