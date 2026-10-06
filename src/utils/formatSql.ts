import {
  clickhouse,
  duckdb,
  format,
  formatDialect,
  postgresql,
  type DialectOptions,
  type KeywordCase,
  type SqlLanguage
} from 'sql-formatter';
import { isolateHistory } from '@codemirror/commands';
import type { TransactionSpec } from '@codemirror/state';
import { DatabaseType } from '../contracts/connection';
import { describeError } from './describeError';
import { findSqlStatementAtOffset, getSqlStatementRanges } from './sqlStatements';

export type FormatSqlResult =
  | { ok: true; sql: string }
  | { ok: false; message: string };

/**
 * 方言到 `sql-formatter` 语言名的对应。
 *
 * 认不出来时返回 null 而不是退回某个默认方言：格式化是**按方言解析**的，
 * 用错方言会直接抛解析错误（实测 PostgreSQL 解析 MySQL 的反引号标识符就会），
 * 界面上表现为「点一下格式化，弹个看不懂的错」。返回 null 让按钮直接禁用。
 */
export function sqlFormatterLanguage(dbType: DatabaseType): SqlLanguage | null {
  switch (dbType) {
    case DatabaseType.MySQL:
      return 'mysql';
    case DatabaseType.PostgreSQL:
      return 'postgresql';
    case DatabaseType.SQLite:
      return 'sqlite';
    case DatabaseType.SqlServer:
      return 'transactsql';
    case DatabaseType.Oracle:
      return 'plsql';
    case DatabaseType.DuckDB:
      return 'duckdb';
    case DatabaseType.ClickHouse:
      return 'clickhouse';
    default:
      return null;
  }
}

/**
 * sql-formatter 当关键字大写、却能不加引号当名字用的词。这些词保留原来的写法。
 *
 * 只有名字区分大小写的方言要管：PostgreSQL 把不加引号的名字折成小写，Oracle 折成大写，
 * SQLite、DuckDB 不分大小写，大写之后指的还是同一个对象。
 * - MySQL：Linux 上表名区分大小写（`lower_case_table_names` 默认 0），`from commit` 排成
 *   `FROM COMMIT` 就报 1146 表不存在。
 * - SQL Server：库的排序规则区分大小写时（`_CS_`、`_BIN2`，SAP 一类常见）表名列名都区分，
 *   `type` 排成 `TYPE` 报 208 对象名无效。
 *
 * 名单是实测的：sql-formatter 15.8 在表名位置会改的词（MySQL 207 个、T-SQL 216 个），逐个不加引号建表，
 * MySQL 在 8.4 与 MariaDB 11.8 上建（`function`、`row`、`system` 等只在 MariaDB 上建得成），
 * T-SQL 在 SQL Server 2022 的 `Latin1_General_CS_AS` 库里建。建得成的在这里；其余是保留字，
 * 本来就得加引号，照旧大写。升级 sql-formatter 后它的关键字表变了，名单要照这个办法重算
 */
const NAMEABLE_KEYWORDS: Partial<Record<SqlLanguage, ReadonlySet<string>>> = {
  mysql: new Set([
    'binlog', 'clone', 'commit', 'cube', 'empty', 'end', 'execute', 'flush', 'function', 'generated',
    'get', 'groups', 'handler', 'help', 'io_after_gtids', 'io_before_gtids', 'lateral', 'master_bind',
    'master_pos_wait', 'master_ssl_verify_server_cert', 'modify', 'of', 'offset', 'optimizer_costs',
    'option', 'prepare', 'reset', 'restart', 'rollback', 'row', 'savepoint', 'shutdown',
    'source_pos_wait', 'stored', 'system', 'truncate', 'virtual', 'window', 'xa'
  ]),
  transactsql: new Set([
    'aggregate', 'ansi_defaults', 'ansi_null_dflt_off', 'ansi_null_dflt_on', 'ansi_nulls', 'ansi_padding',
    'ansi_warnings', 'arithabort', 'arithignore', 'assembly', 'certificate', 'concat_null_yields_null',
    'context_info', 'contract', 'credential', 'cursor_close_on_commit', 'datefirst', 'dateformat',
    'deadlock_priority', 'disk', 'dump', 'endpoint', 'fips_flagger', 'fmtonly', 'forceplan',
    'get_transmission_status', 'go', 'implicit_transactions', 'language', 'load', 'lock_timeout', 'login',
    'nocount', 'noexec', 'numeric_roundabort', 'offset', 'parseonly', 'query_governor_cost_limit', 'queue',
    'quoted_identifier', 'receive', 'remote_proc_transactions', 'role', 'route', 'securityaudit', 'send',
    'sequence', 'service', 'showplan_all', 'showplan_text', 'showplan_xml', 'signature', 'synonym', 'type',
    'window', 'xact_abort'
  ])
};

