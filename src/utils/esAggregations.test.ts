import { describe, expect, it } from 'vitest';
import { formatJsonCell, parseJson } from './esJson';
import { toAggTables } from './esAggregations';

// cu 上 9.5.3 的原话：terms 下套 avg 与 date_histogram，外加 sum、date_histogram、stats
const RESPONSE = parseJson(`{"took":135,"hits":{"total":{"value":3,"relation":"eq"},"max_score":null,"hits":[]},"aggregations":{"by_city":{"doc_count_error_upper_bound":0,"sum_other_doc_count":0,"buckets":[{"key":"Paris","doc_count":2,"avg_price":{"value":20.0},"by_day":{"buckets":[{"key_as_string":"2026-09-01T00:00:00.000Z","key":1788220800000,"doc_count":1},{"key_as_string":"2026-09-02T00:00:00.000Z","key":1788307200000,"doc_count":1}]}},{"key":"Rome","doc_count":1,"avg_price":{"value":20.0},"by_day":{"buckets":[{"key_as_string":"2026-09-02T00:00:00.000Z","key":1788307200000,"doc_count":1}]}}]},"total":{"value":60.0},"per_day":{"buckets":[{"key_as_string":"2026-09-01T00:00:00.000Z","key":1788220800000,"doc_count":1},{"key_as_string":"2026-09-02T00:00:00.000Z","key":1788307200000,"doc_count":2}]},"stats":{"count":3,"min":10.0,"max":30.0,"avg":20.0,"sum":60.0}}}`);

const cells = (rows: ReadonlyArray<ReadonlyArray<unknown>>) =>
  rows.map((row) => row.map((cell) => (cell === null ? '' : formatJsonCell(cell as never))));

describe('toAggTables', () => {
  it('expands nested buckets into rows, carrying the outer metrics along', () => {
    const [byCity] = toAggTables(RESPONSE);
    expect(byCity.name).toBe('by_city');
    expect(byCity.columns).toEqual(['by_city', 'by_day', 'doc_count', 'avg_price']);
    expect(cells(byCity.rows)).toEqual([
      ['Paris', '2026-09-01T00:00:00.000Z', '1', '20.0'],
      ['Paris', '2026-09-02T00:00:00.000Z', '1', '20.0'],
      ['Rome', '2026-09-02T00:00:00.000Z', '1', '20.0']
    ]);
  });

  it('keys date histograms by their string form, not milliseconds', () => {
    const perDay = toAggTables(RESPONSE).find((table) => table.name === 'per_day');
    expect(cells(perDay!.rows)).toEqual([
      ['2026-09-01T00:00:00.000Z', '1'],
      ['2026-09-02T00:00:00.000Z', '2']
    ]);
  });

  it('gathers single and multi-value metrics into one name | value table', () => {
    const metrics = toAggTables(RESPONSE).find((table) => table.name === null);
    expect(metrics?.columns).toEqual(['aggregation', 'value']);
    expect(cells(metrics!.rows)).toEqual([
      ['total', '60.0'],
      ['stats.count', '3'],
      ['stats.min', '10.0'],
      ['stats.max', '30.0'],
      ['stats.avg', '20.0'],
      ['stats.sum', '60.0']
    ]);
  });

  it('reads keyed buckets and leaves a second bucket sub-aggregation as JSON', () => {
    const [filters] = toAggTables(parseJson(`{"aggregations":{"kinds":{"buckets":{"errors":{"doc_count":4,"a":{"buckets":[{"key":"x","doc_count":1}]},"b":{"buckets":[{"key":"y","doc_count":2}]}},"warnings":{"doc_count":0,"a":{"buckets":[]},"b":{"buckets":[]}}}}}}`));
    expect(filters.columns).toEqual(['kinds', 'a', 'doc_count', 'b']);
    expect(cells(filters.rows)).toEqual([
      ['errors', 'x', '1', '{"buckets":[{"key":"y","doc_count":2}]}'],
      // 空的桶子聚合不把这一行吞掉
      ['warnings', '', '0', '{"buckets":[]}']
    ]);
  });

  it('has nothing to show without aggregations', () => {
    expect(toAggTables(parseJson('{"hits":{"hits":[]}}'))).toEqual([]);
    expect(toAggTables(null)).toEqual([]);
  });
});
