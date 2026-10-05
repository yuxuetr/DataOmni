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

import type { SqlDialect } from '../contracts/queryExecution';

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
 * 所以 `WITH` 后面允许跟一个标识符。`PASSWORD` 前面可以带前缀：SQL Server 改口令时的
 * `OLD_PASSWORD`、MySQL 复制源的 `SOURCE_PASSWORD` / `MASTER_PASSWORD`。
 * MySQL 改口令时 `REPLACE '…'` 给的是旧口令。`SET PASSWORD FOR 'u'@'h' = '…'` 里用户名隔在
 * `PASSWORD` 与等号之间，单列一支
 */
const MYSQL_SET_PASSWORD = String.raw`SET\s+PASSWORD(?:\s+FOR\s+[^=;]+?)?\s*=`;
const CREDENTIAL_KEYWORD = new RegExp(
  String.raw`\b(?:IDENTIFIED\s+(?:WITH\s+[\w$.]+\s+)?(?:BY|AS)|(?:UNENCRYPTED\s+|ENCRYPTED\s+)?(?:\w+_)?PASSWORD`
    + String.raw`|${MYSQL_SET_PASSWORD}`
    + String.raw`|(?:IDENTIFIED\s+(?:WITH\s+[\w$.]+\s+)?BY|${MYSQL_SET_PASSWORD})\s*'(?:[^'\\]|\\.|'')*'\s+REPLACE)\s*=?\s*$`,
  'i'
);

/** `password = '…'`、`` `api_key` := '…' ``、`user_password = '…'`：按列名判断，列名可能被引号包着 */
const SECRET_COLUMN =
  /[`"'[]?\b(?:\w+_)?(?:password|passwd|pwd|token|access_token|refresh_token|api_key|apikey|secret|secret_access_key|secret_key|account_key|private_key|connection_string|credential|credentials)\b[`"'\]]?\s*(?::=|=)\s*$/i;

/**
 * 选项清单里名字与值之间只隔空白的：DuckDB 的 `CREATE SECRET (TYPE s3, SECRET '…', BEARER_TOKEN '…')`。
 * 要求前面是 `(` 或 `,`，免得 `SELECT 'x' AS secret, 'y'` 这种也被打
 */
const SECRET_OPTION =
  /[(,]\s*(?:\w+_)?(?:secret|token|account_key|secret_access_key|connection_string)\s+$/i;

/**
 * 字面量里塞了一整条连接串：`postgres://user:pw@host/db`。
 *
 * 开头的后顾不能省：没有它，一长串字母里的每个位置都会被当成协议名的开头、
 * 往后扫到串尾才失败，是平方级——mysqldump 的扩展 INSERT 一条 1MB，
 * 记一次历史要十分钟，界面跟着卡死
 */
const URL_CREDENTIAL = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^:/\s?#]+:)([^@\s/?#]*)(@)/gi;

/**
 * 紧贴在开引号前面、属于字面量本身的前缀：SQL Server 的 `N'…'`、PostgreSQL 的 `E'…'`、
 * MySQL 的字符集引导 `_utf8mb4'…'`。不去掉的话 `PASSWORD = N'…'` 前面那段以 `N` 结尾，
 * 锚在 `$` 的关键字正则对不上，口令原样进历史。前面要是词的边界：`WHEN'x'` 的 N 不是前缀
 */
const LITERAL_PREFIX = /(?<![\w$])(?:[NnEe]|_[A-Za-z0-9]+)$/;

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
function scanStringLiterals(sql: string, dialect: SqlDialect): Span[] {
  const literals: Span[] = [];
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];

    // `#` 只在 MySQL 与 ClickHouse 里是注释。SQL Server 的临时表就叫 `#tmp`，当成注释会把
    // 同一行后面的字面量整个跳过
    if (sql.startsWith('--', index) || (character === '#' && (dialect === 'mysql' || dialect === 'clickhouse'))) {
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
      index = skipQuoted(sql, index, character, false);
      continue;
    }

    if (character === "'") {
      const from = index;
      index = skipQuoted(sql, index, "'", backslashEscapes(sql, index, dialect));
      literals.push({ from, to: index });
      continue;
    }

    index += 1;
  }

  return literals;
}

/**
 * `start` 处的单引号字面量里反斜杠是不是转义符。
 *
 * MySQL 与 ClickHouse 默认如此；PostgreSQL 与 DuckDB 只在 `E'…'` 里才是，其余几家从来不是。
 * 认错一边，字面量边界就错位：PostgreSQL 的 `'C:\'` 按 MySQL 算会一路吞到下一个
 * 字面量的开引号，后面的口令落到「字面量外面」而漏打；反过来 MySQL 的 `'it\'s'`
 * 按标准算也一样
 */
