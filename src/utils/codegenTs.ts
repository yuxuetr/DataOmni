import { NameScope, nameWords, type CodegenDialect, type LogicalType } from './codegenModel';

/**
 * TypeORM 与 MikroORM 共用的 TypeScript 部分：属性的 TS 类型、文件名、字面量。
 * 两个 ORM 读出来的值形状一致（decimal 是字符串，免得丢精度；date 与 time 是字符串）
 */

/**
 * 64 位整数读出来是什么取决于驱动：pg、mysql2、mssql 给字符串（免得丢精度），
 * SQLite 的驱动与 oracledb 给 number（SQLite 的 INTEGER 都是 64 位，给字符串就全错了）
 */
export function bigIntAsString(dialect: CodegenDialect): boolean {
  return dialect === 'postgresql' || dialect === 'mysql' || dialect === 'sqlserver';
}

export function tsType(logical: LogicalType, dialect: CodegenDialect): string {
  switch (logical.kind) {
    case 'int':
      return logical.bytes === 8 && bigIntAsString(dialect) ? 'string' : 'number';
    case 'decimal':
      return 'string';
    case 'float':
      return 'number';
    case 'bool':
      return 'boolean';
    case 'string':
    case 'text':
    case 'uuid':
    case 'date':
    case 'time':
    case 'unknown':
      return 'string';
    case 'json':
      return 'unknown';
    case 'bytes':
      return 'Buffer';
    case 'timestamp':
      return 'Date';
  }
}

/** `user_profiles` → `user-profiles.entity.ts`；同名（大小写不同也算）加序号 */
export function entityFileName(tableName: string, files: NameScope): string {
  const base = nameWords(tableName).join('-') || 'table';
  return `${files.claim(base)}.entity.ts`;
}

/** 类里不能当属性名的只有这一个（其余关键字都能当属性名） */
export const TS_RESERVED_PROPERTIES = new Set(['constructor']);

export function tsString(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

/** 对象字面量的键：是合法标识符就裸写 */
export function tsKey(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : tsString(name);
}

export function tsObject(entries: Array<[string, string]>): string {
  return `{ ${entries.map(([key, value]) => `${tsKey(key)}: ${value}`).join(', ')} }`;
}
