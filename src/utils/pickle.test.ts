import { describe, expect, it } from 'vitest';
import { decodePickle, pickleView } from './pickle';

// 语料都是 CPython 3.14 `pickle.dumps(obj, protocol=N)` 的真实输出（base64）
const TASKIQ = {
  4: 'gASViwAAAAAAAAB9lCiMBmlzX2VycpSJjANsb2eUTowMcmV0dXJuX3ZhbHVllH2UKIwFY291bnSUSwGMBWl0ZW1zlF2UjAVyYXRpb5RHP+AAAAAAAACMAmlklIwHcHQtOTk3MZR1jA5leGVjdXRpb25fdGltZZRHP9R64UeuFHuMBmxhYmVsc5R9lIwFZXJyb3KUTnUu',
  2: 'gAJ9cQAoWAYAAABpc19lcnJxAYlYAwAAAGxvZ3ECTlgMAAAAcmV0dXJuX3ZhbHVlcQN9cQQoWAUAAABjb3VudHEFSwFYBQAAAGl0ZW1zcQZdcQdYBQAAAHJhdGlvcQhHP+AAAAAAAABYAgAAAGlkcQlYBwAAAHB0LTk5NzFxCnVYDgAAAGV4ZWN1dGlvbl90aW1lcQtHP9R64UeuFHtYBgAAAGxhYmVsc3EMfXENWAUAAABlcnJvcnEOTnUu',
  5: 'gAWViwAAAAAAAAB9lCiMBmlzX2VycpSJjANsb2eUTowMcmV0dXJuX3ZhbHVllH2UKIwFY291bnSUSwGMBWl0ZW1zlF2UjAVyYXRpb5RHP+AAAAAAAACMAmlklIwHcHQtOTk3MZR1jA5leGVjdXRpb25fdGltZZRHP9R64UeuFHuMBmxhYmVsc5R9lIwFZXJyb3KUTnUu',
};

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

