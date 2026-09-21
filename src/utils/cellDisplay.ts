import type { SerializedResultValue } from '../contracts/resultSet';
import { formatResultValueOneLine, isTaggedResultValue } from './resultValues';

/**
 * 单元格在网格里的呈现形态。
 *
 * 分出这几类是因为它们**长得一样但含义不同**：NULL、空字符串和一串空格在
 * 一个朴素的网格里都是一块空白，用户无从判断自己看到的是哪一种，而这三者
 * 在 WHERE 条件里的行为完全不同。
 */
export type CellDisplayKind = 'null' | 'empty' | 'blank' | 'binary' | 'value';

export interface CellDisplay {
  kind: CellDisplayKind;
  /** 网格里显示的单行文本 */
  text: string;
  /** 二进制的字节数，用于说明被截断的那一段有多长；其余为 null */
  byteLength: number | null;
  /** 二进制是否被截断了 */
  truncated: boolean;
}

/**
 * 十六进制最多显示这么多个字符（32 字节）。
 *
 * 不是为了好看：一个 1MB 的 BLOB 展开成十六进制是两百万个字符，整串塞进
 * `title` 属性会让浏览器为每一格都留着这么长一个字符串，一页 100 行就是
 * 两亿字符。字节数已经把「这有多大」说清楚了，全文对人没有用。
 */
const BINARY_HEX_LIMIT = 64;

export function describeCellDisplay(value: SerializedResultValue): CellDisplay {
  if (value === null || value === undefined) {
    return { kind: 'null', text: 'NULL', byteLength: null, truncated: false };
  }

  if (isTaggedResultValue(value) && value.type === 'binary') {
    const hex = value.value;
    const truncated = hex.length > BINARY_HEX_LIMIT;
    return {
      kind: 'binary',
      text: `0x${truncated ? hex.slice(0, BINARY_HEX_LIMIT) : hex}${truncated ? '…' : ''}`,
      // 十六进制两个字符一个字节；奇数长度只可能来自坏数据，向上取整不丢字节
      byteLength: Math.ceil(hex.length / 2),
      truncated
    };
  }

  if (typeof value === 'string') {
    if (value === '') {
      return { kind: 'empty', text: "''", byteLength: null, truncated: false };
    }
    if (value.trim() === '') {
      // 加引号是为了让空白的**长度**看得见。不用自造的符号：`'   '` 任何
      // 写过 SQL 的人都认得，而 `␣␣␣` 还得先解释一遍
      return { kind: 'blank', text: `'${value}'`, byteLength: null, truncated: false };
    }
  }

  return {
    kind: 'value',
    text: formatResultValueOneLine(value),
    byteLength: null,
    truncated: false
  };
}
