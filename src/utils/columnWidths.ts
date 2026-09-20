import type { SerializedResultValue } from '../contracts/resultSet';
import { formatResultValueOneLine, isNumericResultValue } from './resultValues';

/**
 * 按内容估算列宽。
 *
 * 两个表格此前都把列宽写死成 180px（或 min-w-[180px]）：一列 `id` 和一列
 * 长 JSON 占一样宽，前者浪费、后者截断，横向滚动条却总是在。
 *
 * 这里用字符宽度估算而不是真实测量（canvas measureText / DOM 测量）：
 * - 数据是等宽字体渲染的，字符数就是宽度，估算误差只来自少数符号；
 * - 纯函数可测、可反向验证，不依赖浏览器环境；
 * - 上千行时不需要为了排版先渲染一遍。
 */
export interface ColumnWidthOptions {
  /** 再窄也要放得下表头的排序箭头和类型标签 */
  minWidth?: number;
  /** 再宽也不让一列吃掉整个视口，超出的靠单元格内截断 */
  maxWidth?: number;
  /** 只看前若干行。列宽是视觉估计，不值得为它扫完上万行 */
  sampleRows?: number;
  /**
   * 一个半角字符的像素宽。
   *
   * 这个模型只有在单元格用等宽字体时才成立，所以数据单元格是 `font-mono
   * text-[13px]`。实测 13px 等宽字体下每个字符 7.83px；14px 无衬线下数字
   * 8.32px、小写字母 7.26px——变宽字体里任何单一常数都必然对其中一类是错的，
   * 之前按 7px 估算，结果 BIGINT 和 DECIMAL 列总是被截掉尾巴。
   */
  charWidth?: number;
  /** 左右内边距加边框 */
  padding?: number;
}

const DEFAULTS: Required<ColumnWidthOptions> = {
  minWidth: 64,
  maxWidth: 360,
  sampleRows: 200,
  charWidth: 7.9,
  padding: 26
};

/**
 * 文本的显示宽度，按半角字符计。
 *
 * 中日韩文字、全角标点在等宽字体下占两个半角位；按 length 算会让中文列
 * 宽出一倍的缺口。
 */
export function displayWidthInChars(text: string): number {
  let width = 0;

  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    width += isFullWidth(code) ? 2 : 1;
  }

  return width;
}

function isFullWidth(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) // 韩文字母
    || (code >= 0x2e80 && code <= 0xa4cf) // 部首、假名、CJK 统一表意
    || (code >= 0xac00 && code <= 0xd7a3) // 韩文音节
    || (code >= 0xf900 && code <= 0xfaff) // CJK 兼容表意
    || (code >= 0xfe30 && code <= 0xfe6f) // CJK 兼容形式
    || (code >= 0xff00 && code <= 0xff60) // 全角 ASCII
    || (code >= 0xffe0 && code <= 0xffe6) // 全角符号
    || (code >= 0x20000 && code <= 0x3fffd) // CJK 扩展 B 及以后
  );
}

/**
 * 把宽度夹到上下限之间。估算和手动拖动共用同一条规则——否则拖出来的列宽可以
 * 是估算永远不会产生的值（比如 0 或者比视口还宽）。
 */
export function clampColumnWidth(
  width: number,
  options: Pick<ColumnWidthOptions, 'minWidth' | 'maxWidth'> = {}
): number {
  const minWidth = options.minWidth ?? DEFAULTS.minWidth;
  // 手动拖宽可以超过自动估算的上限：用户明确要求看更宽的一列时不该拦着
  const maxWidth = options.maxWidth ?? DEFAULTS.maxWidth;
  return Math.min(maxWidth, Math.max(minWidth, Math.round(width)));
}

/**
 * 行按位置与 columns 对应。项目里两种结果形态并存——`QueryResult.rows` 是
 * 位置数组，执行器返回的是按列名索引的对象——这里取更基础的位置形态，
 * 按列名索引的调用方用 `toPositionalRows` 转一次。
 */
export function measureColumnWidths(
  columns: readonly string[],
  rows: readonly (readonly SerializedResultValue[])[],
  options: ColumnWidthOptions = {}
): number[] {
  const { minWidth, maxWidth, sampleRows, charWidth, padding } = { ...DEFAULTS, ...options };
  const sample = rows.length > sampleRows ? rows.slice(0, sampleRows) : rows;

  return columns.map((column, index) => {
    let widest = displayWidthInChars(column);

    for (const row of sample) {
      const value = row[index];
      // 行比列短时该位置当作空，不参与加宽
      if (value === undefined) {
        continue;
      }
      // 量的必须是单元格真正显示的那个形态，否则宽度和内容对不上
      widest = Math.max(widest, displayWidthInChars(formatResultValueOneLine(value)));
    }

    return clampColumnWidth(widest * charWidth + padding, { minWidth, maxWidth });
  });
}

/** 按列名索引的行转成位置数组；缺失的列留 null（显示为 NULL，宽度按四个字符算） */
export function toPositionalRows(
  columns: readonly string[],
  rows: readonly Record<string, SerializedResultValue>[]
): SerializedResultValue[][] {
  return rows.map((row) => columns.map((column) => row[column] ?? null));
}

export type ColumnAlignment = 'left' | 'right';

/**
 * 每列的对齐方式。
 *
 * 按列判定而不是按格：同一列里 NULL 和数字混排时，逐格判定会让这一列左右
 * 参差。只要样本里出现过非数值（NULL 不算），整列就靠左。
 */
export function measureColumnAlignments(
  columns: readonly string[],
  rows: readonly (readonly SerializedResultValue[])[],
  options: Pick<ColumnWidthOptions, 'sampleRows'> = {}
): ColumnAlignment[] {
  const sampleRows = options.sampleRows ?? DEFAULTS.sampleRows;
  const sample = rows.length > sampleRows ? rows.slice(0, sampleRows) : rows;

  return columns.map((_column, index) => {
    let sawNumber = false;

    for (const row of sample) {
      const value = row[index];
      // NULL 和缺失不表态：一列数字里有空值，它仍然是数字列
      if (value === undefined || value === null) {
        continue;
      }
      if (!isNumericResultValue(value)) {
        return 'left';
      }
      sawNumber = true;
    }

    return sawNumber ? 'right' : 'left';
  });
}
