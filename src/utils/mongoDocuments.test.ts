import { describe, expect, it } from 'vitest';
import {
  mongoColumnAlignment,
  mongoColumns,
  mongoPageRange,
  type MongoCell,
  type MongoDocumentRow
} from './mongoDocuments';

const cell = (kind: MongoCell['kind'], text: string): MongoCell => ({ kind, text, truncated: false });

const row = (fields: Record<string, MongoCell>): MongoDocumentRow => ({
  id: fields._id?.text ?? null,
  fields
});

describe('MongoDB 文档排成网格', () => {
  it('列是所有文档字段的并集，_id 在前，其余按第一次出现的顺序', () => {
    const documents = [
      row({ name: cell('string', "'bob'"), _id: cell('int', '1') }),
      row({ _id: cell('int', '2'), age: cell('int', '3'), name: cell('string', "'c'") }),
      row({ _id: cell('int', '3'), nick: cell('null', 'null') })
    ];
    // 反向：只取第一个文档的字段就看不见 age 与 nick
    expect(mongoColumns(documents)).toEqual(['_id', 'name', 'age', 'nick']);
  });

  it('没有 _id 的结果（视图）照常出列', () => {
    expect(mongoColumns([row({ total: cell('int', '3') })])).toEqual(['total']);
    expect(mongoColumns([])).toEqual([]);
  });

  it('数值列靠右；缺字段和 null 不表态，出现一个字符串就整列靠左', () => {
    const documents = [
      row({ _id: cell('objectId', "ObjectId('a')"), n: cell('long', "Long('1')") }),
      row({ _id: cell('objectId', "ObjectId('b')"), n: cell('null', 'null') }),
      row({ _id: cell('objectId', "ObjectId('c')") })
    ];
    expect(mongoColumnAlignment(documents, 'n')).toBe('right');
    expect(mongoColumnAlignment(documents, '_id')).toBe('left');
    const mixed = [...documents, row({ n: cell('string', "'x'") })];
    expect(mongoColumnAlignment(mixed, 'n')).toBe('left');
    // 整列都缺：靠左
    expect(mongoColumnAlignment(documents, 'missing')).toBe('left');
  });
});

describe('MongoDB 分页区间', () => {
  it('总数知道时给出末页', () => {
    expect(mongoPageRange(2, 50, 50, true, 120)).toEqual({
      from: 51,
      to: 100,
      total: 120,
      hasPrevious: true,
      hasNext: true,
      lastPage: 3
    });
  });

  it('总数还没回来（或数失败了）时，下一页只看 hasMore，不编一个末页', () => {
    const range = mongoPageRange(1, 25, 25, true, null);
    expect(range.lastPage).toBeNull();
    expect(range.hasNext).toBe(true);
    expect(range.hasPrevious).toBe(false);
  });

  it('空结果是 0–0，不是 1–0', () => {
    expect(mongoPageRange(1, 25, 0, false, 0)).toMatchObject({ from: 0, to: 0, lastPage: 1 });
  });
});
