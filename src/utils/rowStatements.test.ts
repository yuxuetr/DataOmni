import { describe, expect, it } from 'vitest';
import type { ColumnInfo } from '../contracts';
import {
  buildDeleteStatement,
  buildUpdateStatement,
  renderStatementForDisplay,
  type RowKey,
  type TableTarget
} from './rowStatements';

function column(name: string, data_type = 'text'): ColumnInfo {
  return { name, data_type, is_nullable: true, is_primary_key: false };
}

const COLUMNS = [
  column('tenant', 'varchar(32)'),
  column('sku', 'varchar(32)'),
  column('qty', 'int'),
  column('note', 'text'),
  column('big', 'bigint')
];

function target(dialect: TableTarget['dialect'], schema: string | null = null): TableTarget {
  return { schema, table: 'orders', columns: COLUMNS, dialect };
}

const COMPOSITE: RowKey = {
  columns: ['tenant', 'sku'],
  values: { tenant: 'acme', sku: 'A-1' }
};

describe('buildUpdateStatement', () => {
  it('复合键的全部键列都进 WHERE', () => {
    // 只拼第一列会命中所有 tenant 相同的行——语法正确、执行成功、改了一批
    const statement = buildUpdateStatement(target('mysql'), COMPOSITE, { qty: 2 });
    expect(statement.sql).toBe(
      'UPDATE `orders` SET `qty` = ? WHERE `tenant` = ? AND `sku` = ?'
    );
    expect(statement.params).toEqual([2, 'acme', 'A-1']);
  });

  it('PostgreSQL 的 $n 按语句里出现的次序编号', () => {
    // SET 在 WHERE 前面，编号错位后的语句仍然语法正确，只是改错了行
    const statement = buildUpdateStatement(target('postgresql', 'shop'), COMPOSITE, {
      qty: 2,
      note: 'hi'
    });
    expect(statement.sql).toBe(
      'UPDATE "shop"."orders" SET "qty" = $1, "note" = $2 WHERE "tenant" = $3 AND "sku" = $4'
    );
    expect(statement.params).toEqual([2, 'hi', 'acme', 'A-1']);
  });

  it('数值键内联成不带引号的字面量，不走绑定', () => {
    // MySQL 比较字符串和数字时两边都转 DOUBLE，>2^53 的 BIGINT 会和邻近的值比成相等
    const statement = buildUpdateStatement(
      target('mysql'),
      { columns: ['big'], values: { big: '9007199254740993' } },
      { note: 'x' }
    );
    expect(statement.sql).toBe('UPDATE `orders` SET `note` = ? WHERE `big` = 9007199254740993');
    expect(statement.params).toEqual(['x']);
  });

  it('数值列上的非数字仍然绑定，不硬塞进语句', () => {
    const statement = buildUpdateStatement(
      target('mysql'),
      { columns: ['qty'], values: { qty: "1 OR 1=1" } },
      { note: 'x' }
    );
    expect(statement.sql).toBe('UPDATE `orders` SET `note` = ? WHERE `qty` = ?');
    expect(statement.params).toEqual(['x', '1 OR 1=1']);
  });

  it('赋值一律绑定，哪怕是数值列', () => {
    // 赋值是转换不是比较，字符串转整数是精确的；绑定还省掉一层转义
    const statement = buildUpdateStatement(target('mysql'), COMPOSITE, { qty: '42' });
    expect(statement.params[0]).toBe('42');
  });

  it('键值是 NULL 时报错，不拼成一条定位不到行的条件', () => {
    // SQLite 的非 INTEGER 主键列允许存 NULL，`= NULL` 一行都匹配不到
    expect(() =>
      buildUpdateStatement(target('sqlite'), { columns: ['tenant'], values: { tenant: null } }, { qty: 1 })
    ).toThrow(/tenant/);
  });

  it('没有键列时报错', () => {
    expect(() => buildUpdateStatement(target('mysql'), { columns: [], values: {} }, { qty: 1 }))
      .toThrow();
  });

  it('没有要写的列时报错，不发一条 SET 为空的语句', () => {
    expect(() => buildUpdateStatement(target('mysql'), COMPOSITE, {})).toThrow();
  });
});

describe('buildDeleteStatement', () => {
  it('复合键的全部键列都进 WHERE', () => {
    const statement = buildDeleteStatement(target('sqlite'), COMPOSITE);
    expect(statement.sql).toBe('DELETE FROM "orders" WHERE "tenant" = ? AND "sku" = ?');
    expect(statement.params).toEqual(['acme', 'A-1']);
  });

  it('带 schema 时限定表名', () => {
    expect(buildDeleteStatement(target('postgresql', 'shop'), COMPOSITE).sql).toBe(
      'DELETE FROM "shop"."orders" WHERE "tenant" = $1 AND "sku" = $2'
    );
  });
});

describe('renderStatementForDisplay', () => {
  it('把参数填回去，得到一条能直接读的语句', () => {
    const statement = buildUpdateStatement(target('mysql'), COMPOSITE, { note: "it's" });
    expect(renderStatementForDisplay(statement, 'mysql')).toBe(
      "UPDATE `orders` SET `note` = 'it''s' WHERE `tenant` = 'acme' AND `sku` = 'A-1'"
    );
  });

  it('NULL 与布尔不加引号', () => {
    expect(
      renderStatementForDisplay({ sql: 'UPDATE t SET a = ?, b = ?', params: [null, true] }, 'sqlite')
    ).toBe('UPDATE t SET a = NULL, b = TRUE');
  });
});
