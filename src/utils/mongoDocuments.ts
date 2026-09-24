/**
 * MongoDB 集合页的纯函数：后端给的一页文档怎么排成网格。
 *
 * 值的文字（`ObjectId('…')`、`Long('41')`）是后端按 mongosh 写法格式化好的，
 * 这里不再解析它——解析器只有后端那一份（`services/mongo_shell.rs`），两边各写一份
 * 就会有一边悄悄读错。
 */

/** 与后端 `mongo_shell::value_kind` 一致 */
export type MongoValueKind =
  | 'double'
  | 'int'
  | 'long'
  | 'decimal'
  | 'string'
  | 'bool'
  | 'null'
  | 'objectId'
  | 'date'
  | 'document'
  | 'array'
  | 'binary'
  | 'other';

export interface MongoCell {
  kind: MongoValueKind;
  text: string;
  truncated: boolean;
}

export interface MongoDocumentRow {
  /** `_id` 的 mongosh 写法；视图的结果可以没有 */
  id: string | null;
  fields: Record<string, MongoCell>;
}

export interface MongoFindPage {
  documents: MongoDocumentRow[];
  has_more: boolean;
}

/**
 * 一页文档的列：所有文档顶层字段的并集，`_id` 在最前，其余按第一次出现的顺序。
 *
 * 同一个集合里的文档字段可以各不相同，只取第一个文档的字段，后面文档多出来的
 * 字段就看不见了——而那往往正是要找的那个异常文档。按字母排也不行：文档自己的
 * 字段顺序是写入方定的，通常有意义（`name` 在 `createdAt` 前面）。
 */
export function mongoColumns(documents: readonly MongoDocumentRow[]): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const document of documents) {
    for (const key of Object.keys(document.fields)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  const idIndex = columns.indexOf('_id');
  if (idIndex > 0) {
    columns.splice(idIndex, 1);
    columns.unshift('_id');
  }
  return columns;
}

const NUMERIC_KINDS: ReadonlySet<MongoValueKind> = new Set(['double', 'int', 'long', 'decimal']);

export function isNumericKind(kind: MongoValueKind): boolean {
  return NUMERIC_KINDS.has(kind);
}

/**
 * 一列靠右还是靠左。与关系库的网格同一条规则：样本里出现过非数值就整列靠左，
 * 缺字段和 null 不表态
 */
export function mongoColumnAlignment(
  documents: readonly MongoDocumentRow[],
  column: string
): 'left' | 'right' {
  let sawNumber = false;
  for (const document of documents) {
    const cell = document.fields[column];
    if (!cell || cell.kind === 'null') {
      continue;
    }
    if (!isNumericKind(cell.kind)) {
      return 'left';
    }
    sawNumber = true;
  }
  return sawNumber ? 'right' : 'left';
}

/**
 * 分页的结果区间，给「第 x–y 条，共 z 条」用。
 *
 * 总数是另一条请求数的，可能还没回来，也可能数失败了（大集合上带条件的精确计数会
 * 超时）——那时不能拿 `hasMore` 冒充总数，页码导航只靠「有没有下一页」走。
 */
export interface MongoPageRange {
  from: number;
  to: number;
  total: number | null;
  hasPrevious: boolean;
  hasNext: boolean;
  /** 总数知道时才有 */
  lastPage: number | null;
}

export function mongoPageRange(
  page: number,
  pageSize: number,
  shown: number,
  hasMore: boolean,
  total: number | null
): MongoPageRange {
  const skip = (page - 1) * pageSize;
  return {
    from: shown === 0 ? 0 : skip + 1,
    to: skip + shown,
    total,
    hasPrevious: page > 1,
    hasNext: hasMore,
    lastPage: total === null ? null : Math.max(1, Math.ceil(total / pageSize))
  };
}

/**
 * 编辑框里按 Tab：在光标处插两个空格（有选区就替换掉选区），返回新文字与光标位置。
 * 缩进写法是两格一层，Tab 把焦点移出编辑框只会打断在写的文档
 */
export function indentOnTab(
  text: string,
  selectionStart: number,
  selectionEnd: number
): { text: string; caret: number } {
  const indent = '  ';
  return {
    text: text.slice(0, selectionStart) + indent + text.slice(selectionEnd),
    caret: selectionStart + indent.length
  };
}
