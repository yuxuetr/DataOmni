import type { SerializedResultValue } from '../contracts/resultSet';

/**
 * 「把这份结果画成图」需要的全部判断。
 *
 * 只做纯函数：选哪几列、每个点的值是多少、纵轴刻度落在哪。组件只负责把算好的
 * 数字摆成 SVG。这样「为什么这一列被当成了数值」这类问题有测试可查，
 * 而不是要在界面上反复试。
 */

/** 一次最多画多少个点。超过就不画，也不悄悄采样 */
export const MAX_CHART_POINTS = 200;

export type ChartType = 'bar' | 'line';

export interface ChartSpec {
  readonly type: ChartType;
  /** 横轴那一列的下标；null 表示按行号排，没有合适的分类列时如此 */
  readonly categoryIndex: number | null;
  /** 纵轴的一列或多列下标，按原始列序 */
  readonly valueIndexes: readonly number[];
}

/** 画不了的原因。给出原因而不是灰掉按钮：用户想知道差在哪 */
export type ChartRejection = 'no-rows' | 'no-numeric-column' | 'too-many-rows';

export interface ChartSeries {
  readonly name: string;
  /** 与 categories 一一对应；不是数字的格子是 null，不当成 0 */
  readonly points: readonly (number | null)[];
}

export interface ChartData {
  readonly categories: readonly string[];
  readonly series: readonly ChartSeries[];
}

/**
 * 把一个结果格子读成数字。
 *
 * `bigint` / `decimal` 是带类型标签的对象（后端为了不丢精度序列化成字符串），
 * 画图时转成 double 是可以接受的——图上一个像素远粗于 double 的精度损失。
 * 但布尔**不**转：`true` 变成 1 会让一列状态位画出一张看着像数据的图。
 */
