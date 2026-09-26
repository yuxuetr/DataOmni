import { describe, expect, it } from 'vitest';
import { columnTypeToken, isConcurrencyComparable, isNumericColumnType } from './columnTypes';

describe('列类型', () => {
  it('ClickHouse 的数值类型，套了 Nullable / LowCardinality 也认得出', () => {
    for (const type of ['UInt64', 'Int8', 'Float64', 'Decimal(18, 2)', 'Decimal64(4)', 'Nullable(UInt32)', 'LowCardinality(Nullable(Int64))']) {
      expect(isNumericColumnType(type), type).toBe(true);
    }
    for (const type of ['String', 'Nullable(String)', 'DateTime64(3)', 'Array(UInt8)', 'interval', 'point']) {
      expect(isNumericColumnType(type), type).toBe(false);
    }
  });

  it('只取第一个词，外壳之外不动', () => {
    expect(columnTypeToken('bigint unsigned')).toBe('bigint');
    expect(columnTypeToken('numeric(10,2)')).toBe('numeric');
    expect(columnTypeToken('Nullable(Decimal(10, 2))')).toBe('decimal');
  });
});

describe('ClickHouse 的整行比较', () => {
  it('文本、整数、定点、时间比得准；浮点、数组、Map 不比', () => {
    for (const type of ['UInt64', 'LowCardinality(String)', 'Nullable(Decimal(10, 2))', "DateTime64(3, 'UTC')", 'Enum8(\'a\' = 1)', 'UUID']) {
      expect(isConcurrencyComparable(type, 'clickhouse'), type).toBe(true);
    }
    for (const type of ['Float64', 'Nullable(Float32)', 'Array(String)', 'Map(String, UInt8)', 'JSON']) {
      expect(isConcurrencyComparable(type, 'clickhouse'), type).toBe(false);
    }
  });
});
