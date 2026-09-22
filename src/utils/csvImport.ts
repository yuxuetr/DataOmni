import type { ColumnInfo } from '../contracts/databaseMetadata';
import type { TranslationKey, TranslationParams } from '../i18n/translate';
import { isRequiredColumn } from './cellInput';
import { columnTypeToken } from './columnTypes';

/** 后端 `preview_csv_file` 的返回。表头那一行不在 `rows` 里。 */
export interface CsvPreview {
  delimiter: string;
  headers: string[];
  rows: string[][];
  totalBytes: number;
  more: boolean;
  ragged: Array<{ line: number; fields: number }>;
}

/**
 * 一个目标列从 CSV 的哪一列取值。
 *
 * 按**目标列**组织而不是按 CSV 列：写进语句的是目标列的清单，而「这一列不导入」
 * 是个真实的选择（自增列、有默认值的列）。反过来按 CSV 列组织的话，两个 CSV
 * 列指向同一个目标列是个能表达出来的状态，而它没有意义。
 */
export interface ColumnMapping {
  target: string;
  /** CSV 里的第几列，`null` = 这一列不导入 */
  source: number | null;
}

/** 名字对名字的归一：大小写、下划线、连字符、空格都不算数 */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * 按列名自动配对。
 *
 * 配不上就留空，不按位置猜。按位置对齐在列序恰好一致时很省事，在不一致时
 * 会把整张表的数据错位写进去——而错位的导入看起来是成功的。
 *
 * 由数据库产生的列（自增、identity、计算列）默认不导入：往
 * `GENERATED ALWAYS AS IDENTITY` 里写值，PostgreSQL 会直接拒绝整条语句。
 */
export function autoMapColumns(
  headers: readonly string[],
  columns: readonly ColumnInfo[]
): ColumnMapping[] {
  const byName = new Map<string, number>();
  headers.forEach((header, index) => {
    const key = normalizeName(header);
    // 同名的 CSV 列取第一个：后一个覆盖前一个会让配对结果取决于列序
    if (key && !byName.has(key)) {
      byName.set(key, index);
    }
  });

  return columns.map((column) => ({
    target: column.name,
    source: column.is_generated ? null : byName.get(normalizeName(column.name)) ?? null
  }));
}

export type ColumnKind =
  | 'integer'
  | 'number'
  | 'boolean'
  | 'date'
  | 'time'
  | 'timestamp'
  | 'json'
  | 'uuid'
  | 'text';

const INTEGER_TOKENS = new Set([
  'tinyint', 'smallint', 'mediumint', 'int', 'integer', 'int2', 'int4', 'int8', 'bigint',
  'serial', 'serial2', 'serial4', 'serial8', 'smallserial', 'bigserial', 'year'
]);
const NUMBER_TOKENS = new Set([
  'decimal', 'dec', 'numeric', 'fixed', 'real', 'double', 'float', 'float4', 'float8',
  'money', 'number'
]);
const BOOLEAN_TOKENS = new Set(['bool', 'boolean', 'bit']);
const DATE_TOKENS = new Set(['date']);
const TIME_TOKENS = new Set(['time', 'timetz']);
const TIMESTAMP_TOKENS = new Set(['timestamp', 'timestamptz', 'datetime', 'smalldatetime']);
const JSON_TOKENS = new Set(['json', 'jsonb']);

export function columnKind(dataType: string): ColumnKind {
  const token = columnTypeToken(dataType);
  if (INTEGER_TOKENS.has(token)) return 'integer';
  if (NUMBER_TOKENS.has(token)) return 'number';
  if (BOOLEAN_TOKENS.has(token)) return 'boolean';
  if (DATE_TOKENS.has(token)) return 'date';
  if (TIME_TOKENS.has(token)) return 'time';
  if (TIMESTAMP_TOKENS.has(token)) return 'timestamp';
  if (JSON_TOKENS.has(token)) return 'json';
  if (token === 'uuid') return 'uuid';
  return 'text';
}

const BOOLEAN_WORDS = new Set(['true', 'false', 't', 'f', 'yes', 'no', 'y', 'n', '1', '0']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 这个样例值看上去合不合这一列的类型。
 *
 * 结论只用来**提醒**，不用来拦：判断谁能进这一列的是数据库，不是这里。
 * 把它当成闸门就会在 `2026/01/02`（MySQL 收）这种值上挡住一次本来能成的导入。
 */
export function fitsColumn(value: string, kind: ColumnKind): boolean {
  switch (kind) {
    case 'integer':
      return /^[+-]?\d+$/.test(value);
    case 'number':
      return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value);
    case 'boolean':
      return BOOLEAN_WORDS.has(value.toLowerCase());
    case 'date':
      return DATE_PATTERN.test(value);
    case 'time':
      return TIME_PATTERN.test(value);
    case 'timestamp':
      return TIMESTAMP_PATTERN.test(value) || DATE_PATTERN.test(value);
    case 'uuid':
      return UUID_PATTERN.test(value);
    case 'json':
      try {
        JSON.parse(value);
        return true;
      } catch {
        return false;
      }
    default:
      return true;
  }
}

