import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import type { SerializedResultValue } from '../contracts/resultSet';
import {
  MAX_CHART_POINTS,
  buildChartData,
  chartScale,
  hasSeriesScaleMismatch,
  isChartRejection,
  labelStride,
  suggestChartSpec,
  type ChartRejection,
  type ChartType
} from '../utils/resultChart';
import { useLanguageStore } from '../stores/languageStore';
import { SegmentedControl } from './FormControls';
import type { TranslationKey } from '../i18n/translate';

/**
 * 结果集的快速图表。
 *
 * 「快速」是这个功能的全部定位：看一眼形状，不是做一张能交出去的图。所以没有
 * 标题输入、没有配色选择、没有导出图片——那些会把它变成一个小型报表工具，
 * 而真要出图的人会把数据导出去用别的工具做。
 */

/** 分类色板的槽位，按固定次序分配、不循环。取值见 index.css 的 --dm-series-* */
const SERIES_SLOTS = 8;

/** 超过这么多序列就不画了。第 9 条不去生成新颜色——那必然撞上已有的槽位 */
const MAX_SERIES = SERIES_SLOTS;

const REJECTION_KEYS: Readonly<Record<ChartRejection, TranslationKey>> = {
  'no-rows': 'chart.reject.noRows',
  'no-numeric-column': 'chart.reject.noNumericColumn',
  'too-many-rows': 'chart.reject.tooManyRows'
};

const PLOT = { width: 720, height: 300, left: 64, right: 16, top: 12, bottom: 44 };

interface ResultChartDialogProps {
  columns: readonly string[];
  rows: ReadonlyArray<readonly SerializedResultValue[]>;
  onClose: () => void;
}

