import { describe, expect, it } from 'vitest';
import {
  binaryLiteral,
  columnEditorKind,
  databaseTextToPickerValue,
  isCompleteHex,
  normalizeHex,
  prettyJson,
  pickerValueToDatabaseText
} from './columnEditors';

describe('columnEditorKind', () => {
  it.each([
    ['boolean', 'boolean'],
    ['bool', 'boolean'],
    ['jsonb', 'json'],
    ['json', 'json'],
    ['bytea', 'binary'],
    ['varbinary(255)', 'binary'],
    ['longblob', 'binary'],
    ['date', 'date'],
    ['time without time zone', 'time'],
    ['timestamp with time zone', 'datetime'],
    ['datetime(6)', 'datetime'],
    ['varchar(32)', 'text'],
    ['numeric(10,2)', 'text']
  ])('%s → %s', (dataType, expected) => {
    expect(columnEditorKind(dataType)).toBe(expected);
  });

  it('含有 int 的非数值类型不会被错分', () => {
    // 按子串匹配的写法在这两个类型上一定会错
    expect(columnEditorKind('interval')).toBe('text');
    expect(columnEditorKind('point')).toBe('text');
  });
});

describe('十六进制', () => {
  it('允许用空白分组', () => {
    expect(normalizeHex('de ad\tbe\nef')).toBe('deadbeef');
    expect(isCompleteHex('de ad be ef')).toBe(true);
  });

  it('奇数位不算完整', () => {
    // 最后半个字节该补高位还是低位说不清，两种补法是两个不同的值
    expect(isCompleteHex('abc')).toBe(false);
  });

  it('非十六进制字符不算完整', () => {
    expect(isCompleteHex('zz')).toBe(false);
  });

  it('空值是合法的——零长度的 BLOB', () => {
    expect(isCompleteHex('')).toBe(true);
  });
});

describe('Oracle 的 DATE', () => {
  it('带时分秒，用日期加时间的控件', () => {
    expect(columnEditorKind('DATE', 'oracle')).toBe('datetime');
    expect(columnEditorKind('date', 'postgresql')).toBe('date');
  });
});

describe('binaryLiteral', () => {
  it('MySQL 与 SQLite 用 X\'...\'', () => {
    expect(binaryLiteral('DEADBEEF', 'mysql')).toBe("X'deadbeef'");
    expect(binaryLiteral('de ad be ef', 'sqlite')).toBe("X'deadbeef'");
  });

  it('PostgreSQL 用 bytea 的 \\x 形式', () => {
    expect(binaryLiteral('DEADBEEF', 'postgresql')).toBe("'\\xdeadbeef'::bytea");
  });

  it('SQL Server 用 0x，它不认 X\'...\'', () => {
    expect(binaryLiteral('DE AD', 'sqlserver')).toBe('0xdead');
    expect(binaryLiteral('DE AD', 'oracle')).toBe("HEXTORAW('dead')");
  });
});

describe('prettyJson', () => {
  it('缩进', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it('解析不了就返回 null，由调用方去提示', () => {
    expect(prettyJson('{a:1}')).toBeNull();
  });
});

describe('日期选择器与数据库文本互转', () => {
  it('选择器的 T 换成空格', () => {
    // 存回去再读出来是带空格的形式，不换的话「改过没有」每次都判成变了
    expect(pickerValueToDatabaseText('2024-01-01T12:00:00')).toBe('2024-01-01 12:00:00');
  });

  it('带空格的数据库文本能回到选择器', () => {
    expect(databaseTextToPickerValue('2024-01-01 12:00:00', 'datetime'))
      .toBe('2024-01-01T12:00:00');
  });

  it('认不出的值让选择器空着，不显示成某个看似合理的日期', () => {
    expect(databaseTextToPickerValue('0000-00-00 00:00:00', 'date')).toBe('');
    expect(databaseTextToPickerValue('now()', 'datetime')).toBe('');
    expect(databaseTextToPickerValue('', 'time')).toBe('');
  });

  it('日期与时间各自只认自己的形状', () => {
    expect(databaseTextToPickerValue('2024-01-01', 'date')).toBe('2024-01-01');
    expect(databaseTextToPickerValue('2024-01-01 12:00:00', 'date')).toBe('');
    expect(databaseTextToPickerValue('12:00:00', 'time')).toBe('12:00:00');
  });

  it('带时区或小数秒时保留到秒，其余交给文本框', () => {
    // 文本框里的原值始终是权威，选择器只是输入辅助
    expect(databaseTextToPickerValue('2024-01-01 12:00:00.123456+08', 'datetime'))
      .toBe('2024-01-01T12:00:00');
  });
});
