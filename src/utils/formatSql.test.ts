import { describe, expect, it } from 'vitest';
import { DatabaseType } from '../contracts/connection';
import { cursorAfterFormat, formatSql, planFormat, sqlFormatterLanguage } from './formatSql';

/**
 * 去掉所有空白再比。
 *
 * 排版会改的只有空白与关键字大小写，所以这样比对能抓住「内容被改没了」——
 * 丢注释、吃掉字符串里的字符、漏掉一整个子句。
 * 盲区：它区分不了 `a b` 变成 `ab`。真正担心的是内容丢失，不是粘连。
 */
const bare = (sql: string) => sql.replace(/\s+/g, '').toLowerCase();

const expectContentPreserved = (input: string, dbType: DatabaseType) => {
  const language = sqlFormatterLanguage(dbType);
  if (!language) {
    throw new Error(`${dbType} 应当支持格式化`);
  }
  const result = formatSql(input, language);
  expect(result.ok, `${dbType} 上格式化失败: ${result.ok ? '' : result.message}`).toBe(true);
  if (result.ok) {
    expect(bare(result.sql), `${dbType} 上内容被改动了`).toBe(bare(input));
  }
};

describe('sqlFormatterLanguage', () => {
  it('三种支持的方言各有对应', () => {
    expect(sqlFormatterLanguage(DatabaseType.MySQL)).toBe('mysql');
    expect(sqlFormatterLanguage(DatabaseType.PostgreSQL)).toBe('postgresql');
    expect(sqlFormatterLanguage(DatabaseType.SQLite)).toBe('sqlite');
  });

  it('认不出的类型返回 null，不退回某个默认方言', () => {
    // 用错方言会直接抛解析错误，表现为「点一下格式化，弹个看不懂的错」
    expect(sqlFormatterLanguage(DatabaseType.MongoDB)).toBeNull();
  });
});

describe('formatSql', () => {
  it('把一行挤在一起的语句排开', () => {
    const result = formatSql('select id,name from users where id=1', 'postgresql');
    expect(result).toEqual({
      ok: true,
      sql: 'SELECT\n  id,\n  name\nFROM\n  users\nWHERE\n  id = 1'
    });
  });

  it('关键字统一成大写', () => {
    const result = formatSql('Select 1', 'sqlite');
    expect(result.ok && result.sql.startsWith('SELECT')).toBe(true);
  });

  it('多条语句之间空一行，分号保留', () => {
    const result = formatSql('select 1;select 2;', 'sqlite');
    expect(result.ok && result.sql).toBe('SELECT\n  1;\n\nSELECT\n  2;');
  });

  it('空白内容原样返回，不去撞解析器', () => {
    expect(formatSql('   \n ', 'mysql')).toEqual({ ok: true, sql: '   \n ' });
  });

  it('解析不了时只给错误，不给文本', () => {
    // 反引号标识符是 MySQL 的写法，PostgreSQL 解析不了
    const result = formatSql('SELECT `x` FROM t', 'postgresql');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 行号列号正是排查时要看的，不能换成「格式化失败」了事
      expect(result.message).toMatch(/line 1 column/);
    }
  });
});

describe('排版不改内容', () => {
  // 这一组才是这个功能的底线：格式化是个随手会按的动作，
  // 按下去之后编辑器里的东西必须还是原来那些东西。
  const CASES: Array<[string, string]> = [
    ['字符串里有分号和关键字', "SELECT 'a; from b' AS s, id FROM t"],
    ['字符串里有换行', "SELECT '第一行\n第二行' AS s"],
    ['行注释', 'SELECT id -- 为什么这么写\nFROM t'],
    ['块注释', 'SELECT /* 为什么这么写 */ id FROM t'],
    ['CJK 字面量', "SELECT '订单备注' AS note FROM t WHERE city = '北京'"],
    ['CTE 与 JOIN', 'with x as (select 1 as a) select * from x join y on x.a = y.a'],
    ['CASE 表达式', "select case when a > 1 then 'big' else 'small' end as c from t"],
    ['窗口函数', 'SELECT row_number() OVER (PARTITION BY a ORDER BY b) FROM t'],
    ['嵌套子查询', 'SELECT * FROM (SELECT * FROM (SELECT 1 AS a) i) o WHERE o.a = 1'],
    ['写了一半', 'select id from'],
    ['只有注释', '-- 待写'],
    ['UPDATE 与 DELETE', "UPDATE t SET a = 1, b = 'x' WHERE id = 2; DELETE FROM t WHERE id = 3;"]
  ];

  for (const [name, sql] of CASES) {
    it(`${name}（三种方言）`, () => {
      for (const dbType of [DatabaseType.MySQL, DatabaseType.PostgreSQL, DatabaseType.SQLite]) {
        expectContentPreserved(sql, dbType);
      }
    });
  }

  it('反引号标识符在 MySQL 上不丢', () => {
    expectContentPreserved('SELECT `订单备注` FROM `订单`', DatabaseType.MySQL);
  });

  it('双引号标识符在 PostgreSQL 上不丢', () => {
    expectContentPreserved('SELECT "订单备注" FROM "订单"', DatabaseType.PostgreSQL);
  });

  it('再排一次不会继续变（幂等）', () => {
    const once = formatSql('select id,name from users where id=1', 'postgresql');
    expect(once.ok).toBe(true);
    if (once.ok) {
      expect(formatSql(once.sql, 'postgresql')).toEqual(once);
    }
  });
});