export function ResultChartDialog({ columns, rows, onClose }: ResultChartDialogProps) {
  const t = useLanguageStore((state) => state.t);
  const [type, setType] = useState<ChartType>('bar');
  /** null 表示还没动过，用推荐的那一组 */
  const [chosenValues, setChosenValues] = useState<readonly number[] | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const suggestion = useMemo(
    () => suggestChartSpec(columns, rows as SerializedResultValue[][]),
    [columns, rows]
  );

  if (isChartRejection(suggestion)) {
    return (
      <ChartShell onClose={onClose} title={t('chart.title')}>
        <p className="px-5 py-6 text-sm text-fg-muted">
          {t(REJECTION_KEYS[suggestion], { limit: MAX_CHART_POINTS, rows: rows.length })}
        </p>
      </ChartShell>
    );
  }

  const numericIndexes = suggestion.valueIndexes;
  /**
   * 默认只画第一列数值。
   *
   * 把所有数值列一起放到同一根纵轴上，是这类图最常见的错法：一份
   * `SELECT region, orders, revenue` 里 orders 是十几、revenue 是几百，
   * 同轴之下 orders 那组柱子等于不存在。而两根纵轴更糟——同一个高度在图上
   * 表示两个不同的量。所以默认一列，其余交给用户自己勾。
   */
  const selected = (chosenValues ?? numericIndexes.slice(0, 1)).slice(0, MAX_SERIES);
  const spec = { type, categoryIndex: suggestion.categoryIndex, valueIndexes: selected };
  const data = buildChartData(spec, columns, rows as SerializedResultValue[][]);
  const scale = chartScale(data);

  const toggleValue = (index: number) => {
    setChosenValues((current) => {
      const base = current ?? numericIndexes.slice(0, 1);
      const next = base.includes(index)
        ? base.filter((candidate) => candidate !== index)
        // 保持原始列序，勾选次序不该改变颜色与图例的顺序
        : [...base, index].sort((left, right) => left - right);
      // 一条都不留会得到一张空图，而「把序列勾回来」的入口就在这张空图旁边
      return next.length === 0 ? base : next;
    });
  };

  const innerWidth = PLOT.width - PLOT.left - PLOT.right;
  const innerHeight = PLOT.height - PLOT.top - PLOT.bottom;
  const toY = (value: number) =>
    PLOT.top + innerHeight - ((value - scale.min) / (scale.max - scale.min)) * innerHeight;
  const bandWidth = innerWidth / Math.max(1, data.categories.length);
  // 轴上最多摆这么多标签：每个标签按 6 个字符算，再挤就是一团糊
  const stride = labelStride(data.categories.length, Math.max(2, Math.floor(innerWidth / 56)));
  const baseline = toY(Math.max(scale.min, Math.min(0, scale.max)));

  return (
    <ChartShell onClose={onClose} title={t('chart.title')}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-5 py-2.5">
        <SegmentedControl
          value={type}
          onChange={setType}
          options={[
            { value: 'bar', label: t('chart.type.bar') },
            { value: 'line', label: t('chart.type.line') }
          ]}
        />
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs text-fg-muted">{t('chart.values')}</span>
          {numericIndexes.map((index) => (
            <label key={index} className="flex cursor-pointer items-center gap-1.5 text-xs text-fg">
              <input
                type="checkbox"
                checked={selected.includes(index)}
                onChange={() => toggleValue(index)}
                className="h-3.5 w-3.5 accent-[var(--dm-accent)]"
              />
              <span className="max-w-[10rem] truncate font-mono">{columns[index]}</span>
            </label>
          ))}
        </div>
        <span className="text-xs text-fg-subtle">
          {spec.categoryIndex === null
            ? t('chart.categoryIsRowNumber')
            : t('chart.categoryIs', { column: columns[spec.categoryIndex] ?? '' })}
        </span>
      </div>

      {/* 量级差得远时把它说出来。不拒绝画（列是用户自己勾的），也不开第二根
          纵轴——那样同一个高度在图上就表示两个不同的量 */}
      {hasSeriesScaleMismatch(data) && (
        <p className="px-5 pt-2.5 text-xs text-warning">{t('chart.scaleMismatch')}</p>
      )}

      {/* 图例总是画出来：分类色板里有几个槽位对底色的对比度低于 3:1，
          只靠颜色认序列在那几个槽位上不成立。一条序列时不画框，标题已经写了它 */}
      {data.series.length > 1 && (
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 pt-2.5">
          {data.series.map((series, slot) => (
            <li key={series.name} className="flex items-center gap-1.5 text-xs text-fg">
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                style={{ background: seriesColor(slot) }}
              />
              <span className="max-w-[12rem] truncate font-mono">{series.name}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="overflow-x-auto px-5 py-3">
        <svg
          viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
          className="h-auto w-full min-w-[520px]"
          role="img"
          aria-label={t('chart.ariaLabel', {
            series: data.series.map((series) => series.name).join(', '),
            count: data.categories.length
          })}
        >
          {/* 网格与轴退到背景里：它们是刻度尺，不是数据 */}
          {scale.ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PLOT.left}
                x2={PLOT.width - PLOT.right}
                y1={toY(tick)}
                y2={toY(tick)}
                stroke="var(--dm-line)"
                strokeWidth={1}
              />
              <text
                x={PLOT.left - 8}
                y={toY(tick)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-[var(--dm-fg-subtle)] text-[10px]"
              >
                {formatTick(tick)}
              </text>
            </g>
          ))}

          {/* 有负值时零线要能看出来，否则「往下长的柱子」没有参照 */}
          {scale.min < 0 && scale.max > 0 && (
            <line
              x1={PLOT.left}
              x2={PLOT.width - PLOT.right}
              y1={baseline}
              y2={baseline}
              stroke="var(--dm-line-strong)"
              strokeWidth={1}
            />
          )}

          {type === 'bar'
            ? data.series.map((series, slot) =>
                series.points.map((point, pointIndex) => {
                  if (point === null) {
                    return null;
                  }
                  // 同一组里几条序列并排；组间留出 2px 的底色缝，
                  // 挨在一起的填色会让两根柱子读成一根
                  const groupWidth = bandWidth * 0.72;
                  const barWidth = Math.max(1, groupWidth / data.series.length - 2);
                  const x =
                    PLOT.left
                    + pointIndex * bandWidth
                    + (bandWidth - groupWidth) / 2
                    + slot * (groupWidth / data.series.length);
                  return (
                    <path
                      key={`${series.name}-${pointIndex}`}
                      d={barPath(x, barWidth, toY(point), baseline)}
                      fill={seriesColor(slot)}
                    >
                      <title>{`${data.categories[pointIndex]} · ${series.name}: ${point}`}</title>
                    </path>
                  );
                })
              )
            : data.series.map((series, slot) => (
                <g key={series.name}>
                  {linePaths(series.points, (index) => PLOT.left + (index + 0.5) * bandWidth, toY).map(
                    (path, segment) => (
                      <path
                        key={segment}
                        d={path}
                        fill="none"
                        stroke={seriesColor(slot)}
                        strokeWidth={2}
                        strokeLinecap="round"
                      />
                    )
                  )}
                  {series.points.map((point, pointIndex) =>
                    point === null ? null : (
                      <circle
                        key={pointIndex}
                        cx={PLOT.left + (pointIndex + 0.5) * bandWidth}
                        cy={toY(point)}
                        r={4}
                        fill={seriesColor(slot)}
                        // 交叠处用底色描一圈，两条线压在一起时还分得清
                        stroke="var(--dm-surface-raised)"
                        strokeWidth={2}
                      >
                        <title>{`${data.categories[pointIndex]} · ${series.name}: ${point}`}</title>
                      </circle>
                    )
                  )}
                </g>
              ))}

          {data.categories.map((category, index) =>
            index % stride === 0 || index === data.categories.length - 1 ? (
              <text
                key={index}
                x={PLOT.left + (index + 0.5) * bandWidth}
                y={PLOT.height - PLOT.bottom + 16}
                textAnchor="middle"
                className="fill-[var(--dm-fg-muted)] text-[10px]"
              >
                {truncate(category, 10)}
              </text>
            ) : null
          )}
        </svg>
      </div>
    </ChartShell>
  );
}

function ChartShell({
  title,
  children,
  onClose
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="result-chart-title"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-[820px] max-w-[calc(100vw-2rem)] flex-col overflow-auto rounded-panel bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3">
          <h3 id="result-chart-title" className="text-sm font-semibold text-fg">
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-control p-1 text-fg-muted transition-colors hover:bg-surface-hover"
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * 一根柱子：只有**数据那一端**是圆角，贴着基线那一端是方的。
 *
 * 四角全圆会让柱子看起来浮在轴上方，而柱状图读的正是「从基线量到这里有多长」。
 * 负值的柱子往下长，圆角也就跟着换到下端。
 */
function barPath(x: number, width: number, valueY: number, baselineY: number): string {
  const radius = Math.min(4, width / 2, Math.abs(valueY - baselineY));
  const right = x + width;

  if (valueY <= baselineY) {
    return [
      `M${x} ${baselineY}`,
      `L${x} ${valueY + radius}`,
      `Q${x} ${valueY} ${x + radius} ${valueY}`,
      `L${right - radius} ${valueY}`,
      `Q${right} ${valueY} ${right} ${valueY + radius}`,
      `L${right} ${baselineY}`,
      'Z'
    ].join(' ');
  }

  return [
    `M${x} ${baselineY}`,
    `L${x} ${valueY - radius}`,
    `Q${x} ${valueY} ${x + radius} ${valueY}`,
    `L${right - radius} ${valueY}`,
    `Q${right} ${valueY} ${right} ${valueY - radius}`,
    `L${right} ${baselineY}`,
    'Z'
  ].join(' ');
}

function seriesColor(slot: number): string {
  // 固定次序取槽位，不取模循环：循环会让第 9 条序列和第 1 条同色
  return `var(--dm-series-${Math.min(slot, SERIES_SLOTS - 1) + 1})`;
}

/**
 * 折线按「连续的非空段」分开画。
 *
 * 跨过一个缺失值直连前后两点，会画出一段并不存在的趋势——而那正是读折线图的
 * 人最先相信的东西。断开比连上诚实。
 */
function linePaths(
  points: readonly (number | null)[],
  toX: (index: number) => number,
  toY: (value: number) => number
): string[] {
  const paths: string[] = [];
  let current: string[] = [];

  points.forEach((point, index) => {
    if (point === null) {
      if (current.length > 1) {
        paths.push(current.join(' '));
      }
      current = [];
      return;
    }
    current.push(`${current.length === 0 ? 'M' : 'L'}${toX(index)} ${toY(point)}`);
  });

  if (current.length > 1) {
    paths.push(current.join(' '));
  }
  return paths;
}

/** 刻度上的数字：大数收成 k / M，否则一根 64px 宽的纵轴放不下 1200000 */
function formatTick(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) {
    return `${trimZero(value / 1_000_000)}M`;
  }
  if (absolute >= 1_000) {
    return `${trimZero(value / 1_000)}k`;
  }
  return String(value);
}

function trimZero(value: number): string {
  return String(Number(value.toFixed(1)));
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