export interface ImportIssue {
  /** `error` = 现在导会失败；`warning` = 可能不是你想要的 */
  level: 'error' | 'warning';
  key: TranslationKey;
  params?: TranslationParams;
  /**
   * 要拼进 `{columns}` 的那几个列名。**拼接由渲染方做**。
   *
   * 这里是纯函数，拿不到当前语言，而中英文的顿号不一样——此前写死的
   * `join('、')` 让英文界面上印出 `column_a、column_b`。
   * 决定「有哪几列」是这个函数的事，决定「一串名字怎么写」是语言的事。
   */
  columns?: readonly string[];
}

/** 样例里挑出来的第一个不合类型的值，用来在映射表里就地提示 */
export interface ColumnSampleIssue {
  target: string;
  value: string;
}

/**
 * 样例值与目标类型对不上的列。
 *
 * 只报每列的第一个：一列里有一个日期格式不对，通常整列都不对，
 * 把两千行全列出来只会把真正的另一个问题埋掉。
 */
export function sampleMismatches(
  mappings: readonly ColumnMapping[],
  columns: readonly ColumnInfo[],
  rows: readonly string[][],
  nullText: string
): ColumnSampleIssue[] {
  const byName = new Map(columns.map((column) => [column.name, column]));
  const issues: ColumnSampleIssue[] = [];

  for (const mapping of mappings) {
    const column = byName.get(mapping.target);
    if (mapping.source === null || !column) {
      continue;
    }
    const kind = columnKind(column.data_type);
    if (kind === 'text') {
      continue;
    }
    for (const row of rows) {
      const value = row[mapping.source];
      // NULL 不参与类型判断——它要过的是非空约束，不是类型
      if (value === undefined || value === nullText) {
        continue;
      }
      if (!fitsColumn(value, kind)) {
        issues.push({ target: mapping.target, value });
        break;
      }
    }
  }

  return issues;
}

/**
 * 导入之前能看出来的问题。
 *
 * 分两档，而这个区分才是这个函数的意义：`error` 是现在按下去一定失败的，
 * `warning` 是「可能不是你想要的」。把后者也做成拦截，就会在数据库其实收得下
 * 的值上挡住一次正常的导入。
 */
export function validateImport(
  mappings: readonly ColumnMapping[],
  columns: readonly ColumnInfo[],
  preview: CsvPreview,
  nullText: string
): ImportIssue[] {
  const issues: ImportIssue[] = [];
  const mapped = mappings.filter((mapping) => mapping.source !== null);
  const byName = new Map(columns.map((column) => [column.name, column]));

  if (mapped.length === 0) {
    issues.push({ level: 'error', key: 'import.issue.noColumns' });
  }

  const missing = columns
    .filter((column) => isRequiredColumn(column))
    .filter((column) => !mapped.some((mapping) => mapping.target === column.name))
    .map((column) => column.name);
  if (missing.length > 0) {
    // 不给值就插不进去，而报出来的是一句方言各异的约束错误——整份都会失败
    issues.push({
      level: 'error',
      key: 'import.issue.requiredMissing',
      params: { count: missing.length },
      columns: missing
    });
  }

  const generated = mapped
    .map((mapping) => byName.get(mapping.target))
    .filter((column): column is ColumnInfo => Boolean(column?.is_generated))
    .map((column) => column.name);
  if (generated.length > 0) {
    issues.push({
      level: 'error',
      key: 'import.issue.generatedTarget',
      params: { count: generated.length },
      columns: generated
    });
  }

  if (preview.ragged.length > 0) {
    // 分隔符选错时这一项会立刻铺满，那比任何一条类型提示都重要
    issues.push({
      level: 'warning',
      key: 'import.issue.ragged',
      params: { count: preview.ragged.length, line: preview.ragged[0]?.line ?? 0 }
    });
  }

  for (const mismatch of sampleMismatches(mappings, columns, preview.rows, nullText)) {
    const column = byName.get(mismatch.target);
    issues.push({
      level: 'warning',
      key: 'import.issue.typeMismatch',
      params: {
        column: mismatch.target,
        type: column?.data_type ?? '',
        value: mismatch.value
      }
    });
  }

  const nullable = mapped.filter((mapping) => {
    const column = byName.get(mapping.target);
    return column && !column.is_nullable;
  });
  for (const mapping of nullable) {
    const hasNull = preview.rows.some((row) => row[mapping.source ?? 0] === nullText);
    if (hasNull) {
      issues.push({
        level: 'warning',
        key: 'import.issue.nullInNotNull',
        params: { column: mapping.target }
      });
    }
  }

  return issues;
}

/** 后端要的列清单。顺序就是 INSERT 里的列序。 */
export function importColumns(
  mappings: readonly ColumnMapping[],
  columns: readonly ColumnInfo[]
): Array<{ source: number; target: string; targetType: string }> {
  const byName = new Map(columns.map((column) => [column.name, column]));
  return mappings
    .filter((mapping): mapping is ColumnMapping & { source: number } => mapping.source !== null)
    .map((mapping) => ({
      source: mapping.source,
      target: mapping.target,
      targetType: byName.get(mapping.target)?.data_type ?? 'text'
    }));
}
