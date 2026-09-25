import { describe, expect, it } from 'vitest';
import { bytesToBase64, commandRisk, formatReply, splitCommandLine } from './redisCommandLine';

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const args = (line: string) => {
  const result = splitCommandLine(line);
  if (!result.ok) throw new Error(result.error);
  return result.args;
};
const b = (value: string) => ({ raw: btoa(value), text: value, binary: false });

describe('splitCommandLine', () => {
  it('空白分隔，引号里可以有空白', () => {
    expect(args('  SET  "a key"   \'x y\'  ').map(text)).toEqual(['SET', 'a key', 'x y']);
  });

  it('双引号里的转义与 \\xHH 是字节；单引号里只认 \\\'', () => {
    const [, value] = args('SET "\\xff\\n\\"q\\""');
    expect([...value]).toEqual([0xff, 0x0a, 0x22, 0x71, 0x22]);
    expect(text(args("SET 'it\\'s \\n'")[1])).toBe("it's \\n");
  });

  it('中文按 UTF-8 编码', () => {
    expect([...args('GET 键')[1]]).toEqual([...new TextEncoder().encode('键')]);
  });

  it('引号没收尾、收尾后紧跟着字符、空行都报出来', () => {
    expect(splitCommandLine('SET "abc')).toEqual({ ok: false, error: 'unbalancedQuotes' });
    expect(splitCommandLine('SET "a"b')).toEqual({ ok: false, error: 'unbalancedQuotes' });
    expect(splitCommandLine('   ')).toEqual({ ok: false, error: 'empty' });
  });

  it('base64 是原样的字节', () => {
    expect(bytesToBase64(Uint8Array.from([0xff, 0x00]))).toBe('/wA=');
  });
});

describe('formatReply', () => {
  it('标量照 redis-cli 的写法', () => {
    expect(formatReply({ kind: 'nil' })).toBe('(nil)');
    expect(formatReply({ kind: 'integer', value: 3 })).toBe('(integer) 3');
    expect(formatReply({ kind: 'status', value: 'OK' })).toBe('OK');
    expect(formatReply({ kind: 'error', message: 'ERR nope' })).toBe('(error) ERR nope');
    expect(formatReply({ kind: 'bulk', value: b('a "b"\n') })).toBe('"a \\"b\\"\\n"');
    // 二进制的已经在后端转义过，这里不再转一遍
    expect(formatReply({ kind: 'bulk', value: { raw: '', text: '\\xff', binary: true } })).toBe('"\\xff"');
  });

  it('数组编号，嵌套的按序号宽度缩进，空数组单说', () => {
    const reply = {
      kind: 'array' as const,
      items: [{ kind: 'bulk' as const, value: b('a') }, { kind: 'array' as const, items: [{ kind: 'integer' as const, value: 1 }, { kind: 'nil' as const }] }]
    };
    expect(formatReply(reply)).toBe('1) "a"\n2) 1) (integer) 1\n   2) (nil)');
    expect(formatReply({ kind: 'array', items: [] })).toBe('(empty array)');
  });

  it('十个以上时序号右对齐', () => {
    const items = Array.from({ length: 10 }, (_, index) => ({ kind: 'integer' as const, value: index }));
    const lines = formatReply({ kind: 'array', items }).split('\n');
    expect(lines[0]).toBe(' 1) (integer) 0');
    expect(lines[9]).toBe('10) (integer) 9');
  });
});

describe('commandRisk', () => {
  it('清库、卡住服务端、改服务端的要先问', () => {
    expect(commandRisk(args('flushdb'))).toBe('wipes');
    expect(commandRisk(args('KEYS *'))).toBe('blocksServer');
    expect(commandRisk(args('config set maxmemory 1gb'))).toBe('changesServer');
    expect(commandRisk(args('SCRIPT FLUSH'))).toBe('wipes');
  });

  it('普通读写与只读的子命令不问', () => {
    expect(commandRisk(args('SET k v'))).toBeNull();
    expect(commandRisk(args('DEL k'))).toBeNull();
    expect(commandRisk(args('CONFIG GET maxmemory'))).toBeNull();
    expect(commandRisk(args('SCRIPT EXISTS abc'))).toBeNull();
  });
});