function backslashEscapes(sql: string, start: number, dialect: SqlDialect): boolean {
  if (dialect === 'mysql' || dialect === 'clickhouse') {
    return true;
  }
  return (dialect === 'postgresql' || dialect === 'duckdb')
    && /[eE]/.test(sql[start - 1] ?? '')
    && !/[\w$]/.test(sql[start - 2] ?? '');
}

/** 从开引号扫到闭引号之后。`''` 是转义的引号，`backslash` 时 `\'` 也是 */
function skipQuoted(sql: string, start: number, quote: string, backslash: boolean): number {
  let index = start + 1;
  while (index < sql.length) {
    if (backslash && sql[index] === '\\') {
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
function insertSecretLiterals(sql: string, literals: Span[], dialect: SqlDialect): Set<number> {
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

    for (const items of valueTuples(sql, match.index + match[0].length, dialect)) {
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
function valueTuples(sql: string, start: number, dialect: SqlDialect): Span[][] {
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
        index = skipQuoted(sql, index, character, character === "'" && backslashEscapes(sql, index, dialect));
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

export function redactSqlForHistory(sql: string, dialect: SqlDialect): RedactedSql {
  const literals = scanStringLiterals(sql, dialect);
  const targets = insertSecretLiterals(sql, literals, dialect);

  literals.forEach((literal, index) => {
    // 关键字与列名都在字面量**之前**，所以看它前面那一段就够了。
    // 两个正则都锚在 `$`，中间只允许空白，`ORDER BY 'x'` 不会被误伤。
    // 只看前面 200 个字符：两个正则都锚在 `$` 且能匹配的前缀远短于此，
    // 每个字面量都从头切一次会把长脚本变成平方级
    const preceding = sql
      .slice(Math.max(0, literal.from - 200), literal.from)
      .replace(LITERAL_PREFIX, '');
    if (CREDENTIAL_KEYWORD.test(preceding) || SECRET_COLUMN.test(preceding) || SECRET_OPTION.test(preceding)) {
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

  const withoutIdentifiers = dialect === 'oracle' ? result.replace(ORACLE_IDENTIFIED_BY, oracleRedaction) : result;
  const withoutUrlCredentials = withoutIdentifiers.replace(URL_CREDENTIAL, '$1***$3');
  return {
    sql: withoutUrlCredentials,
    redacted: targets.size > 0 || withoutUrlCredentials !== result
  };
}

/**
 * Oracle 的口令是标识符，不是字符串：`IDENTIFIED BY tiger`、`IDENTIFIED BY "N3w#pw" REPLACE "0ld#pw"`，
 * 建库链接的 `CONNECT TO u IDENTIFIED BY pw` 也是。上面按字面量找的那一路看不见它们。
 * `IDENTIFIED BY VALUES '…'` 给的是散列，是字面量，归上面那一路
 */
const ORACLE_PASSWORD = '"(?:[^"]|"")*"|[A-Za-z0-9_$#]+';
const ORACLE_IDENTIFIED_BY = new RegExp(
  `(\\bIDENTIFIED\\s+BY\\s+)(?!VALUES\\b)(?:${ORACLE_PASSWORD})(?:(\\s+REPLACE\\s+)(?:${ORACLE_PASSWORD}))?`,
  'gi'
);

function oracleRedaction(_match: string, identifiedBy: string, replace: string | undefined): string {
  return `${identifiedBy}${REDACTED}${replace === undefined ? '' : `${replace}${REDACTED}`}`;
}

/** 控制台那几种语言：Cypher、Elasticsearch 的请求、Redis 的命令、MongoDB 的命令文档 */
export type ConsoleLanguage = 'cypher' | 'elasticsearch' | 'redis' | 'mongodb';

/** 名字里带着这些词的键、属性、参数，值就当口令 */
const SECRET_WORDS = '[\\w.-]*?(?:password|passwd|pwd|secret|token|api_?key|private_key|credentials?)';
/** Cypher 的字符串：单双引号都行，反斜杠转义 */
const CYPHER_STRING = `'(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*"`;
const JSON_STRING = '"(?:[^"\\\\]|\\\\.)*"';

function replaceAll(text: string, pattern: RegExp, replacer: (...groups: string[]) => string): string {
  return text.replace(pattern, (...match) => replacer(...(match.slice(0, -2) as string[])));
}

/**
 * `CREATE USER x SET PASSWORD 'pw'`、`ALTER CURRENT USER SET PASSWORD FROM 'old' TO 'new'`，
 * 以及按属性名的 `{password: 'x'}` 与 `n.api_key = 'x'`
 */
function redactCypher(text: string): string {
  // 改自己的口令要写旧的和新的，两个都打；先打这一种，免得下一条只打掉 FROM 后面那个
  let result = replaceAll(
    text,
    new RegExp(`(\\bPASSWORD\\s+FROM\\s+)(?:${CYPHER_STRING})(\\s+TO\\s+)(?:${CYPHER_STRING})`, 'gi'),
    (_, from, to) => `${from}${REDACTED}${to}${REDACTED}`
  );
  result = replaceAll(result, new RegExp(`(\\bPASSWORD\\s+)(?:${CYPHER_STRING})`, 'gi'), (_, keyword) => `${keyword}${REDACTED}`);
  return replaceAll(
    result,
    new RegExp(`((?:[{,]\\s*|\\.)${SECRET_WORDS}\\s*(?::|=)\\s*)(?:${CYPHER_STRING})`, 'gi'),
    (_, prefix) => `${prefix}${REDACTED}`
  );
}

/** MongoDB 的命令文档按键名：`createUser` 的 `pwd: '…'`，键带不带引号都认 */
function redactMongoCommand(text: string): string {
  return replaceAll(
    text,
    new RegExp(`([{,]\\s*["']?${SECRET_WORDS}["']?\\s*:\\s*)(?:${CYPHER_STRING})`, 'gi'),
    (_, prefix) => `${prefix}${REDACTED}`
  );
}

/** 请求体里按键名：`"password": "…"`；路径的查询串里按参数名 */
function redactEsRequest(text: string): string {
  const body = replaceAll(text, new RegExp(`("${SECRET_WORDS}"\\s*:\\s*)(${JSON_STRING})`, 'gi'), (_, prefix) => `${prefix}"***"`);
  return replaceAll(body, new RegExp(`([?&]${SECRET_WORDS}=)([^&\\s]*)`, 'gi'), (_, prefix) => `${prefix}***`);
}

/**
 * redis-cli 写法的一行：`AUTH [user] pass`、`HELLO 3 AUTH user pass`、`MIGRATE … AUTH pass` /
 * `AUTH2 user pass`、`CONFIG SET requirepass x`、`ACL SETUSER u >pass <pass`。
 * 按参数打码（参数可以带引号），不按正则套整行
 */
function redactRedisCommand(text: string): string {
  // 和 redis-cli 一样，引号在参数中间也开始引用（`>"my pass"` 是一个参数）；
  // 没收尾的引号当普通字符，免得把它连同后面的口令跳过去
  const tokens = [...text.matchAll(/(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"']|["'])+/g)].map((match) => ({
    text: match[0],
    from: match.index ?? 0,
    upper: match[0].replace(/^["']|["']$/g, '').toUpperCase()
  }));
  const secret = new Set<number>();
  const command = tokens[0]?.upper;
  if (command === 'AUTH') {
    secret.add(tokens.length - 1);
  }
  tokens.forEach((token, index) => {
    if (index === 0) return;
    // HELLO 与 MIGRATE 里的 AUTH user pass / AUTH pass、MIGRATE 的 AUTH2 user pass
    if ((command === 'HELLO' || command === 'MIGRATE') && (token.upper === 'AUTH' || token.upper === 'AUTH2')) {
      const withUser = command === 'HELLO' || token.upper === 'AUTH2';
      secret.add(index + (withUser ? 2 : 1));
    }
    if (command === 'ACL' && tokens[1]?.upper === 'SETUSER' && index > 2 && /^["']?[<>]/.test(token.text)) {
      secret.add(index);
    }
  });
  if (command === 'CONFIG' && tokens[1]?.upper === 'SET') {
    for (let index = 2; index + 1 < tokens.length; index += 2) {
      if (/PASS|AUTH|SECRET/.test(tokens[index].upper)) secret.add(index + 1);
    }
  }
  let result = '';
  let cursor = 0;
  [...secret].filter((index) => index > 0 && index < tokens.length).sort((a, b) => a - b).forEach((index) => {
    const token = tokens[index];
    const kept = /^["']?[<>]/.test(token.text) && command === 'ACL' ? token.text.replace(/^(["']?[<>]).*$/s, '$1') : '';
    result += text.slice(cursor, token.from) + kept + '***';
    cursor = token.from + token.text.length;
  });
  return result + text.slice(cursor);
}

/** 控制台的一条写进历史之前：规则按语言，连接串里的口令三种都打 */
export function redactConsoleForHistory(language: ConsoleLanguage, text: string): RedactedSql {
  const redacted = language === 'cypher' ? redactCypher(text)
    : language === 'elasticsearch' ? redactEsRequest(text)
      : language === 'mongodb' ? redactMongoCommand(text)
        : redactRedisCommand(text);
  const withoutUrlCredentials = redacted.replace(URL_CREDENTIAL, '$1***$3');
  return { sql: withoutUrlCredentials, redacted: withoutUrlCredentials !== text };
}
