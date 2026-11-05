import type { CodegenDialect, LogicalType } from './codegenModel';

/**
 * SeaORM 与 sqlx 共用的 Rust 部分。sqlx 读值时**严格按宽度**核对类型（INT 读进 i64 是运行期错误），
 * 所以整数按字节数与有无符号给，不往宽里放。路径写全（`sqlx::types::…` / SeaORM prelude 的别名），
 * 生成的文件不必再加 `use`
 */

/** 不能当字段名、模块名的 Rust 关键字（严格与保留的都算） */
export const RUST_KEYWORDS = new Set([
  'as', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in',
  'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'static', 'struct', 'super',
  'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while', 'async', 'await', 'dyn', 'abstract', 'become', 'box',
  'do', 'final', 'macro', 'override', 'priv', 'typeof', 'unsized', 'virtual', 'yield', 'try', 'gen'
]);

export interface RustTypes {
  decimal: string;
  uuid: string;
  json: string;
  date: string;
  time: string;
  timestamp: string;
  timestampUtc: string;
  timestampTz: string;
}

/** SeaORM prelude 里的别名 */
export const SEAORM_TYPES: RustTypes = {
  decimal: 'Decimal',
  uuid: 'Uuid',
  json: 'Json',
  date: 'Date',
  time: 'Time',
  timestamp: 'DateTime',
  timestampUtc: 'DateTimeUtc',
  timestampTz: 'DateTimeWithTimeZone'
};

/** sqlx 自己再导出的类型（开了对应的 feature） */
export const SQLX_TYPES: RustTypes = {
  decimal: 'sqlx::types::Decimal',
  uuid: 'sqlx::types::Uuid',
  json: 'sqlx::types::JsonValue',
  date: 'sqlx::types::chrono::NaiveDate',
  time: 'sqlx::types::chrono::NaiveTime',
  timestamp: 'sqlx::types::chrono::NaiveDateTime',
  timestampUtc: 'sqlx::types::chrono::DateTime<sqlx::types::chrono::Utc>',
  timestampTz: 'sqlx::types::chrono::DateTime<sqlx::types::chrono::Utc>'
};

/** 映射不了时给 `null`，调用方写成 String 并列进说明 */
export function rustType(logical: LogicalType, dialect: CodegenDialect, types: RustTypes): string | null {
  switch (logical.kind) {
    case 'int': {
      // MySQL 才有无符号；SQL Server 的 tinyint 是 0–255，但 SeaORM 与 sqlx 都不支持 SQL Server
      const unsigned = logical.unsigned && dialect === 'mysql';
      return `${unsigned ? 'u' : 'i'}${logical.bytes * 8}`;
    }
    case 'decimal':
      return types.decimal;
    case 'float':
      return logical.bytes === 4 ? 'f32' : 'f64';
    case 'bool':
      return 'bool';
    case 'string':
    case 'text':
      return 'String';
    case 'uuid':
      return types.uuid;
    case 'json':
      return types.json;
    case 'bytes':
      return 'Vec<u8>';
    case 'date':
      return types.date;
    case 'time':
      return types.time;
    case 'timestamp':
      if (!logical.withTimeZone) return types.timestamp;
      // MySQL 的 TIMESTAMP 存的是 UTC 时刻，读出来没有偏移
      return dialect === 'mysql' ? types.timestampUtc : types.timestampTz;
    case 'unknown':
      return null;
  }
}

/** Rust 的字符串字面量 */
export function rustString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function escapeRustKeyword(name: string): string {
  return `${name}_`;
}
