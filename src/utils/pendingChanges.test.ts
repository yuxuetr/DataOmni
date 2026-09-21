import { describe, expect, it } from 'vitest';
import type { ColumnInfo } from '../contracts';
import type { CellInput } from './cellInput';
import type { RowKey, TableTarget } from './rowStatements';
import {
  changedColumns,
  pendingForRow,
  pendingStatements,
  revertChange,
  rowIdOf,
  stageDelete,
  stageInsert,
  stageUpdate,
  type PendingChange
} from './pendingChanges';

const value = (v: string | number): CellInput => ({ kind: 'value', value: v });
const key = (id: number): RowKey => ({ columns: ['id'], values: { id } });
const ORIGINAL = { id: 1, name: 'a', note: 'n' };

const COLUMNS: ColumnInfo[] = [
  { name: 'id', data_type: 'int', is_nullable: false, is_primary_key: true },
  { name: 'name', data_type: 'text', is_nullable: true, is_primary_key: false },
  { name: 'note', data_type: 'text', is_nullable: true, is_primary_key: false }
];
const TARGET: TableTarget = { schema: null, table: 't', columns: COLUMNS, dialect: 'sqlite' };

describe('rowIdOf', () => {
  it('按键值认人，不按行在页面上的位置', () => {
    // 翻页、排序、筛选之后同一个下标是另一行，而待提交的改动跨得过这些操作
    expect(rowIdOf(key(1))).toBe(rowIdOf({ columns: ['id'], values: { id: 1 } }));
    expect(rowIdOf(key(1))).not.toBe(rowIdOf(key(2)));
  });

  it('复合键按键内次序算，不按对象字面量的书写次序', () => {
    const left: RowKey = { columns: ['a', 'b'], values: { a: 1, b: 2 } };
    const right: RowKey = { columns: ['a', 'b'], values: { b: 2, a: 1 } };
    expect(rowIdOf(left)).toBe(rowIdOf(right));
  });
});

describe('stageUpdate', () => {
  it('记下改过的列', () => {
    const changes = stageUpdate([], key(1), ORIGINAL, { name: value('b') }, 'c1');
    expect(changes).toHaveLength(1);
    expect(changedColumns(changes[0])).toEqual(['name']);
  });

  it('同一行的多次编辑合并成一条', () => {
    // 否则「待提交 3 项」里是同一行的三次涂改，而提交时只有最后一次算数
    let changes = stageUpdate([], key(1), ORIGINAL, { name: value('b') }, 'c1');
    changes = stageUpdate(changes, key(1), ORIGINAL, { note: value('m') }, 'c2');
    expect(changes).toHaveLength(1);
    expect(changes[0].id).toBe('c1');
    expect(changedColumns(changes[0]).sort()).toEqual(['name', 'note']);
  });

  it('改回原值的列自动退出', () => {
    let changes = stageUpdate([], key(1), ORIGINAL, { name: value('b') }, 'c1');
    changes = stageUpdate(changes, key(1), ORIGINAL, { name: value('a') }, 'c2');
    expect(changes).toEqual([]);
  });

  it('两行各记一条', () => {
    let changes = stageUpdate([], key(1), ORIGINAL, { name: value('b') }, 'c1');
    changes = stageUpdate(changes, key(2), { id: 2, name: 'x' }, { name: value('y') }, 'c2');
    expect(changes).toHaveLength(2);
  });

  it('已经排了删除的行不再接受编辑', () => {
    const changes = stageDelete([], key(1), ORIGINAL, 'd1');
    expect(stageUpdate(changes, key(1), ORIGINAL, { name: value('b') }, 'c1')).toEqual(changes);
  });
});

describe('stageDelete', () => {
  it('删除盖过同一行上待提交的编辑', () => {
    // 改完再删，那次编辑不必发出去
    let changes = stageUpdate([], key(1), ORIGINAL, { name: value('b') }, 'c1');
    changes = stageDelete(changes, key(1), ORIGINAL, 'd1');
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe('delete');
  });

  it('重复删除同一行不叠加', () => {
    const once = stageDelete([], key(1), ORIGINAL, 'd1');
    expect(stageDelete(once, key(1), ORIGINAL, 'd2')).toHaveLength(1);
  });
});

describe('stageInsert 与撤销', () => {
  it('每次新增各算一条——它们没有键，谈不上合并', () => {
    let changes = stageInsert([], { name: value('a') }, 'i1');
    changes = stageInsert(changes, { name: value('a') }, 'i2');
    expect(changes).toHaveLength(2);
  });

  it('逐项撤销只去掉那一条', () => {
    let changes = stageInsert([], { name: value('a') }, 'i1');
    changes = stageUpdate(changes, key(1), ORIGINAL, { name: value('b') }, 'c1');
    expect(revertChange(changes, 'i1').map((change) => change.id)).toEqual(['c1']);
  });
});

describe('pendingForRow', () => {
  it('找得到这一行上待提交的那条', () => {
    const changes = stageUpdate([], key(1), ORIGINAL, { name: value('b') }, 'c1');
    expect(pendingForRow(changes, rowIdOf(key(1)))?.id).toBe('c1');
    expect(pendingForRow(changes, rowIdOf(key(2)))).toBeUndefined();
  });

  it('新增没有行身份，不会被认成某一行的改动', () => {
    const changes = stageInsert([], { name: value('a') }, 'i1');
    expect(pendingForRow(changes, rowIdOf(key(1)))).toBeUndefined();
  });
});

describe('pendingStatements', () => {
  it('按 staged 的次序生成语句，每条都要求恰好影响一行', () => {
    const changes: PendingChange[] = stageDelete(
      stageUpdate(
        stageInsert([], { name: value('n') }, 'i1'),
        key(1), ORIGINAL, { name: value('b') }, 'c1'
      ),
      key(2), { id: 2, name: 'z', note: null }, 'd1'
    );

    const statements = pendingStatements(changes, TARGET);
    expect(statements.map((statement) => statement.sql)).toEqual([
      'INSERT INTO "t" ("name") VALUES (?)',
      // 更新只比正在写的那一列
      'UPDATE "t" SET "name" = ? WHERE "id" = 1 AND "name" = ?',
      // 删除比整行——它不可逆，承诺的是「要删的还是我看到的那一行」
      'DELETE FROM "t" WHERE "id" = 2 AND "name" = ? AND "note" IS NULL'
    ]);
    expect(statements.every((statement) => statement.expectRows === 1)).toBe(true);
  });

  it('原值用的是加载时那一份，不是改完之后的', () => {
    // 比错了等于没比：拿新值去比，条件永远成立，丢失更新照样发生
    const changes = stageUpdate([], key(1), ORIGINAL, { name: value('b') }, 'c1');
    expect(pendingStatements(changes, TARGET)[0].params).toEqual(['b', 'a']);
  });
});
