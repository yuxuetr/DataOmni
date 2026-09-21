import { format, type SqlLanguage } from 'sql-formatter';
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
    default:
      return null;
  }
}

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

  try {
    return {
      ok: true,
      sql: format(sql, {
        language,
        keywordCase: 'upper',
        // 和编辑器与整个项目的缩进一致
        tabWidth: 2,
        // 语句之间空一行
        linesBetweenQueries: 1
      })
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