/**
 * 给方言里某种单引号字符串补上 sql-formatter 不认的前缀。它不认的前缀会被排成 `N 'a'`，
 * 而前缀与引号之间不能有空白：
 * - PostgreSQL 与 DuckDB 的 `N'…'`（从 SQL Server 搬来的脚本满是这种写法）拆开后是「类型 N 的
 *   字面量」，报类型不存在（PostgreSQL 16、DuckDB 1.5 上试过）。
 * - ClickHouse 的 `x'4142'`、`b'01000001'` 拆开后是语法错误（26.9 上试过）。
 *
 * 前缀不分大小写，`n'…'` 也认
 */
const withStringPrefixes = (
  dialect: DialectOptions,
  quote: string,
  prefixes: readonly string[]
): DialectOptions => ({
  ...dialect,
  tokenizerOptions: {
    ...dialect.tokenizerOptions,
    stringTypes: dialect.tokenizerOptions.stringTypes.map((type) => {
      if (type === quote) {
        return { quote: type, prefixes: [...prefixes] };
      }
      if (typeof type === 'object' && 'quote' in type && type.quote === quote) {
        return { ...type, prefixes: [...type.prefixes, ...prefixes] };
      }
      return type;
    })
  }
});

const PATCHED_DIALECTS: Partial<Record<SqlLanguage, DialectOptions>> = {
  postgresql: withStringPrefixes(postgresql, "''-qq", ['N']),
  duckdb: withStringPrefixes(duckdb, "''-qq", ['N']),
  clickhouse: withStringPrefixes(clickhouse, "''-qq-bs", ['X', 'B'])
};

/**
 * 排版一段 SQL。
 *
 * 关键字统一大写：补全插入的关键字本来就是大写的（`upperCaseKeywords`），
 * 格式化再保留原样会让同一份文档里 `select` 和 `SELECT` 并存。
 *
 * 解析不了时**原样返回错误、不返回任何文本**——调用方据此保持编辑器不动。
 * 格式化是个随手会按的动作，它绝不能把写了一半的语句改坏。
 */
export function formatSql(sql: string, language: SqlLanguage): FormatSqlResult {
  // 空白内容没什么可排的，也不该因为它去撞解析器
  if (sql.trim() === '') {
    return { ok: true, sql };
  }

  const formatAs = (keywordCase: KeywordCase): string => {
    const options = {
      // 和编辑器与整个项目的缩进一致
      tabWidth: 2,
      // 语句之间空一行
      linesBetweenQueries: 1,
      keywordCase
    };
    const dialect = PATCHED_DIALECTS[language];
    return dialect ? formatDialect(sql, { ...options, dialect }) : format(sql, { ...options, language });
  };

  try {
    // ClickHouse 例外：它的名字区分大小写，而 sql-formatter 把 type、name、key、
    // events 这些词当关键字，列名表名跟着被改成大写，语句就找不到对象了
    if (language === 'clickhouse') {
      return { ok: true, sql: formatAs('preserve') };
    }
    const upper = formatAs('upper');
    const nameable = NAMEABLE_KEYWORDS[language];
    if (!nameable) {
      return { ok: true, sql: upper };
    }
    // 大小写不影响排版，两份逐字对齐；对不齐（不该发生）就整份保留原样，宁可不大写
    const preserved = formatAs('preserve');
    return {
      ok: true,
      sql: preserved.length === upper.length
        ? upper.replace(/[A-Za-z_]+/g, (word, offset: number) => (
          nameable.has(word.toLowerCase()) ? preserved.slice(offset, offset + word.length) : word
        ))
        : preserved
    };
  } catch (error) {
    // 解析错误里带着行号列号，正是排查时要看的，原话交出去
    return { ok: false, message: describeError(error) };
  }
}

