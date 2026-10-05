import { describe, expect, it } from 'vitest';
import {
  formatQueryErrorReport,
  locateQueryError,
  reportedByDatabase,
  toQueryExecutionError
} from './queryError';

describe('reportedByDatabase', () => {
  it('数据库给的错误码算，我们自己判出来的不算', () => {
    expect(reportedByDatabase({ message: 'x', code: '42P01' })).toBe(true);
    expect(reportedByDatabase({ message: 'x' })).toBe(true);
    // 驱动读不懂回包：面板不该印一个「错误码 PROTOCOL_ERROR」，像是服务端报的
    for (const code of ['QUERY_TIMEOUT', 'QUERY_CANCELLED', 'CONNECTION_LOST', 'PROTOCOL_ERROR']) {
      expect(reportedByDatabase({ message: 'x', code })).toBe(false);
    }
  });
});

describe('toQueryExecutionError', () => {
  it('后端交来的对象原样落地', () => {
    expect(
      toQueryExecutionError({
        message: 'relation "usres" does not exist',
        code: '42P01',
        position: 15,
        hint: 'Perhaps you meant "users".'
      })
    ).toEqual({
      message: 'relation "usres" does not exist',
      code: '42P01',
      position: 15,
      detail: undefined,
      hint: 'Perhaps you meant "users".',
      constraint: undefined,
      table: undefined
    });
  });

  it('仍然 reject 字符串的命令也要能落地', () => {
    // 只有 execute_query 改成了结构化错误，别的命令还是字符串；
    // 读不出结构就让整块错误面板消失，是最糟的失败方式
    expect(toQueryExecutionError('数据库会话未连接')).toEqual({
      message: '数据库会话未连接'
    });
  });

  it('JS 侧抛的 Error 也要能落地', () => {
    expect(toQueryExecutionError(new Error('网络断了')).message).toBe('网络断了');
  });

  it('位置不是正整数时当作没有', () => {
    // 凭空给一个 0 或负数，界面会去标一个不存在的位置
    expect(toQueryExecutionError({ message: 'x', position: 0 }).position).toBeUndefined();
    expect(toQueryExecutionError({ message: 'x', position: 1.5 }).position).toBeUndefined();
    expect(toQueryExecutionError({ message: 'x', position: '3' }).position).toBeUndefined();
  });

  it('空串字段当作没有，不在面板上留一行空白', () => {
    expect(toQueryExecutionError({ message: 'x', hint: '   ' }).hint).toBeUndefined();
  });

  it('ORA-01805 说清原因与绕法：Oracle 自己只说「possible error in date/time operation」', () => {
    const error = toQueryExecutionError({ message: 'ORA-01805: possible error in date/time operation', code: 'ORA-01805' });
    expect(error.hint).toContain('TO_CHAR');
    expect(error.hint).toContain('TZH:TZM');
    // 别的错误码不凭空加提示
    expect(toQueryExecutionError({ message: 'x', code: 'ORA-00942' }).hint).toBeUndefined();
  });

  it('Oracle 原生 JSON / VECTOR 列读不了时给出转成文本的写法：驱动的原话看不出该怎么办', () => {
    const error = toQueryExecutionError({ message: 'unsupported Oracle type JSON' });
    expect(error.hint).toContain('JSON_SERIALIZE');
    expect(toQueryExecutionError({ message: 'unknown Oracle type number 2033' }).hint).toContain('VECTOR_SERIALIZE');
    expect(toQueryExecutionError({ message: 'unsupported Oracle type FOO' }).hint).toBeUndefined();
  });
});

describe('locateQueryError', () => {
  it('单行语句算出列号', () => {
    expect(locateQueryError('SELECT 1 form dual', 10)).toEqual({
      line: 1,
      column: 10,
      offset: 9
    });
  });

  it('多行语句算出行号与列号', () => {
    const sql = 'SELECT *\nFROM usres\nWHERE id = 1';
    const position = sql.indexOf('usres') + 1;
    expect(locateQueryError(sql, position)).toEqual({
      line: 2,
      column: 6,
      offset: sql.indexOf('usres')
    });
  });

  it('语句在文档里的偏移要加进去', () => {
    // 结果卡片上的位置是相对这条语句的；跳转要的是整份文档里的位置
    expect(locateQueryError('SELECT 1', 8, 100)?.offset).toBe(107);
  });

  it('按码位数，不按 UTF-16 码元', () => {
    // 数据库数的是字符。语句里每多一个 emoji，直接当下标用就偏一格，
    // 而偏出来的位置看上去完全像个正常位置
    const sql = "SELECT '🙂' , x";
    const position = Array.from(sql).indexOf('x') + 1;
    expect(locateQueryError(sql, position)?.offset).toBe(sql.indexOf('x'));
  });

  it('位置越界或非法时返回 null', () => {
    expect(locateQueryError('SELECT 1', 0)).toBeNull();
    expect(locateQueryError('SELECT 1', 999)).toBeNull();
    expect(locateQueryError('SELECT 1', 1.5)).toBeNull();
  });

  it('位置正好在末尾之后一位是合法的', () => {
    // PostgreSQL 报「语句在这里就结束了」时给的就是这个位置
    expect(locateQueryError('SELECT', 7)?.column).toBe(7);
  });
});

describe('formatQueryErrorReport', () => {
  const labels = {
    message: '错误',
    code: '错误码',
    position: '位置',
    detail: '详情',
    hint: '提示',
    constraint: '约束',
    table: '表',
    sql: 'SQL'
  };

  it('把有值的字段和语句一起写出来', () => {
    expect(
      formatQueryErrorReport(
        { message: 'duplicate key', code: '23505', constraint: 'uq_code' },
        'INSERT INTO t VALUES (1)',
        labels
      )
    ).toBe(
      [
        '错误: duplicate key',
        '错误码: 23505',
        '约束: uq_code',
        '',
        'SQL:',
        'INSERT INTO t VALUES (1)'
      ].join('\n')
    );
  });

  it('缺的字段不写，不留一堆「无」', () => {
    const report = formatQueryErrorReport({ message: 'boom' }, 'SELECT 1', labels);
    expect(report).not.toContain('位置');
    expect(report).not.toContain('提示');
  });
});