describe('cursorAfterFormat', () => {
  const original = 'select 1;select 2;select 3;';
  const formatted = formatSql(original, 'sqlite');

  it('排版前在第几条语句，排版后还在第几条语句的开头', () => {
    expect(formatted.ok).toBe(true);
    if (!formatted.ok) {
      return;
    }
    // 光标在第二条 "select 2" 里
    const cursor = original.indexOf('select 2') + 3;
    const mapped = cursorAfterFormat(original, formatted.sql, cursor);
    expect(formatted.sql.slice(mapped)).toBe('SELECT\n  2;\n\nSELECT\n  3;');
  });

  it('光标在第一条时不会被扔到文档末尾', () => {
    // CodeMirror 默认把整份替换的光标映射到改动末尾，每按一次格式化
    // 视线就掉到最底下
    if (!formatted.ok) {
      return;
    }
    expect(cursorAfterFormat(original, formatted.sql, 2)).toBe(0);
  });

  it('语句数对不上时按偏移量夹取，不越界', () => {
    expect(cursorAfterFormat('', 'SELECT\n  1', 999)).toBe('SELECT\n  1'.length);
  });
});

describe('planFormat', () => {
  const doc = 'select 1;select 2;';

  it('没有选区时排整份', () => {
    const plan = planFormat(doc, { from: 3, to: 3, head: 3 }, 'sqlite');
    expect(plan).toMatchObject({ kind: 'replace', from: 0, to: doc.length });
    if (plan.kind === 'replace') {
      expect(plan.insert).toBe('SELECT\n  1;\n\nSELECT\n  2;');
      // 光标原本在第一条里，排完仍在第一条开头
      expect(plan.anchor).toBe(0);
      expect(plan.head).toBe(0);
    }
  });

  it('有选区时只排选区，其余一个字不动', () => {
    // 在一份长脚本里只想整理手头这一段时，这是唯一的做法
    const plan = planFormat(doc, { from: 9, to: doc.length, head: doc.length }, 'sqlite');
    expect(plan).toMatchObject({ kind: 'replace', from: 9, to: doc.length });
    if (plan.kind === 'replace') {
      expect(plan.insert).toBe('SELECT\n  2;');
      // 排完仍然选中它
      expect(plan.anchor).toBe(9);
      expect(plan.head).toBe(9 + plan.insert.length);
    }
  });

  it('已经排好的不产生改动', () => {
    // 否则白占一次撤销，光标还会跟着跳一下
    const formatted = 'SELECT\n  1;\n\nSELECT\n  2;';
    expect(
      planFormat(formatted, { from: 0, to: 0, head: 0 }, 'sqlite')
    ).toEqual({ kind: 'unchanged' });
  });

  it('解析不了时不产生任何改动', () => {
    const plan = planFormat('SELECT `x` FROM t', { from: 0, to: 0, head: 0 }, 'postgresql');
    expect(plan.kind).toBe('failed');
  });

  it('只排选区时，选区里解析不了也不动整份', () => {
    const plan = planFormat(
      "SELECT 1; SELECT 'unterminated",
      { from: 10, to: 29, head: 29 },
      'sqlite'
    );
    expect(plan.kind === 'failed' || plan.kind === 'unchanged').toBe(true);
  });
});
