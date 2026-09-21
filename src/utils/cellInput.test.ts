import { describe, expect, it } from 'vitest';
import {
  cellInputFromValue,
  isUnchangedInput,
  missingRequiredColumns,
  type CellInput
} from './cellInput';

describe('cellInputFromValue', () => {
  it('NULL 回到 null 档，不变成空文本', () => {
    // 否则打开编辑框再直接关掉，就把一个 NULL 变成了空字符串
    expect(cellInputFromValue(null)).toEqual({ kind: 'null' });
  });

  it('空字符串留在 value 档', () => {
    expect(cellInputFromValue('')).toEqual({ kind: 'value', value: '' });
  });

  it('数字与布尔原样带过去，不转成文本', () => {
    expect(cellInputFromValue(0)).toEqual({ kind: 'value', value: 0 });
    expect(cellInputFromValue(false)).toEqual({ kind: 'value', value: false });
  });
});

describe('isUnchangedInput', () => {
  it('没碰过的列算没变', () => {
    expect(isUnchangedInput({ kind: 'unset' }, 'a')).toBe(true);
  });

  it('本来就是 NULL 又选了 NULL 算没变', () => {
    expect(isUnchangedInput({ kind: 'null' }, null)).toBe(true);
    expect(isUnchangedInput({ kind: 'null' }, '')).toBe(false);
  });

  it('把 NULL 改成空字符串算变了', () => {
    // 这两者在 `IS NULL` / `= ''` 下是两个不同的条件
    expect(isUnchangedInput({ kind: 'value', value: '' }, null)).toBe(false);
  });

  it('同值不算变', () => {
    // MySQL 对「新值等于旧值」的 UPDATE 返回 0 affected rows，而 0 正是
    // 「一行都没匹配上」的信号
    expect(isUnchangedInput({ kind: 'value', value: 'a' }, 'a')).toBe(true);
    expect(isUnchangedInput({ kind: 'value', value: 'b' }, 'a')).toBe(false);
  });

  it('默认值与表达式一律算变了——结果由数据库决定，这里算不出来', () => {
    expect(isUnchangedInput({ kind: 'default' }, 'a')).toBe(false);
    expect(isUnchangedInput({ kind: 'expression', sql: 'now()' }, 'a')).toBe(false);
  });
});

describe('missingRequiredColumns', () => {
  const columns = [
    { name: 'id', is_nullable: false, default_value: 'nextval(...)' },
    { name: 'name', is_nullable: false },
    { name: 'note', is_nullable: true }
  ];

  it('点名非空、没有默认值、又没填的列', () => {
    const inputs: Record<string, CellInput> = {
      id: { kind: 'default' },
      name: { kind: 'unset' },
      note: { kind: 'null' }
    };
    expect(missingRequiredColumns(inputs, columns)).toEqual(['name']);
  });

  it('在没有默认值的非空列上选「默认值」同样算没填', () => {
    expect(missingRequiredColumns({ name: { kind: 'default' } }, columns)).toEqual(['name']);
  });

  it('填了就不点名，空字符串也算填了', () => {
    expect(missingRequiredColumns({ name: { kind: 'value', value: '' } }, columns)).toEqual([]);
  });
});
