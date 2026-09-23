import { columnTypeToken } from './columnTypes';
import type { SqlIdentifierDialect } from './sqlIdentifiers';

/**
 * 一列该用哪种编辑器。
 *
 * 分类只看类型名的第一个词，不做子串匹配——`point` 和 `interval` 都含有 "int"。
 */
export type ColumnEditorKind =
  | 'text'
  | 'boolean'
  | 'json'
  | 'binary'
  | 'date'
  | 'time'
  | 'datetime';

const EDITOR_BY_TOKEN: Record<string, ColumnEditorKind> = {
  bool: 'boolean',
  boolean: 'boolean',
  json: 'json',
  jsonb: 'json',
  blob: 'binary',
  tinyblob: 'binary',
  mediumblob: 'binary',
  longblob: 'binary',
  bytea: 'binary',
  binary: 'binary',
  varbinary: 'binary',
  date: 'date',
  time: 'time',
  timetz: 'time',
  timestamp: 'datetime',
  timestamptz: 'datetime',
  datetime: 'datetime',
  smalldatetime: 'datetime'
};

export function columnEditorKind(dataType: string): ColumnEditorKind {
  return EDITOR_BY_TOKEN[columnTypeToken(dataType)] ?? 'text';
}

/** 十六进制里允许用空白分组，`de ad be ef` 和 `deadbeef` 是同一个值 */
export function normalizeHex(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * 这串十六进制能不能变成字节。
 *
 * 位数必须是偶数：奇数位说不清最后半个字节该补在高位还是低位，而两种补法
 * 存进去是两个不同的值。
 */
export function isCompleteHex(text: string): boolean {
  const hex = normalizeHex(text);
  return hex.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(hex);
}

/**
 * 二进制值的字面量。
 *
 * 二进制走**表达式**而不是绑定参数：绑定的是一串十六进制文本，存进 BLOB 列
 * 得到的是那串字符的字节，不是它表示的字节——长度正好翻倍，而语句不报错。
 *
 * PostgreSQL 的 bytea 输入格式是 `\x` 开头（`standard_conforming_strings`
 * 默认开着，所以这里的反斜杠是字面的）；MySQL 与 SQLite 用 `X'...'`；
 * SQL Server 是 `0x...`，它不认 `X'...'`。
 */
export function binaryLiteral(hex: string, dialect: SqlIdentifierDialect): string {
  const normalized = normalizeHex(hex).toLowerCase();
  if (dialect === 'sqlserver') {
    return `0x${normalized}`;
  }
  return dialect === 'postgresql'
    ? `'\\x${normalized}'::bytea`
    : `X'${normalized}'`;
}

/** 缩进过的 JSON；解析不了就返回 null，由调用方决定怎么提示 */
export function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

/**
 * 日期选择器给的值转成数据库认的文本。
 *
 * `datetime-local` 给的是 `2024-01-01T12:00:00`，中间那个 T 三种方言在比较和
 * 写入时都能接受，但存回去再读出来是带空格的形式，于是「改过没有」的比较
 * 每次都判成变了。这里统一换成空格。
 */
export function pickerValueToDatabaseText(value: string): string {
  return value.replace('T', ' ');
}

/**
 * 反过来：数据库里的文本转成选择器认的值。
 *
 * 认不出就返回空串——让选择器空着，而不是让它把一个认不出的值显示成
 * 某个看似合理的日期。文本框里的原值始终是权威，选择器只是个输入辅助。
 */
export function databaseTextToPickerValue(text: string, kind: ColumnEditorKind): string {
  const trimmed = text.trim();
  if (kind === 'date') {
    return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : '';
  }
  if (kind === 'time') {
    return /^\d{2}:\d{2}(:\d{2})?$/.test(trimmed) ? trimmed : '';
  }
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(:\d{2})?)/.exec(trimmed);
  return match ? `${match[1]}T${match[2]}` : '';
}