/**
 * 排版之后光标该落在哪。
 *
 * 整份排版会把文本从头到尾换掉，CodeMirror 默认会把光标映射到改动末尾——
 * 也就是每按一次格式化，视线就被扔到文档最底下。这里改成「排版前在第几条
 * 语句里，排版后还在第几条语句的开头」。
 *
 * 只能回到**语句开头**，回不到语句内部的原位置：排版重排了语句内的一切，
 * 「原来那个位置」在新文本里没有对应物。语句数对不上时退回按偏移量夹取。
 */
export function cursorAfterFormat(
  original: string,
  formatted: string,
  cursor: number
): number {
  const before = findSqlStatementAtOffset(original, cursor);
  if (before) {
    const after = getSqlStatementRanges(formatted)[before.index];
    if (after) {
      return after.from;
    }
  }

  return Math.min(cursor, formatted.length);
}

/** 光标或选区在文档里的位置 */
export interface EditorSelection {
  from: number;
  to: number;
  /** 光标端；整份排版后靠它决定视线落在哪 */
  head: number;
}

export type FormatPlan =
  | { kind: 'unchanged' }
  | { kind: 'failed'; message: string }
  /** MySQL 客户端的 DELIMITER 脚本，格式化器会把它排坏 */
  | { kind: 'delimiterScript' }
  | { kind: 'replace'; from: number; to: number; insert: string; anchor: number; head: number };

/**
 * 算出「按下格式化」要对文档做什么改动。
 *
 * 有选区就只排选区——这是在一份长脚本里只想整理手头这一段时唯一的做法。
 * 没有选区就排整份。
 *
 * 排完没变化时返回 `unchanged` 而不是一个等值的替换：白占一次撤销，
 * 光标还会跟着跳一下。
 */
export function planFormat(
  doc: string,
  selection: EditorSelection,
  language: SqlLanguage
): FormatPlan {
  const onlySelection = selection.from !== selection.to;
  const from = onlySelection ? selection.from : 0;
  const to = onlySelection ? selection.to : doc.length;
  if (delimiterInEffect(doc, from, to)) {
    return { kind: 'delimiterScript' };
  }
  const source = doc.slice(from, to);

  const result = formatSql(source, language);
  if (!result.ok) {
    return { kind: 'failed', message: result.message };
  }
  if (result.sql === source) {
    return { kind: 'unchanged' };
  }

  // 排完仍然选中它，方便看清改了什么、或者再排一次
  const anchor = onlySelection ? from : cursorAfterFormat(source, result.sql, selection.head);
  return {
    kind: 'replace',
    from,
    to,
    insert: result.sql,
    anchor,
    head: onlySelection ? from + result.sql.length : anchor
  };
}

/**
 * 把排版计划写成编辑器的一次改动。
 *
 * 单独成一步撤销：CodeMirror 把 500ms 内的改动并成一步，刚打完字就按格式化，
 * 撤销一次会连那几个字一起撤掉
 */
export function formatTransaction(plan: Extract<FormatPlan, { kind: 'replace' }>): TransactionSpec {
  return {
    changes: { from: plan.from, to: plan.to, insert: plan.insert },
    selection: { anchor: plan.anchor, head: plan.head },
    annotations: isolateHistory.of('full')
  };
}

/** 同 `sqlStatements` 里认的写法：行首的 `DELIMITER <分隔符>` */
const DELIMITER_DIRECTIVE = /^[\t ]*delimiter[\t ]+(\S+)/gim;

/**
 * 要排的这一段碰不碰 DELIMITER。
 *
 * 格式化器不认这条客户端指令：`//` 被拆成 `/ /`、`DELIMITER ;` 被并进上一行，排完的脚本再跑就报错。
 * 选区里有这条指令，或者选区之前把分隔符换成了别的、还没换回分号，都不排
 */
function delimiterInEffect(doc: string, from: number, to: number): boolean {
  let delimiter = ';';
  for (const match of doc.slice(0, to).matchAll(DELIMITER_DIRECTIVE)) {
    if (match.index >= from) {
      return true;
    }
    delimiter = match[1];
  }
  return delimiter !== ';';
}
