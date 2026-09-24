import { describe, expect, it } from 'vitest';
import type { ColumnInfo } from '../contracts';
import type { CellInput } from './cellInput';
import {
  buildDeleteStatement,
  buildInsertStatement,
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

const value = (v: string | number | boolean): CellInput => ({ kind: 'value', value: v });

const COMPOSITE: RowKey = {
  columns: ['tenant', 'sku'],
  values: { tenant: 'acme', sku: 'A-1' }
};

describe('buildUpdateStatement', () => {
  it('复合键的全部键列都进 WHERE', () => {
    // 只拼第一列会命中所有 tenant 相同的行——语法正确、执行成功、改了一批
    const statement = buildUpdateStatement(target('mysql'), COMPOSITE, { qty: value(2) });
    expect(statement.sql).toBe(
      'UPDATE `orders` SET `qty` = ? WHERE `tenant` = ? AND `sku` = ?'
    );
    expect(statement.params).toEqual([2, 'acme', 'A-1']);
  });

  it('PostgreSQL 的 $n 按语句里出现的次序编号', () => {
    // SET 在 WHERE 前面，编号错位后的语句仍然语法正确，只是改错了行
    const statement = buildUpdateStatement(target('postgresql', 'shop'), COMPOSITE, { qty: value(2), note: value('hi') });
    expect(statement.sql).toBe(
      'UPDATE "shop"."orders" SET "qty" = $1::int, "note" = $2 WHERE "tenant" = $3 AND "sku" = $4'
    );
    expect(statement.params).toEqual([2, 'hi', 'acme', 'A-1']);
  });

  it('数值键内联成不带引号的字面量，不走绑定', () => {
    // MySQL 比较字符串和数字时两边都转 DOUBLE，>2^53 的 BIGINT 会和邻近的值比成相等
    const statement = buildUpdateStatement(
      target('mysql'),
      { columns: ['big'], values: { big: '9007199254740993' } },
      { note: value('x') }
    );
    expect(statement.sql).toBe('UPDATE `orders` SET `note` = ? WHERE `big` = 9007199254740993');
    expect(statement.params).toEqual(['x']);
  });

  it('数值列上的非数字仍然绑定，不硬塞进语句', () => {
    const statement = buildUpdateStatement(
      target('mysql'),
      { columns: ['qty'], values: { qty: "1 OR 1=1" } },
      { note: value('x') }
    );
    expect(statement.sql).toBe('UPDATE `orders` SET `note` = ? WHERE `qty` = ?');
    expect(statement.params).toEqual(['x', '1 OR 1=1']);
  });

  it('赋值一律绑定，哪怕是数值列', () => {
    // 赋值是转换不是比较，字符串转整数是精确的；绑定还省掉一层转义
    const statement = buildUpdateStatement(target('mysql'), COMPOSITE, { qty: value('42') });
    expect(statement.params[0]).toBe('42');
  });

  it('键值是 NULL 时报错，不拼成一条定位不到行的条件', () => {
    // SQLite 的非 INTEGER 主键列允许存 NULL，`= NULL` 一行都匹配不到
    expect(() =>
      buildUpdateStatement(target('sqlite'), { columns: ['tenant'], values: { tenant: null } }, { qty: value(1) })
    ).toThrow(/tenant/);
  });

  it('没有键列时报错', () => {
    expect(() => buildUpdateStatement(target('mysql'), { columns: [], values: {} }, { qty: value(1) }))
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
    const statement = buildUpdateStatement(target('mysql'), COMPOSITE, { note: value("it's") });
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

describe('buildInsertStatement', () => {
  it('省掉「未填写」与「默认值」的列，让数据库套用它自己的默认值', () => {
    // 不写成 VALUES (DEFAULT, ...)：SQLite 不认这个关键字
    const statement = buildInsertStatement(target('sqlite'), {
      tenant: value('acme'),
      sku: { kind: 'default' },
      qty: { kind: 'unset' },
      note: { kind: 'null' }
    });
    expect(statement.sql).toBe('INSERT INTO "orders" ("tenant", "note") VALUES (?, ?)');
    expect(statement.params).toEqual(['acme', null]);
  });

  it('空字符串是一个值，不是「没填」', () => {
    const statement = buildInsertStatement(target('mysql'), { note: value('') });
    expect(statement.sql).toBe('INSERT INTO `orders` (`note`) VALUES (?)');
    expect(statement.params).toEqual(['']);
  });

  it('表达式原样进语句，不当成字面量绑定', () => {
    // 绑定进去存下的是 "CURRENT_TIMESTAMP" 这串字符本身
    const statement = buildInsertStatement(target('mysql'), {
      note: { kind: 'expression', sql: 'CURRENT_TIMESTAMP' },
      tenant: value('acme')
    });
    expect(statement.sql).toBe(
      'INSERT INTO `orders` (`note`, `tenant`) VALUES (CURRENT_TIMESTAMP, ?)'
    );
    expect(statement.params).toEqual(['acme']);
  });

  it('PostgreSQL 的 $n 跳过不占位的表达式', () => {
    const statement = buildInsertStatement(target('postgresql'), {
      note: { kind: 'expression', sql: 'now()' },
      tenant: value('acme'),
      sku: value('A-1')
    });
    expect(statement.sql).toBe(
      'INSERT INTO "orders" ("note", "tenant", "sku") VALUES (now(), $1, $2)'
    );
  });

  it('一列都没有可写时报错', () => {
    expect(() => buildInsertStatement(target('mysql'), { note: { kind: 'unset' } })).toThrow();
  });
});

describe('更新时的几种写入方式', () => {
  it('NULL 与空字符串是两条不同的语句', () => {
    const asNull = buildUpdateStatement(target('mysql'), COMPOSITE, { note: { kind: 'null' } });
    const asEmpty = buildUpdateStatement(target('mysql'), COMPOSITE, { note: value('') });
    expect(asNull.params[0]).toBeNull();
    expect(asEmpty.params[0]).toBe('');
  });

  it('未填写的列不进 SET', () => {
    const statement = buildUpdateStatement(target('mysql'), COMPOSITE, {
      note: value('x'),
      qty: { kind: 'unset' }
    });
    expect(statement.sql).not.toContain('`qty`');
  });

  it('全是未填写时报错，不发一条 SET 为空的语句', () => {
    expect(() => buildUpdateStatement(target('mysql'), COMPOSITE, { note: { kind: 'unset' } }))
      .toThrow();
  });

  it('默认值写成 DEFAULT，不占参数位', () => {
    const statement = buildUpdateStatement(target('postgresql'), COMPOSITE, {
      note: { kind: 'default' },
      qty: value(1)
    });
    expect(statement.sql).toBe(
      'UPDATE "orders" SET "note" = DEFAULT, "qty" = $1::int WHERE "tenant" = $2 AND "sku" = $3'
    );
  });

  it('SQLite 的 UPDATE 不支持 DEFAULT，点名报错而不是拼一条跑不通的语句', () => {
    expect(() => buildUpdateStatement(target('sqlite'), COMPOSITE, { note: { kind: 'default' } }))
      .toThrow();
  });
});

describe('并发冲突守卫', () => {
  const GUARDED = [
    column('id', 'int'),
    column('name', 'varchar(32)'),
    column('score', 'real'),
    column('avatar', 'bytea'),
    column('meta', 'jsonb'),
    column('shape', 'point')
  ];
  const guardTarget: TableTarget = {
    schema: null, table: 'u', columns: GUARDED, dialect: 'postgresql'
  };
  const idKey: RowKey = { columns: ['id'], values: { id: 1 } };
  const original = { id: 1, name: 'a', score: 1.1, avatar: 'deadbeef', meta: '{}', shape: '(1,2)' };

  it('把原值拼进同一条 WHERE，而不是先 SELECT 回来比一遍', () => {
    // 分两步之间仍然有窗口，而且多一次往返
    const statement = buildUpdateStatement(
      guardTarget, idKey, { name: value('b') }, { values: original }
    );
    expect(statement.sql).toBe(
      'UPDATE "u" SET "name" = $1 WHERE "id" = 1 AND "name" = $2'
    );
    expect(statement.params).toEqual(['b', 'a']);
  });

  it('只比正在写的那几列', () => {
    // 别人改了同一行的另一列（比如某个 last_seen）不该让这次保存失败
    const statement = buildUpdateStatement(
      guardTarget, idKey, { name: value('b') }, { values: original }
    );
    expect(statement.sql).not.toContain('"score"');
  });

  it('原值是 NULL 时用 IS NULL——`= NULL` 一行也匹配不上', () => {
    const statement = buildUpdateStatement(
      guardTarget, idKey, { name: value('b') }, { values: { ...original, name: null } }
    );
    expect(statement.sql).toContain('"name" IS NULL');
  });

  it.each([
    ['二进制', 'avatar'],
    ['近似浮点', 'score'],
    ['JSON', 'meta'],
    ['认不出的类型', 'shape']
  ])('%s 不参与比较——比不准的结果不是多报一次冲突，而是每次都报', (_label, columnName) => {
    const statement = buildUpdateStatement(
      guardTarget, idKey, { [columnName]: value('x') }, { values: original }
    );
    // WHERE 里只剩主键，那一列没有被拿去比
    expect(statement.sql.split(' WHERE ')[1]).toBe('"id" = 1');
  });

  it('删除比整行，跳过键列', () => {
    const statement = buildDeleteStatement(guardTarget, idKey, { values: original });
    expect(statement.sql).toBe('DELETE FROM "u" WHERE "id" = 1 AND "name" = $1');
  });

  it('不给守卫时就只按键定位，和以前一样', () => {
    expect(buildDeleteStatement(guardTarget, idKey).sql).toBe('DELETE FROM "u" WHERE "id" = 1');
  });
});

describe('SQL Server', () => {
  const SQL_SERVER_COLUMNS = [
    column('id', 'int'),
    column('name', 'nvarchar(32)'),
    column('body', 'text'),
    column('at', 'time(7)'),
    column('flag', 'bit'),
    column('photo', 'varbinary(max)')
  ];
  const sqlServer: TableTarget = {
    schema: 'dbo', table: 'u', columns: SQL_SERVER_COLUMNS, dialect: 'sqlserver'
  };
  const idKey: RowKey = { columns: ['id'], values: { id: 1 } };

  it('占位符是按次序编号的 @Pn', () => {
    const statement = buildUpdateStatement(sqlServer, idKey, { name: value('b'), flag: value(true) });
    expect(statement.sql).toBe('UPDATE [dbo].[u] SET [name] = @P1, [flag] = @P2 WHERE [id] = 1');
    expect(statement.params).toEqual(['b', true]);
  });

  it('置空写成字面的 NULL：带类型的空参数转不成 varbinary', () => {
    const statement = buildUpdateStatement(sqlServer, idKey, { photo: { kind: 'null' } });
    expect(statement.sql).toBe('UPDATE [dbo].[u] SET [photo] = NULL WHERE [id] = 1');
    expect(statement.params).toEqual([]);
  });

  it('text 不能拿 = 比、time(7) 读回来比不上，这两类不进并发守卫', () => {
    const original = { id: 1, name: 'a', body: 'long', at: '10:00:00.1234567', flag: true };
    const statement = buildDeleteStatement(sqlServer, idKey, { values: original });
    expect(statement.sql).toBe('DELETE FROM [dbo].[u] WHERE [id] = 1 AND [name] = @P1 AND [flag] = @P2');
    expect(statement.params).toEqual(['a', true]);
  });

  it('展示时布尔写成 1 / 0，参数按 @Pn 填回', () => {
    const statement = buildUpdateStatement(sqlServer, idKey, { name: value("O'x"), flag: value(false) });
    expect(renderStatementForDisplay(statement, 'sqlserver'))
      .toBe("UPDATE [dbo].[u] SET [name] = N'O''x', [flag] = 0 WHERE [id] = 1");
  });
});

describe('Oracle', () => {
  const ORACLE_COLUMNS = [
    column('ID', 'NUMBER(10)'),
    column('NAME', 'VARCHAR2(20 CHAR)'),
    column('BODY', 'CLOB'),
    column('AT', 'TIMESTAMP(3) WITH TIME ZONE'),
    column('SCORE', 'BINARY_DOUBLE')
  ];
  const oracle: TableTarget = { schema: 'APP', table: 'T', columns: ORACLE_COLUMNS, dialect: 'oracle' };
  const idKey: RowKey = { columns: ['ID'], values: { ID: 7 } };

  it('占位符是按位置编号的 :n，LOB 与浮点不进并发守卫', () => {
    const original = { ID: 7, NAME: 'a', BODY: 'long', AT: '2026-09-20 07:04:05.123 +08:00', SCORE: 1.5 };
    const statement = buildDeleteStatement(oracle, idKey, { values: original });
    expect(statement.sql).toBe('DELETE FROM "APP"."T" WHERE "ID" = 7 AND "NAME" = :1 AND "AT" = :2');
    expect(statement.params).toEqual(['a', '2026-09-20 07:04:05.123 +08:00']);
  });

  it('展示时按 :n 填回', () => {
    const statement = buildUpdateStatement(oracle, idKey, { NAME: value("O'x") });
    expect(renderStatementForDisplay(statement, 'oracle'))
      .toBe(`UPDATE "APP"."T" SET "NAME" = 'O''x' WHERE "ID" = 7`);
  });
});

describe('PostgreSQL 的参数按列的声明类型转换', () => {
  // 回归：表格里改 jsonb 格子报「column "doc" is of type jsonb but expression is of type text」
  const pgTarget: TableTarget = {
    schema: 'reg',
    table: 't',
    dialect: 'postgresql',
    columns: [
      column('id', 'integer'),
      column('doc', 'jsonb'),
      column('seen_at', 'timestamp with time zone'),
      column('tags', 'text[]'),
      column('title', 'character varying(100)')
    ]
  };
  const key: RowKey = { columns: ['id'], values: { id: 1 } };

  it('jsonb、时间戳、数组的赋值带上 ::类型', () => {
    const statement = buildUpdateStatement(pgTarget, key, {
      doc: value('{"a":2}'),
      seen_at: value('2026-09-24 08:00:00+00'),
      tags: value('{x,y}')
    });
    expect(statement.sql).toBe(
      'UPDATE "reg"."t" SET "doc" = $1::jsonb, "seen_at" = $2::timestamp with time zone, "tags" = $3::text[] WHERE "id" = 1'
    );
  });

  it('插入和置空也带；文本列不带，免得预览里满是 ::varchar', () => {
    const statement = buildInsertStatement(pgTarget, {
      doc: { kind: 'null' },
      title: value('x')
    });
    expect(statement.sql).toBe('INSERT INTO "reg"."t" ("doc", "title") VALUES ($1::jsonb, $2)');
  });

  it('别的方言不转', () => {
    const statement = buildUpdateStatement({ ...pgTarget, dialect: 'mysql' }, key, { doc: value('{}') });
    expect(statement.sql).toBe('UPDATE `reg`.`t` SET `doc` = ? WHERE `id` = 1');
  });
});
