import type { SerializedResultValue } from '../contracts/resultSet';
import { isTaggedResultValue } from './resultValues';

export type ExportFormat = 'csv' | 'json';
export type CsvDelimiter = ',' | ';' | '\t';

export interface ExportOptions {
  format: ExportFormat;
  delimiter: CsvDelimiter;
  includeHeader: boolean;
  /** NULL 在 CSV 里写成什么。JSON 有真正的 null，不受这个影响。 */
  nullText: string;
  /** UTF-8 BOM。Excel 不认没有 BOM 的 UTF-8 CSV，中文会读成乱码。 */
  byteOrderMark: boolean;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  format: 'csv',
  delimiter: ',',
  includeHeader: true,
  nullText: '',
  byteOrderMark: false
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
