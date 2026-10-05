import { MISSING, jsonField, type JsonValue } from './esJson';

/**
 * 搜索回答里的 `aggregations` 摊成表。
 *
 * - 桶聚合（`terms`、`date_histogram`、`range`、按名字分桶的 `filters`）一个一张表：一列键、一列
 *   `doc_count`，子聚合里的指标各占一列。子聚合里又有桶的，按层展开成行——`by_city` 下的 `by_day`
 *   就是「城市 × 日期」一行一格，和透视表一样。同一层有两个桶子聚合时只展开第一个，其余的写成一行 JSON：
 *   两个都展开就是笛卡尔积，行数与意义都不对。
 * - 指标聚合（`sum`、`avg`、`stats`……）并进一张「名字 | 值」的表；多值的写成 `stats.min` 这样。
 * - 单桶聚合（`nested`、`filter`……）本身不成表，下面的子聚合照上面两条摊开，名字带上它。
 *
 * 键优先用 `key_as_string`（日期直方图的 `key` 是毫秒数）。认不出的形状不进表，JSON 里照样有。
 */

type Cell = JsonValue | typeof MISSING;

export interface AggTable {
  /** 桶聚合的名字；指标那张是 `null` */
  name: string | null;
  columns: string[];
  rows: Cell[][];
}

const BUCKET_META = new Set(['key', 'key_as_string', 'doc_count', 'from', 'to', 'from_as_string', 'to_as_string']);

/** `terms` 的桶是数组；`filters` / 带 `keyed` 的是以键为名的对象 */
function bucketsOf(aggregation: JsonValue): Array<{ key: Cell; bucket: JsonValue }> | null {
  const buckets = jsonField(aggregation, 'buckets');
  if (buckets?.kind === 'array') {
    return buckets.items.map((bucket) => ({
      key: jsonField(bucket, 'key_as_string') ?? jsonField(bucket, 'key') ?? MISSING,
      bucket
    }));
  }
  if (buckets?.kind === 'object') {
    return buckets.entries.map(([key, bucket]) => ({ key: { kind: 'string', value: key }, bucket }));
  }
  return null;
}

/** 单值指标的值：`value_as_string` 优先（日期的最大最小值），没有就是 `value` */
function metricValue(aggregation: JsonValue): Cell | undefined {
  if (aggregation.kind !== 'object') return undefined;
  const asString = jsonField(aggregation, 'value_as_string');
  if (asString) return asString;
  const value = jsonField(aggregation, 'value');
  return value && aggregation.entries.every(([key]) => key === 'value' || key === 'value_as_string') ? value : undefined;
}

interface Level {
  keys: Cell[];
  docCount: Cell;
  metrics: Map<string, Cell>;
}

/** 一个桶聚合按层展开：每一行是从上到下一串键，加最里层那个桶的 `doc_count` 与它的指标 */
function flatten(aggregation: JsonValue, dimensions: string[], metricNames: string[], prefix: Cell[], out: Level[]): void {
  for (const { key, bucket } of bucketsOf(aggregation) ?? []) {
    const children = bucket.kind === 'object' ? bucket.entries.filter(([name]) => !BUCKET_META.has(name)) : [];
    const nested = children.find(([, child]) => bucketsOf(child) !== null);
    const metrics = new Map<string, Cell>();
    for (const [name, child] of children) {
      if (child === nested?.[1]) continue;
      const value = metricValue(child);
      metrics.set(name, value ?? child);
      if (!metricNames.includes(name)) metricNames.push(name);
    }
    const keys = [...prefix, key];
    if (nested && bucketsOf(nested[1])!.length > 0) {
      if (!dimensions.includes(nested[0])) dimensions.push(nested[0]);
      // 外层的指标跟到每一行上：`by_city` 的平均价在「巴黎 × 每一天」上都写着
      const before = out.length;
      flatten(nested[1], dimensions, metricNames, keys, out);
      for (const row of out.slice(before)) {
        for (const [name, value] of metrics) if (!row.metrics.has(name)) row.metrics.set(name, value);
      }
    } else {
      out.push({ keys, docCount: jsonField(bucket, 'doc_count') ?? MISSING, metrics });
    }
  }
}

export function toAggTables(response: JsonValue | null): AggTable[] {
  const aggregations = jsonField(response ?? undefined, 'aggregations');
  if (aggregations?.kind !== 'object') return [];
  const tables: AggTable[] = [];
  const metricRows: Cell[][] = [];
  collect(aggregations.entries, '', tables, metricRows);
  if (metricRows.length > 0) tables.push({ name: null, columns: ['aggregation', 'value'], rows: metricRows });
  return tables;
}

/**
 * 单桶聚合（`nested`、`filter`、`global`、`missing`……）只有一个 `doc_count`，下面挂着子聚合：
 * 照顶层的一样摊开，名字前面带上它（`comments.by_author`），`doc_count` 进指标表
 */
function isSingleBucket(aggregation: JsonValue): boolean {
  return aggregation.kind === 'object' && jsonField(aggregation, 'doc_count')?.kind === 'number' && !jsonField(aggregation, 'buckets');
}

function collect(entries: ReadonlyArray<[string, JsonValue]>, prefix: string, tables: AggTable[], metricRows: Cell[][]): void {
  for (const [ownName, aggregation] of entries) {
    const name = `${prefix}${ownName}`;
    if (aggregation.kind === 'object' && isSingleBucket(aggregation)) {
      collect(aggregation.entries, `${name}.`, tables, metricRows);
      continue;
    }
    if (prefix && aggregation.kind !== 'object') {
      metricRows.push([{ kind: 'string', value: name }, aggregation]);
      continue;
    }
    if (bucketsOf(aggregation) !== null) {
      const dimensions = [name];
      const metricNames: string[] = [];
      const levels: Level[] = [];
      flatten(aggregation, dimensions, metricNames, [], levels);
      tables.push({
        name,
        columns: [...dimensions, 'doc_count', ...metricNames],
        rows: levels.map((level) => [
          ...dimensions.map((_, index) => level.keys[index] ?? MISSING),
          level.docCount,
          ...metricNames.map((metric) => level.metrics.get(metric) ?? MISSING)
        ])
      });
      continue;
    }
    const single = metricValue(aggregation);
    if (single !== undefined) {
      metricRows.push([{ kind: 'string', value: name }, single]);
    } else if (aggregation.kind === 'object') {
      // 多值指标（stats、percentiles 的 values……）一项一行
      for (const [field, value] of aggregation.entries) {
        if (value.kind === 'object') {
          for (const [inner, innerValue] of value.entries) metricRows.push([{ kind: 'string', value: `${name}.${field}.${inner}` }, innerValue]);
        } else {
          metricRows.push([{ kind: 'string', value: `${name}.${field}` }, value]);
        }
      }
    }
  }
}
