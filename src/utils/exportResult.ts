import type { SqlDialect } from '../contracts/queryExecution';
import type { SerializedResultValue } from '../contracts/resultSet';
import { binaryLiteral } from './columnEditors';
import { isTaggedResultValue } from './resultValues';
import { quoteSqlIdentifier } from './sqlIdentifiers';
import { quoteSqlStringLiteral } from './sqlLiterals';

export type ExportFormat = 'csv' | 'json' | 'sql';
export type CsvDelimiter = ',' | ';' | '\t';

export interface ExportOptions {
  format: ExportFormat;
  delimiter: CsvDelimiter;
  includeHeader: boolean;
  /** NULL 在 CSV 里写成什么。JSON 有真正的 null，不受这个影响。 */
  nullText: string;
  /** UTF-8 BOM。Excel 不认没有 BOM 的 UTF-8 CSV，中文会读成乱码。 */
  byteOrderMark: boolean;
  /**
   * `INSERT INTO` 后面的表名，只有 `sql` 格式用。写成一个标识符、不带 schema：
   * 导出的语句多半是拿去灌进另一个库，那边的 schema 不见得同名。
   */
  sqlTable: string;
  /** 字面量与标识符按哪家的规矩写。`sql` 格式必须有 */
  sqlDialect?: SqlDialect;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  format: 'csv',
  delimiter: ',',
  includeHeader: true,
  nullText: '',
  byteOrderMark: false,
  sqlTable: ''
};

/**
 * 行分隔用 LF 而不是 RFC 4180 的 CRLF。
 * 现代 Excel / Numbers 都能读 LF；而 CRLF 会给 Unix 文本工具留下行尾的 `\r`，
 * 那是实际会咬人的一侧。
 */
const LINE_SEPARATOR = '\n';

/** U+FEFF。写成转义而不是字面字符——源码里的 BOM 肉眼不可见，改坏了也看不出来。 */
const UTF8_BOM = '\uFEFF';

export function serializeExport(
  columns: readonly string[],
  rows: ReadonlyArray<readonly SerializedResultValue[]>,
  options: ExportOptions
): string {
  const text = options.format === 'json'
    ? toJson(columns, rows)
    : options.format === 'sql'
      ? toSqlInserts(columns, rows, options)
      : toCsv(columns, rows, options);

  return options.byteOrderMark ? UTF8_BOM + text : text;
}

export function toCsv(
  columns: readonly string[],
  rows: ReadonlyArray<readonly SerializedResultValue[]>,
  options: ExportOptions
): string {
  const lines: string[] = [];

  if (options.includeHeader) {
    lines.push(columns.map(name => csvEscape(name, options.delimiter)).join(options.delimiter));
  }

  for (const row of rows) {
    lines.push(
      row
        .map(value => csvEscape(csvField(value, options.nullText), options.delimiter))
        .join(options.delimiter)
    );
  }

  return lines.join(LINE_SEPARATOR);
}

/**
 * 不收 `ExportOptions`：delimiter / includeHeader / nullText 都是 CSV 才有的概念。
 * 让签名说出这件事，比在函数里忽略掉三个参数更清楚。
 */
export function toJson(
  columns: readonly string[],
  rows: ReadonlyArray<readonly SerializedResultValue[]>
): string {
  const keys = uniqueColumnNames(columns);
  const records = rows.map(row => {
    const record: Record<string, unknown> = {};
    keys.forEach((key, index) => {
      record[key] = jsonField(row[index] ?? null);
    });
    return record;
  });

  return JSON.stringify(records, null, 2);
}

/**
 * 每行一条 `INSERT`，以 `;` 结尾、换行分隔。
 *
 * 不写多行 `VALUES`：Oracle 不认，而一行一条在任何一家都能跑、出错时也能定位到行。
 * 重名列照原样写出去——替它改名是往一张不存在的列里插值，让数据库报错更诚实。
 */
