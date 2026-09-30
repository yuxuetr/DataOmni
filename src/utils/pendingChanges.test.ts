import { describe, expect, it } from 'vitest';
import type { ColumnInfo } from '../contracts';
import type { CellInput } from './cellInput';
import type { RowKey, TableTarget } from './rowStatements';
import {
  canStageAnother,
  changedColumns,
  pendingCellInput,
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

describe('ClickHouse：一项改动是「数一遍 → 执行 → 核对」', () => {
  const CH_COLUMNS: ColumnInfo[] = [
    { name: 'id', data_type: 'UInt64', is_nullable: false, is_primary_key: true },
    { name: 'name', data_type: 'LowCardinality(String)', is_nullable: false, is_primary_key: false },
    { name: 'note', data_type: 'Nullable(String)', is_nullable: true, is_primary_key: false }
  ];
  const CH: TableTarget = { schema: 'db', table: 't', columns: CH_COLUMNS, dialect: 'clickhouse' };
  // 整行定位：键就是比得准的那几列
  const row = (values: Record<string, string | number | null>): RowKey => ({ columns: ['id', 'name', 'note'], values });

  it('改：执行前恰好一行，ALTER … UPDATE，改完按新值至少一行；执行那条不给期望值', () => {
    const changes = stageUpdate([], row({ id: 1, name: 'a', note: null }), { id: 1, name: 'a', note: null }, { name: value('b') }, 'c1');
    const statements = pendingStatements(changes, CH);
    expect(statements.map((statement) => [statement.sql, statement.expectRows])).toEqual([
      ['SELECT count() FROM `db`.`t` WHERE `id` = {p1:UInt64} AND `name` = {p2:LowCardinality(String)} AND `note` IS NULL', 1],
      ['ALTER TABLE `db`.`t` UPDATE `name` = {p1:LowCardinality(String)} WHERE `id` = {p2:UInt64} AND `name` = {p3:LowCardinality(String)} AND `note` IS NULL', undefined],
      ['SELECT toUInt64(count() >= 1) FROM `db`.`t` WHERE `id` = {p1:UInt64} AND `name` = {p2:LowCardinality(String)} AND `note` IS NULL', 1]
    ]);
    expect(statements.map((statement) => statement.params)).toEqual([[1, 'a'], ['b', 1, 'a'], [1, 'b']]);
  });

  // 打包版上撞到的：内联的 `-999999999999.0000000000`、超过 64 位的整数在 ClickHouse 里是 Float64，
  // 和 Decimal / Int128 列比不准——这一行改不了，Int128 上还会连相邻的值一起比中
  it('Decimal 与大整数也走带列类型的参数，不内联成字面量', () => {
    const columns: ColumnInfo[] = [
      { name: 'i128', data_type: 'Int128', is_nullable: false, is_primary_key: true },
      { name: 'dec', data_type: 'Decimal(38, 10)', is_nullable: false, is_primary_key: false }
    ];
    const target: TableTarget = { schema: 'db', table: 't', columns, dialect: 'clickhouse' };
    const values = { i128: '-170141183460469231731687303715884105727', dec: '-999999999999.0000000000' };
    const changes = stageDelete([], { columns: ['i128', 'dec'], values }, values, 'd1');
    const [count] = pendingStatements(changes, target);
    expect(count.sql).toBe('SELECT count() FROM `db`.`t` WHERE `i128` = {p1:Int128} AND `dec` = {p2:Decimal(38, 10)}');
    expect(count.params).toEqual(['-170141183460469231731687303715884105727', '-999999999999.0000000000']);
  });

  it('删：执行前恰好一行，DELETE，删完零行', () => {
    const changes = stageDelete([], row({ id: 2, name: 'z', note: 'n' }), { id: 2, name: 'z', note: 'n' }, 'd1');
    expect(pendingStatements(changes, CH).map((statement) => [statement.sql.split(' WHERE')[0], statement.expectRows])).toEqual([
      ['SELECT count() FROM `db`.`t`', 1],
      ['DELETE FROM `db`.`t`', undefined],
      ['SELECT count() FROM `db`.`t`', 0]
    ]);
  });

  it('新增：一条 INSERT，比写入行数', () => {
    const statements = pendingStatements(stageInsert([], { id: value(3), name: value('c') }, 'i1'), CH);
    expect(statements).toEqual([{
      sql: 'INSERT INTO `db`.`t` (`id`, `name`) VALUES ({p1:UInt64}, {p2:LowCardinality(String)})',
      params: [3, 'c'],
      expectRows: 1
    }]);
  });

  it('写成表达式的列新值算不出来，不进改完之后的那次核对', () => {
    const changes = stageUpdate([], row({ id: 1, name: 'a', note: 'x' }), { id: 1, name: 'a', note: 'x' }, { note: { kind: 'expression', sql: "concat(note, '!')" } }, 'c1');
    expect(pendingStatements(changes, CH)[2].sql)
      .toBe('SELECT toUInt64(count() >= 1) FROM `db`.`t` WHERE `id` = {p1:UInt64} AND `name` = {p2:LowCardinality(String)}');
  });

  it('一次只排一项：同一行接着改算同一项，别的行和新增都要先提交', () => {
    const one = stageUpdate([], row({ id: 1, name: 'a', note: null }), { id: 1, name: 'a', note: null }, { name: value('b') }, 'c1');
    const sameRow = rowIdOf(row({ id: 1, name: 'a', note: null }));
    expect(canStageAnother(one, sameRow, 'clickhouse')).toBe(true);
    expect(canStageAnother(one, rowIdOf(row({ id: 2, name: 'z', note: null })), 'clickhouse')).toBe(false);
    expect(canStageAnother(one, null, 'clickhouse')).toBe(false);
    expect(canStageAnother([], null, 'clickhouse')).toBe(true);
    expect(canStageAnother(one, null, 'mysql')).toBe(true);
  });
});

describe('pendingCellInput', () => {
  // 排了队的行只给撤销、不能再编辑，格子里要是还画着加载时的值，
  // 用户按下回车后就再也看不到自己改成了什么——只有打开预览才对得上
  it('改了的列显示排队的新值，没改的列与待删的行照旧', () => {
    const updated = stageUpdate([], key(1), ORIGINAL, { name: value('b'), note: { kind: 'null' } });
    const update = pendingForRow(updated, rowIdOf(key(1)));
    expect(pendingCellInput(update, 'name')).toEqual(value('b'));
    expect(pendingCellInput(update, 'note')).toEqual({ kind: 'null' });
    expect(pendingCellInput(update, 'id')).toBeUndefined();

    const deleted = pendingForRow(stageDelete([], key(1), ORIGINAL), rowIdOf(key(1)));
    expect(pendingCellInput(deleted, 'name')).toBeUndefined();
    expect(pendingCellInput(undefined, 'name')).toBeUndefined();
  });
});
