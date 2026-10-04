import { describe, expect, it } from 'vitest';
import {
  binaryLiteral,
  columnEditorKind,
  databaseTextToPickerValue,
  isCompleteHex,
  normalizeHex,
  nowExpression,
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

  it('认网格里显示的 0x 前缀：照着显示的值抄进来不该被说成「位数不对」', () => {
    expect(normalizeHex('0xDEAD beef')).toBe('DEADbeef');
    expect(isCompleteHex('0xdeadbeef')).toBe(true);
    expect(binaryLiteral('0xCAFE', 'oracle')).toBe("HEXTORAW('cafe')");
    // 只认开头那一个：中间的 x 仍然不是十六进制
    expect(isCompleteHex('de0xad')).toBe(false);
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

describe('Oracle 的 RAW', () => {
  it('是二进制：当文本写进去，Oracle 把它当十六进制转，0x 前缀直接报 ORA-01465', () => {
    expect(columnEditorKind('RAW(8)', 'oracle')).toBe('binary');
    expect(columnEditorKind('BLOB', 'oracle')).toBe('binary');
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

  it('DuckDB 用 from_hex：X\'...\' 在它那里是列别名，存进去的是一串字', () => {
    expect(binaryLiteral('DE AD', 'duckdb')).toBe("from_hex('dead')");
  });
});

describe('prettyJson', () => {
  it('缩进', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it('解析不了就返回 null，由调用方去提示', () => {
    expect(prettyJson('{a:1}')).toBeNull();
  });

  // JSON.parse 把数读成双精度：雪花 ID 这类 2^53 以上的整数会被改掉，点一下「格式化」再保存就写坏了
  it('数照原文写，不经过双精度', () => {
    expect(prettyJson('{"id":1234567890123456789,"x":1.0,"y":3.14159265358979323846}'))
      .toBe('{\n  "id": 1234567890123456789,\n  "x": 1.0,\n  "y": 3.14159265358979323846\n}');
  });

  it('字符串里的括号、逗号、转义引号与空白原样留着', () => {
    expect(prettyJson('{"s" : "a\\"{, b]\\\\" , "t":[ ] , "u":{}}'))
      .toBe('{\n  "s": "a\\"{, b]\\\\",\n  "t": [],\n  "u": {}\n}');
  });

  it('与 JSON.stringify 的缩进相同', () => {
    const text = '[1,{"a":[true,null,"x"],"b":{"c":-2.5}},[]]';
    expect(prettyJson(text)).toBe(JSON.stringify(JSON.parse(text), null, 2));
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

describe('「现在」按钮写的表达式', () => {
  it('日期时间列写 CURRENT_TIMESTAMP', () => {
    expect(nowExpression('datetime', 'postgresql')).toBe('CURRENT_TIMESTAMP');
    expect(nowExpression('datetime', 'sqlserver')).toBe('CURRENT_TIMESTAMP');
  });

  it('日期与时间列只取那一半', () => {
    // DuckDB 把 CURRENT_TIMESTAMP 写进 TIME 报「Unimplemented type for cast」；
    // SQLite 会把整段日期时间存进 date / time 列
    expect(nowExpression('time', 'duckdb')).toBe('CURRENT_TIME');
    expect(nowExpression('date', 'sqlite')).toBe('CURRENT_DATE');
    expect(nowExpression('time', 'sqlite')).toBe('CURRENT_TIME');
    expect(nowExpression('date', 'postgresql')).toBe('CURRENT_DATE');
    expect(nowExpression('time', 'mysql')).toBe('CURRENT_TIME');
  });

  it('SQL Server 没有 CURRENT_DATE / CURRENT_TIME，转换取那一半', () => {
    expect(nowExpression('date', 'sqlserver')).toBe('CAST(CURRENT_TIMESTAMP AS date)');
    expect(nowExpression('time', 'sqlserver')).toBe('CAST(CURRENT_TIMESTAMP AS time)');
  });
});

describe('SQL Server 的 image', () => {
  it('是二进制：当文本写进去报 206「nvarchar is incompatible with image」', () => {
    expect(columnEditorKind('image', 'sqlserver')).toBe('binary');
  });
});