export function toSqlInserts(
  columns: readonly string[],
  rows: ReadonlyArray<readonly SerializedResultValue[]>,
  options: Pick<ExportOptions, 'sqlTable' | 'sqlDialect'>
): string {
  const dialect = options.sqlDialect ?? 'sqlite';
  const head = `INSERT INTO ${quoteSqlIdentifier(options.sqlTable, dialect)} (`
    + columns.map(name => quoteSqlIdentifier(name, dialect)).join(', ')
    + ') VALUES (';

  return rows
    .map(row => head + columns.map((_, index) => sqlLiteral(row[index] ?? null, dialect)).join(', ') + ');')
    .join(LINE_SEPARATOR);
}

/**
 * 日期时间写成字符串，由数据库隐式转换——各家都认 `YYYY-MM-DD HH:MM:SS`。
 * 只有 Oracle 不行：它按会话的 NLS_DATE_FORMAT 解析字符串，所以写成 ANSI 的
 * `DATE '…'` / `TIMESTAMP '…'`。
 */
export function sqlLiteral(value: SerializedResultValue, dialect: SqlDialect): string {
  if (value === null) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    // SQL Server 没有 TRUE；Oracle 23 之前也没有，布尔多半存成 NUMBER(1)
    if (dialect === 'sqlserver' || dialect === 'oracle') {
      return value ? '1' : '0';
    }
    return value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    return quoteSqlStringLiteral(value, dialect);
  }
  if (!isTaggedResultValue(value)) {
    // 契约之外的对象 / 数组：照 Rust 那侧的 `to_string()` 写成紧凑的 JSON 文本
    return quoteSqlStringLiteral(JSON.stringify(value), dialect);
  }
  switch (value.type) {
    case 'bigint':
    case 'decimal':
      return value.value;
    case 'binary':
      return binaryLiteral(value.value, dialect);
    case 'date':
      return dialect === 'oracle' ? `DATE '${value.value}'` : quoteSqlStringLiteral(value.value, dialect);
    case 'datetime':
      return dialect === 'oracle' ? `TIMESTAMP '${value.value}'` : quoteSqlStringLiteral(value.value, dialect);
    default:
      return quoteSqlStringLiteral(value.value, dialect);
  }
}

/**
 * 一条 SELECT 完全可以返回两列都叫 `id`。JSON 用列名作键，重名会让后一列
 * 静默顶掉前一列——导出少一列而文件看上去完全正常，是最难发现的一种损坏。
 */
export function uniqueColumnNames(columns: readonly string[]): string[] {
  const taken = new Set<string>();

  return columns.map(name => {
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }

    let suffix = 2;
    while (taken.has(`${name}_${suffix}`)) {
      suffix += 1;
    }
    const unique = `${name}_${suffix}`;
    taken.add(unique);
    return unique;
  });
}

export function suggestExportFileName(
  source: string,
  format: ExportFormat,
  now: Date = new Date()
): string {
  const base = source.replace(/[\\/:*?"<>|]/g, '_').trim() || 'result';
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  return `${base}-${stamp}.${format}`;
}

function csvField(value: SerializedResultValue, nullText: string): string {
  if (value === null) {
    return nullText;
  }
  if (!isTaggedResultValue(value)) {
    return String(value);
  }
  if (value.type === 'binary') {
    return `0x${value.value}`;
  }
  if (value.type === 'json') {
    // 数据库里的 JSON 常带缩进换行。CSV 单元格放得下，但每一行都会撑开引号块，
    // 用表格软件打开后满屏是断行。压成一行更像「一个值」。
    try {
      return JSON.stringify(JSON.parse(value.value));
    } catch {
      return value.value;
    }
  }
  return value.value;
}

function csvEscape(field: string, delimiter: string): string {
  const needsQuotes = field.includes(delimiter)
    || field.includes('"')
    || field.includes('\n')
    || field.includes('\r');

  return needsQuotes ? `"${field.replace(/"/g, '""')}"` : field;
}

function jsonField(value: SerializedResultValue): unknown {
  if (value === null || !isTaggedResultValue(value)) {
    return value;
  }
  if (value.type === 'binary') {
    return `0x${value.value}`;
  }
  if (value.type === 'json') {
    try {
      return JSON.parse(value.value);
    } catch {
      return value.value;
    }
  }
  // bigint / decimal 写成字符串。JSON 数字在实践中就是 IEEE-754 双精度，
  // 消费方 JSON.parse 一个 20 位整数必然丢位；加引号才能无损往返。
  return value.value;
}
