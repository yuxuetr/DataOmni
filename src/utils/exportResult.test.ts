import { describe, expect, it } from 'vitest';
import type { SerializedResultValue } from '../contracts/resultSet';
import {
  DEFAULT_EXPORT_OPTIONS,
  serializeExport,
  suggestExportFileName,
  toCsv,
  toJson,
  uniqueColumnNames
} from './exportResult';

const csv = (
  columns: string[],
  rows: SerializedResultValue[][],
  overrides: Partial<typeof DEFAULT_EXPORT_OPTIONS> = {}
) => toCsv(columns, rows, { ...DEFAULT_EXPORT_OPTIONS, ...overrides });

const json = (columns: string[], rows: SerializedResultValue[][]) => toJson(columns, rows);

describe('toCsv', () => {
  it('写出表头和数据行', () => {
    expect(csv(['id', 'name'], [[1, 'ada'], [2, 'bob']]))
      .toBe('id,name\n1,ada\n2,bob');
  });

  it('可以不要表头', () => {
    expect(csv(['id'], [[1]], { includeHeader: false })).toBe('1');
  });

  it('含分隔符、引号或换行的字段要加引号，引号内部翻倍', () => {
    expect(csv(['a'], [['x,y']])).toBe('a\n"x,y"');
    expect(csv(['a'], [['say "hi"']])).toBe('a\n"say ""hi"""');
    expect(csv(['a'], [['line1\nline2']])).toBe('a\n"line1\nline2"');
    expect(csv(['a'], [['has\rcr']])).toBe('a\n"has\rcr"');
  });

  it('换分隔符后，需要加引号的字符随之改变', () => {
    // 逗号在制表符分隔下是普通字符，不该再被引号包住
    expect(csv(['a'], [['x,y']], { delimiter: '\t' })).toBe('a\nx,y');
    expect(csv(['a'], [['x\ty']], { delimiter: '\t' })).toBe('a\n"x\ty"');
  });

  it('NULL 的写法可配置，默认是空字段', () => {
    expect(csv(['a', 'b'], [[null, '']])).toBe('a,b\n,');
    expect(csv(['a', 'b'], [[null, '']], { nullText: 'NULL' })).toBe('a,b\nNULL,');
    expect(csv(['a'], [[null]], { nullText: '\\N' })).toBe('a\n\\N');
  });

  it('NULL 文本本身含分隔符时也要被引号包住', () => {
    expect(csv(['a'], [[null]], { nullText: 'a,b' })).toBe('a\n"a,b"');
  });

  it('bigint 与 decimal 按原字符串写出，不丢精度', () => {
    const big: SerializedResultValue = { type: 'bigint', value: '9223372036854775807' };
    const dec: SerializedResultValue = { type: 'decimal', value: '0.10000000000000000001' };
    expect(csv(['a', 'b'], [[big, dec]]))
      .toBe('a,b\n9223372036854775807,0.10000000000000000001');
  });

  it('二进制写成 0x 前缀的十六进制', () => {
    expect(csv(['a'], [[{ type: 'binary', value: 'deadbeef' }]])).toBe('a\n0xdeadbeef');
  });

  it('JSON 列写成压紧的一行，不带缩进换行', () => {
    const value: SerializedResultValue = { type: 'json', value: '{"a": 1,\n "b": 2}' };
    expect(csv(['j'], [[value]])).toBe('j\n"{""a"":1,""b"":2}"');
  });

  it('布尔按 true / false 写出', () => {
    expect(csv(['a', 'b'], [[true, false]])).toBe('a,b\ntrue,false');
  });

  it('表头本身也走转义', () => {
    expect(csv(['a,b'], [])).toBe('"a,b"');
  });
});

describe('toJson', () => {
  it('写成对象数组，列名作键', () => {
    expect(JSON.parse(json(['id', 'name'], [[1, 'ada']])))
      .toEqual([{ id: 1, name: 'ada' }]);
  });

  it('NULL 是真的 null', () => {
    expect(JSON.parse(json(['a'], [[null]]))).toEqual([{ a: null }]);
  });

  it('bigint 与 decimal 写成字符串', () => {
    // JSON 数字在实践中就是 IEEE-754 双精度：任何消费方 JSON.parse 一个
    // 20 位整数都会丢位。加引号才能无损往返，这也是应用内部用字符串承载它们的原因。
    const out = JSON.parse(json(['a'], [[{ type: 'bigint', value: '9223372036854775807' }]]));
    expect(out).toEqual([{ a: '9223372036854775807' }]);
  });

  it('JSON 列还原成嵌套结构，不是转义过的字符串', () => {
    const out = JSON.parse(json(['j'], [[{ type: 'json', value: '{"a":[1,2]}' }]]));
    expect(out).toEqual([{ j: { a: [1, 2] } }]);
  });

  it('JSON 列解析不了时原样保留为字符串', () => {
    const out = JSON.parse(json(['j'], [[{ type: 'json', value: 'not json' }]]));
    expect(out).toEqual([{ j: 'not json' }]);
  });

  it('二进制写成 0x 十六进制字符串', () => {
    const out = JSON.parse(json(['b'], [[{ type: 'binary', value: 'ff00' }]]));
    expect(out).toEqual([{ b: '0xff00' }]);
  });

  it('空结果是空数组', () => {
    expect(json(['a'], [])).toBe('[]');
  });
});

describe('uniqueColumnNames', () => {
  it('重名列加后缀，不让后一列把前一列顶掉', () => {
    expect(uniqueColumnNames(['id', 'name', 'id'])).toEqual(['id', 'name', 'id_2']);
  });

  it('后缀本身撞上已有列名时继续往后找', () => {
    expect(uniqueColumnNames(['id', 'id_2', 'id'])).toEqual(['id', 'id_2', 'id_3']);
  });

  it('不重名时原样返回', () => {
    expect(uniqueColumnNames(['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('serializeExport', () => {
  it('按格式分发', () => {
    expect(serializeExport(['a'], [[1]], { ...DEFAULT_EXPORT_OPTIONS, format: 'csv' }))
      .toBe('a\n1');
    expect(serializeExport(['a'], [[1]], { ...DEFAULT_EXPORT_OPTIONS, format: 'json' }))
      .toBe(JSON.stringify([{ a: 1 }], null, 2));
  });

  it('需要 BOM 时加在最前面，让 Excel 不把 UTF-8 中文读成乱码', () => {
    const text = serializeExport(['名'], [['值']], {
      ...DEFAULT_EXPORT_OPTIONS,
      byteOrderMark: true
    });
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1)).toBe('名\n值');
  });

  it('默认不加 BOM', () => {
    expect(serializeExport(['名'], [['值']], DEFAULT_EXPORT_OPTIONS).charCodeAt(0))
      .not.toBe(0xfeff);
  });
});

describe('suggestExportFileName', () => {
  it('带上来源名与扩展名', () => {
    expect(suggestExportFileName('users', 'csv', new Date('2026-09-20T08:09:10Z')))
      .toMatch(/^users-\d{8}-\d{6}\.csv$/);
  });

  it('把路径分隔符等文件名非法字符换掉', () => {
    expect(suggestExportFileName('public/users', 'json', new Date('2026-09-20T08:09:10Z')))
      .toMatch(/^public_users-\d{8}-\d{6}\.json$/);
  });

  it('来源名为空时用兜底名', () => {
    expect(suggestExportFileName('', 'csv', new Date('2026-09-20T08:09:10Z')))
      .toMatch(/^result-\d{8}-\d{6}\.csv$/);
  });
});