describe('pickleView', () => {
  it.each([2, 5] as const)('decodes protocol %i to the same text as protocol 4', (protocol) => {
    const view = pickleView(TASKIQ[protocol]);
    expect(view?.protocol).toBe(protocol);
    expect(view?.text).toBe(pickleView(TASKIQ[4])?.text);
  });

  it('rebuilds the protocol 2 spellings of bytes and set (_codecs.encode, __builtin__.set)', () => {
    // [datetime(2026, 9, 1, 3, 0), {1}, b'\xff'] with protocol=2
    expect(
      pickleView(
        'gAJdcQAoY2RhdGV0aW1lCmRhdGV0aW1lCnEBY19jb2RlY3MKZW5jb2RlCnECWAsAAAAHw6oJAQMAAAAAAHEDWAYAAABsYXRpbjFxBIZxBVJxBoVxB1JxCGNfX2J1aWx0aW5fXwpzZXQKcQldcQpLAWGFcQtScQxoAlgCAAAAw79xDWgEhnEOUnEPZS4=',
      )?.text,
    ).toBe("[datetime(2026-09-01 03:00:00), {1}, b'\\xff']");
  });

  it('breaks long containers onto indented lines and keeps short ones inline', () => {
    expect(pickleView(TASKIQ[4])?.text).toBe(
      [
        '{',
        "  'is_err': False,",
        "  'log': None,",
        "  'return_value': {'count': 1, 'items': [], 'ratio': 0.5, 'id': 'pt-9971'},",
        "  'execution_time': 0.32,",
        "  'labels': {},",
        "  'error': None,",
        '}',
      ].join('\n'),
    );
  });

  it('covers scalars, bytes, tuples of every arity, sets and non-string keys', () => {
    // [True, -3, 300, 70000, 2**70, -2**70, 1.0, inf, b"\x00a'", bytearray(b'z'), "it's\n",
    //  (), (1,), (1, 2), (1, 2, 3), (1, 2, 3, 4), {1, 2}, frozenset({3}), {(1, 2): 'k'}]
    const view = pickleView(
      'gAWViAAAAAAAAABdlCiISv3///9NLAFKcBEBAIoJAAAAAAAAAABAigkAAAAAAAAAAMBHP/AAAAAAAABHf/AAAAAAAABDAwBhJ5SWAQAAAAAAAAB6lIwFaXQncwqUKUsBhZRLAUsChpRLAUsCSwOHlChLAUsCSwNLBHSUj5QoSwFLApAoSwORlH2UaAWMAWuUc2Uu',
    );
    expect(view?.text).toBe(
      [
        '[',
        '  True,',
        '  -3,',
        '  300,',
        '  70000,',
        '  1180591620717411303424,',
        '  -1180591620717411303424,',
        '  1.0,',
        '  inf,',
        `  b"\\x00a'",`,
        "  bytearray(b'z'),",
        `  "it's\\n",`,
        '  (),',
        '  (1,),',
        '  (1, 2),',
        '  (1, 2, 3),',
        '  (1, 2, 3, 4),',
        '  {1, 2},',
        '  frozenset({3}),',
        "  {(1, 2): 'k'},",
        ']',
      ].join('\n'),
    );
  });

  it('follows memo references and draws a self-containing list as [...]', () => {
    // shared = [1]; rec = []; rec.append(rec); {'a': shared, 'b': shared, 'r': rec}
    expect(pickleView('gASVHQAAAAAAAAB9lCiMAWGUXZRLAWGMAWKUaAKMAXKUXZRoBWF1Lg==')?.text).toBe(
      "{'a': [1], 'b': [1], 'r': [[...]]}",
    );
  });

  it('shows objects by name without importing them, and dates as ISO text', () => {
    // [datetime(2026, 9, 1, 3, 0, 0, 123), date(2026, 8, 31), Decimal('1.50'), appmodels.Point() with x=1, y='a']
    expect(
      pickleView(
        'gASVkQAAAAAAAABdlCiMCGRhdGV0aW1llIwIZGF0ZXRpbWWUk5RDCgfqCQEDAAAAAHuUhZRSlGgBjARkYXRllJOUQwQH6ggflIWUUpSMB2RlY2ltYWyUjAdEZWNpbWFslJOUjAQxLjUwlIWUUpSMCWFwcG1vZGVsc5SMBVBvaW50lJOUKYGUfZQojAF4lEsBjAF5lIwBYZR1YmUu',
      )?.text,
    ).toBe(
      [
        '[',
        '  datetime(2026-09-01 03:00:00.000123),',
        '  date(2026-08-31),',
        "  decimal.Decimal('1.50'),",
        "  appmodels.Point {'x': 1, 'y': 'a'},",
        ']',
      ].join('\n'),
    );
  });

  it('colours by what each piece is, and the pieces join back to the text exactly', () => {
    // {'a': shared, 'b': shared, 'r': rec}，以及上面那份含 datetime / Decimal / 自定义类的
    const dict = pickleView('gASVHQAAAAAAAAB9lCiMAWGUXZRLAWGMAWKUaAKMAXKUXZRoBWF1Lg==');
    expect(dict?.segments).toEqual([
      { text: '{', tone: null },
      { text: "'a'", tone: 'property' },
      { text: ': [', tone: null },
      { text: '1', tone: 'number' },
      { text: '], ', tone: null },
      { text: "'b'", tone: 'property' },
      { text: ': [', tone: null },
      { text: '1', tone: 'number' },
      { text: '], ', tone: null },
      { text: "'r'", tone: 'property' },
      { text: ': [[...]]}', tone: null },
    ]);

    const objects = pickleView(
      'gASVkQAAAAAAAABdlCiMCGRhdGV0aW1llIwIZGF0ZXRpbWWUk5RDCgfqCQEDAAAAAHuUhZRSlGgBjARkYXRllJOUQwQH6ggflIWUUpSMB2RlY2ltYWyUjAdEZWNpbWFslJOUjAQxLjUwlIWUUpSMCWFwcG1vZGVsc5SMBVBvaW50lJOUKYGUfZQojAF4lEsBjAF5lIwBYZR1YmUu',
    );
    const toned = objects?.segments.filter((segment) => segment.tone !== null);
    expect(toned).toEqual([
      { text: 'datetime', tone: 'type' },
      { text: '2026-09-01 03:00:00.000123', tone: 'number' },
      { text: 'date', tone: 'type' },
      { text: '2026-08-31', tone: 'number' },
      { text: 'decimal.Decimal', tone: 'type' },
      { text: "'1.50'", tone: 'string' },
      { text: 'appmodels.Point', tone: 'type' },
      { text: "'x'", tone: 'property' },
      { text: '1', tone: 'number' },
      { text: "'y'", tone: 'property' },
      { text: "'a'", tone: 'string' },
    ]);
    for (const view of [dict, objects, pickleView(TASKIQ[4])]) {
      expect(view?.segments.map((segment) => segment.text).join('')).toBe(view?.text);
    }
    expect(pickleView(TASKIQ[4])?.segments.filter((segment) => segment.tone === 'atom').map((s) => s.text)).toEqual([
      'False',
      'None',
      'None',
    ]);
  });

  it('appends a fixed UTC offset to an aware datetime', () => {
    // datetime(2026, 9, 1, 3, 0, tzinfo=timezone.utc)
    expect(
      pickleView(
        'gASVVwAAAAAAAACMCGRhdGV0aW1llIwIZGF0ZXRpbWWUk5RDCgfqCQEDAAAAAACUaACMCHRpbWV6b25llJOUaACMCXRpbWVkZWx0YZSTlEsASwBLAIeUUpSFlFKUhpRSlC4=',
      )?.text,
    ).toBe('datetime(2026-09-01 03:00:00+00:00)');
  });
});

describe('decodePickle', () => {
  it('refuses protocol 0, which has no magic number to tell it from arbitrary bytes', () => {
    expect(decodePickle(bytesOf('KGRwMApWYQpwMQpJMQpzLg=='))).toBeNull();
  });

  it('refuses a truncated pickle instead of showing half a structure', () => {
    const full = bytesOf(TASKIQ[4]);
    expect(decodePickle(full.subarray(0, full.length - 1))).toBeNull();
    expect(decodePickle(full.subarray(0, 40))).toBeNull();
  });

  it('refuses bytes after STOP and bytes that merely start like a pickle', () => {
    const full = bytesOf(TASKIQ[4]);
    expect(decodePickle(Uint8Array.from([...full, 0x00]))).toBeNull();
    expect(decodePickle(Uint8Array.from([0x80, 0x04, 0xff, 0xfe]))).toBeNull();
    expect(decodePickle(new TextEncoder().encode('plain text'))).toBeNull();
  });

  it('refuses opcodes that need context from the unpickler (persistent ids)', () => {
    // PROTO 4, BINPERSID on an int, STOP
    expect(decodePickle(Uint8Array.from([0x80, 0x04, 0x4b, 0x01, 0x51, 0x2e]))).toBeNull();
  });

  it('returns null rather than throwing on garbage base64', () => {
    expect(pickleView('%%%')).toBeNull();
  });
});
