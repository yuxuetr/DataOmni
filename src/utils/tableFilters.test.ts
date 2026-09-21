import { describe, expect, it } from 'vitest';
import type { ColumnInfo } from '../contracts';
import { buildFilterClause, isCompleteFilter, type ColumnFilter } from './tableFilters';

function column(name: string, dataType = 'text'): ColumnInfo {
  return { name, data_type: dataType, is_nullable: true, is_primary_key: false };
}

const COLUMNS = [column('name'), column('id', 'bigint'), column('note'), column('span', 'interval')];

function filter(overrides: Partial<ColumnFilter>): ColumnFilter {
  return { id: 'f1', column: 'name', operator: 'eq', value: '', ...overrides };
}

describe('isCompleteFilter', () => {
  it('值还空着的条件不算填完', () => {
    // 选完列还没开始打字时，表不能先空掉一次
    expect(isCompleteFilter(filter({ operator: 'eq', value: '' }))).toBe(false);
    expect(isCompleteFilter(filter({ operator: 'eq', value: 'a' }))).toBe(true);
  });

  it('IS NULL 类不需要值', () => {
    expect(isCompleteFilter(filter({ operator: 'is-null', value: '' }))).toBe(true);
  });

  it('没选列就不算', () => {
    expect(isCompleteFilter(filter({ column: '', operator: 'is-null' }))).toBe(false);
  });
});

describe('buildFilterClause', () => {
  it('没有条件时返回空串，不返回一个空的 WHERE', () => {
    expect(buildFilterClause([], COLUMNS, 'postgresql')).toBe('');
    expect(buildFilterClause([filter({ value: '' })], COLUMNS, 'postgresql')).toBe('');
  });

  it('多条之间用 AND', () => {
    const clause = buildFilterClause(
      [
        filter({ id: 'a', column: 'name', operator: 'eq', value: 'ann' }),
        filter({ id: 'b', column: 'note', operator: 'is-not-null' })
      ],
      COLUMNS,
      'postgresql'
    );
    expect(clause).toBe(`WHERE "name" = 'ann' AND "note" IS NOT NULL`);
  });

  it('列名和值都被引用，撇号不会把语句拆断', () => {
    const clause = buildFilterClause(
      [filter({ column: 'name', operator: 'eq', value: "O'Brien" })],
      COLUMNS,
      'mysql'
    );
    expect(clause).toBe("WHERE `name` = 'O''Brien'");
  });

  it('LIKE 里的通配符被转义成字面字符', () => {
    // 不转义的话，搜 `100%` 会搜到所有 100 开头的值，而且不会报错
    const clause = buildFilterClause(
      [filter({ column: 'note', operator: 'contains', value: '100%' })],
      COLUMNS,
      'postgresql'
    );
    expect(clause).toBe(`WHERE "note" LIKE '%100!%%' ESCAPE '!'`);
  });

  it('starts-with 与 ends-with 把通配符放在对应的一端', () => {
    expect(
      buildFilterClause([filter({ column: 'note', operator: 'starts-with', value: 'ab' })], COLUMNS, 'sqlite')
    ).toBe(`WHERE "note" LIKE 'ab%' ESCAPE '!'`);
    expect(
      buildFilterClause([filter({ column: 'note', operator: 'ends-with', value: 'ab' })], COLUMNS, 'sqlite')
    ).toBe(`WHERE "note" LIKE '%ab' ESCAPE '!'`);
  });

  it('数值列上的数字不加引号', () => {
    // MySQL 拿字符串和数字比较时会把两边都转成 DOUBLE，
    // 超过 2^53 的 BIGINT 会和邻近几个值比成相等，筛出来的行是错的而语句不报错
    expect(
      buildFilterClause(
        [filter({ column: 'id', operator: 'gt', value: '9223372036854775806' })],
        COLUMNS,
        'mysql'
      )
    ).toBe('WHERE `id` > 9223372036854775806');
  });

  it('文本列上的数字仍然加引号', () => {
    // '007' 和 7 不是一回事
    expect(
      buildFilterClause([filter({ column: 'name', operator: 'eq', value: '007' })], COLUMNS, 'mysql')
    ).toBe("WHERE `name` = '007'");
  });

  it('数值列上填了非数字时退回字符串字面量', () => {
    // 让数据库去报那句「invalid input syntax」，而不是拼出一个裸的 abc
    expect(
      buildFilterClause([filter({ column: 'id', operator: 'eq', value: 'abc' })], COLUMNS, 'postgresql')
    ).toBe(`WHERE "id" = 'abc'`);
  });

  it('interval 不因为含有 int 被当成数值列', () => {
    expect(
      buildFilterClause([filter({ column: 'span', operator: 'eq', value: '3' })], COLUMNS, 'postgresql')
    ).toBe(`WHERE "span" = '3'`);
  });

  it('丢掉引用不到的列', () => {
    // 切换表之后旧条件还留在 state 里，拿去拼只会得到一句「加载失败」
    expect(
      buildFilterClause([filter({ column: 'gone', operator: 'eq', value: 'x' })], COLUMNS, 'postgresql')
    ).toBe('');
  });

  it('MySQL 的反斜杠在 LIKE 模式里也只转义一层', () => {
    // 转义符选 `!` 而不是 `\` 就是为了避开字面量层与 LIKE 层的双重转义
    expect(
      buildFilterClause(
        [filter({ column: 'note', operator: 'contains', value: 'C:\\temp' })],
        COLUMNS,
        'mysql'
      )
    ).toBe("WHERE `note` LIKE '%C:\\\\temp%' ESCAPE '!'");
  });
});