export function chartValue(cell: SerializedResultValue): number | null {
  if (typeof cell === 'number') {
    return Number.isFinite(cell) ? cell : null;
  }
  if (typeof cell === 'string') {
    // 空串不是 0：`Number('')` 给 0，会把缺失值画成一个真实的低点
    const trimmed = cell.trim();
    if (trimmed === '') {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (cell !== null && typeof cell === 'object' && (cell.type === 'bigint' || cell.type === 'decimal')) {
    const parsed = Number(cell.value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 分类轴上的标签。null 显示成空而不是 "null"——轴上不需要这个词 */
export function chartLabel(cell: SerializedResultValue): string {
  if (cell === null) {
    return '';
  }
  if (typeof cell === 'object') {
    return cell.value;
  }
  return String(cell);
}

/**
 * 一列能不能当纵轴：抽样看它的**实际值**，不看声明类型。
 *
 * 为什么不用 `column_metadata`：查询结果的列常常是表达式（`count(*)`、
 * `sum(x)/count(*)`、`CASE …`），驱动给的声明类型未必可靠，而聚合列恰好是
 * 最想画的那些。抽样问的是「这一列的值是不是数字」，那正是画图需要的条件。
 */
function isNumericColumn(rows: readonly SerializedResultValue[][], index: number): boolean {
  let seen = 0;
  for (const row of rows) {
    const cell = row[index];
    if (cell === null || cell === undefined) {
      continue;
    }
    // 布尔挡在这里：`chartValue` 不认布尔，但一列全 null 加几个 true 会
    // 「一个非空值都没看到」而落到下面的 false，两条路殊途同归；
    // 显式写出来是为了让意图可读
    if (typeof cell === 'boolean') {
      return false;
    }
    if (chartValue(cell) === null) {
      return false;
    }
    seen += 1;
  }
  return seen > 0;
}

/**
 * 给这份结果挑一组默认的画法。
 *
 * 规则简单到能一句话说清：所有数值列当纵轴，第一个非数值列当横轴。挑不出
 * 纵轴就不画。**默认用柱状图**——查询结果里最常见的形状是「分组 + 聚合值」，
 * 那是柱状图；折线图要求横轴本身有次序，而一份 `GROUP BY` 的结果没有。
 */
export function suggestChartSpec(
  columns: readonly string[],
  rows: readonly SerializedResultValue[][]
): ChartSpec | ChartRejection {
  if (rows.length === 0) {
    return 'no-rows';
  }
  if (rows.length > MAX_CHART_POINTS) {
    return 'too-many-rows';
  }

  const valueIndexes: number[] = [];
  let categoryIndex: number | null = null;
  for (let index = 0; index < columns.length; index += 1) {
    if (isNumericColumn(rows, index)) {
      valueIndexes.push(index);
    } else if (categoryIndex === null) {
      categoryIndex = index;
    }
  }

  if (valueIndexes.length === 0) {
    return 'no-numeric-column';
  }

  return { type: 'bar', categoryIndex, valueIndexes };
}

export function isChartRejection(spec: ChartSpec | ChartRejection): spec is ChartRejection {
  return typeof spec === 'string';
}

export function buildChartData(
  spec: ChartSpec,
  columns: readonly string[],
  rows: readonly SerializedResultValue[][]
): ChartData {
  const categories = rows.map((row, rowIndex) =>
    spec.categoryIndex === null
      ? String(rowIndex + 1)
      : chartLabel(row[spec.categoryIndex] ?? null)
  );

  const series = spec.valueIndexes.map((index) => ({
    name: columns[index] ?? '',
    points: rows.map((row) => chartValue(row[index] ?? null))
  }));

  return { categories, series };
}

export interface ChartScale {
  readonly min: number;
  readonly max: number;
  readonly ticks: readonly number[];
}

/**
 * 纵轴的范围与刻度。
 *
 * 两条刻意的取舍：
 *
 * - **全是正数时从 0 起**。截断的纵轴会让 1000 和 1010 看起来差一倍，
 *   而柱状图的长度本身就是在表达「多少」。有负值时才让下界跟着数据走。
 * - 刻度取 1 / 2 / 5 × 10ⁿ。任意等分会得到 0、3.67、7.34 这样的刻度，
 *   读图的人得先做一次除法才知道一根柱子是多少。
 */
export function chartScale(data: ChartData, tickCount = 4): ChartScale {
  const values = data.series
    .flatMap((series) => series.points)
    .filter((point): point is number => point !== null);

  if (values.length === 0) {
    return { min: 0, max: 1, ticks: [0, 1] };
  }

  const dataMax = Math.max(...values);
  const dataMin = Math.min(...values);
  const lower = dataMin > 0 ? 0 : dataMin;
  const upper = dataMax < 0 ? 0 : dataMax;

  if (lower === upper) {
    // 一条水平线：给它一个非零的跨度，否则后面除以 0
    const magnitude = Math.abs(upper) || 1;
    return { min: upper - magnitude, max: upper + magnitude, ticks: [upper - magnitude, upper, upper + magnitude] };
  }

  const step = niceStep((upper - lower) / tickCount);
  const min = Math.floor(lower / step) * step;
  const max = Math.ceil(upper / step) * step;

  const ticks: number[] = [];
  // 按整数步数累加而不是反复 `+= step`：浮点累加会让 0.1 步长的刻度
  // 变成 0.30000000000000004
  const steps = Math.round((max - min) / step);
  for (let index = 0; index <= steps; index += 1) {
    ticks.push(roundToStep(min + index * step, step));
  }

  return { min, max, ticks };
}

/** 把一个粗略的步长收成 1 / 2 / 5 × 10ⁿ 里最接近的那个（向上取） */
function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) {
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

/** 按步长的小数位数收尾，去掉浮点乘法带出来的尾巴 */
function roundToStep(value: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return Number(value.toFixed(Math.min(decimals + 1, 20)));
}

/**
 * 几条序列的量级差到「小的那条在图上看不见」的程度时为真。
 *
 * 这是同轴多序列唯一真实的失效方式：`SELECT region, orders, revenue` 里
 * orders 是十几、revenue 是几千，放在一根纵轴上，orders 那组柱子会被压成
 * 贴着基线的一条细边——它在，但读不出来，而读图的人不会怀疑图。
 *
 * 不因此拒绝画（用户明确勾了这两列），也**不**开第二根纵轴——那样同一个
 * 高度在图上就表示两个不同的量，比看不见更糟。只是把这件事说出来。
 *
 * 阈值 50 倍：再小一些两条都还读得出来，再大就只剩一条。
 */
export const SERIES_SCALE_MISMATCH_RATIO = 50;

export function hasSeriesScaleMismatch(data: ChartData): boolean {
  const magnitudes = data.series
    .map((series) => {
      const values = series.points.filter((point): point is number => point !== null);
      return values.length === 0 ? null : Math.max(...values.map(Math.abs));
    })
    .filter((magnitude): magnitude is number => magnitude !== null && magnitude > 0);

  if (magnitudes.length < 2) {
    return false;
  }

  return Math.max(...magnitudes) / Math.min(...magnitudes) > SERIES_SCALE_MISMATCH_RATIO;
}

/**
 * 横轴标签太密时每隔几个显示一个。
 *
 * 挤在一起的标签是一团糊，比没有标签更糟——没有标签至少不会让人以为读得出来。
 * 保证第一个和最后一个一定显示：那两个决定了图的范围。
 */
export function labelStride(count: number, maxLabels: number): number {
  if (count <= maxLabels || maxLabels <= 0) {
    return 1;
  }
  return Math.ceil(count / maxLabels);
}
