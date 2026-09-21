import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Loader2, Maximize2, Minus, Plus } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useQueryStore } from '../stores/queryStore';
import { useLanguageStore } from '../stores/languageStore';
import { describeError } from '../utils/describeError';
import {
  DEFAULT_ER_METRICS,
  columnAnchor,
  layoutErDiagram,
  tableKey,
  toErLinks,
  toErTables,
  type ErLayoutResult,
  type ErLink,
  type ErNode
} from '../utils/erLayout';
import type { ConnectionProfile } from '../contracts';

interface ErDiagramQueries {
  columns: string;
  foreign_keys: string;
  parameter_count: number;
}

interface ErDiagramViewProps {
  connection: ConnectionProfile;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 2;
const METRICS = DEFAULT_ER_METRICS;

/**
 * 整库的 ER 关系图。
 *
 * 布局全在 `erLayout` 里算好（纯函数、有单测），这里只负责把算好的坐标画出来
 * 并处理缩放与平移。连线接的是**列自己那一行**，不是框的中心——否则只看得出
 * 「这两张表有关系」，看不出是哪两个字段在关联。
 */
export function ErDiagramView({ connection }: ErDiagramViewProps) {
  const { database } = useQueryStore();
  const t = useLanguageStore((state) => state.t);

  const [layout, setLayout] = useState<ErLayoutResult | null>(null);
  const [links, setLinks] = useState<ErLink[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setError(null);
      setLayout(null);

      try {
        const queries = await invoke<ErDiagramQueries>('get_er_diagram_queries', {
          dbType: connection.db_type
        });

        if (queries.parameter_count > 0 && !connection.database) {
          throw new Error(t('er.noDatabaseName'));
        }
        const params = Array.from(
          { length: queries.parameter_count },
          () => connection.database
        );

        const [columnRows, linkRows] = await Promise.all([
          database!.select(queries.columns, params),
          database!.select(queries.foreign_keys, params)
        ]);

        const tables = toErTables(Array.isArray(columnRows) ? columnRows : []);
        const diagramLinks = toErLinks(Array.isArray(linkRows) ? linkRows : []);

        if (!cancelled) {
          setLinks(diagramLinks);
          setLayout(layoutErDiagram(tables, diagramLinks, METRICS));
        }
      } catch (cause) {
        if (!cancelled) {
          setError(describeError(cause, t('er.loadFailed')));
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [connection, database, t]);

  if (error) {
    return (
      <p className="flex items-start gap-2 px-4 py-3 text-xs text-danger">
        <AlertCircle size={14} className="mt-0.5 shrink-0" />
        <span className="min-w-0 flex-1 break-words">{error}</span>
      </p>
    );
  }

  if (!layout) {
    return (
      <p className="flex items-center gap-2 px-4 py-3 text-xs text-fg-subtle">
        <Loader2 size={14} className="animate-spin" />
        {t('er.loading')}
      </p>
    );
  }

  if (layout.nodes.length === 0) {
    return <p className="px-4 py-3 text-xs text-fg-subtle">{t('er.empty')}</p>;
  }

  return <ErDiagramCanvas layout={layout} links={links} />;
}

/**
 * 画布本身：拿到算好的布局就能画，不依赖连接。
 * 拆出来是为了能单独喂数据渲染核对版式。
 */
export function ErDiagramCanvas({
  layout,
  links
}: {
  layout: ErLayoutResult;
  links: ErLink[];
}) {
  const t = useLanguageStore((state) => state.t);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);

  const nodesByKey = useMemo(
    () => new Map(layout.nodes.map(node => [node.key, node])),
    [layout]
  );

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const next = Math.min(
      viewport.clientWidth / layout.width,
      viewport.clientHeight / layout.height,
      1
    );
    setScale(Math.max(MIN_SCALE, next));
    setOffset({ x: 0, y: 0 });
  }, [layout]);

  // 拖动平移。监听器在 pointerdown 里直接挂，不走以 state 为依赖的 effect——
  // 那样挂上去的监听器总是慢一帧，第一次拖动会没反应。
  const startPan = (event: React.PointerEvent) => {
    if (event.button !== 0) {
      return;
    }
    const origin = { x: event.clientX, y: event.clientY };
    const start = offset;

    const move = (moveEvent: PointerEvent) => {
      setOffset({
        x: start.x + (moveEvent.clientX - origin.x),
        y: start.y + (moveEvent.clientY - origin.y)
      });
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };

  const zoomBy = (factor: number) =>
    setScale(current => Math.min(MAX_SCALE, Math.max(MIN_SCALE, current * factor)));

  const linkedKeys = new Set(links.flatMap(link => [link.from.table, link.to.table]));
  const unlinked = layout.nodes.filter(node => !linkedKeys.has(node.key)).length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-line bg-surface-sunken px-4 py-2">
        <span className="text-xs text-fg-muted">
          {t('er.summary', { tables: layout.nodes.length, links: links.length })}
        </span>
        {unlinked > 0 && (
          <span className="text-xs text-fg-subtle">{t('er.unlinkedNote', { count: unlinked })}</span>
        )}
        <span className="ml-auto text-xs text-fg-subtle">{t('er.panHint')}</span>
        <div className="flex items-center gap-1">
          <ToolButton label={t('er.zoomOut')} onClick={() => zoomBy(1 / 1.2)}>
            <Minus size={13} />
          </ToolButton>
          <span className="w-10 text-center text-xs tabular-nums text-fg-muted">
            {Math.round(scale * 100)}%
          </span>
          <ToolButton label={t('er.zoomIn')} onClick={() => zoomBy(1.2)}>
            <Plus size={13} />
          </ToolButton>
          <ToolButton label={t('er.fit')} onClick={fit}>
            <Maximize2 size={13} />
          </ToolButton>
        </div>
      </div>

      <div
        ref={viewportRef}
        onPointerDown={startPan}
        className="relative min-h-0 flex-1 cursor-grab overflow-hidden bg-canvas active:cursor-grabbing"
      >
        <svg
          width={layout.width * scale}
          height={layout.height * scale}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
          className="select-none"
        >
          {/* 先画线再画框：线从框的边缘出发，压在框下面才不会盖住列名 */}
          <g>
            {links.map((link, index) => (
              <LinkPath
                key={`${link.constraintName}:${link.from.table}.${link.from.column}:${index}`}
                link={link}
                nodesByKey={nodesByKey}
              />
            ))}
          </g>
          {layout.nodes.map(node => (
            <TableBox key={node.key} node={node} />
          ))}
        </svg>
      </div>
    </div>
  );
}

function ToolButton({
  label,
  onClick,
  children
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded-control border border-line px-1.5 py-1 text-fg-muted hover:bg-surface-hover hover:text-fg"
    >
      {children}
    </button>
  );
}

function TableBox({ node }: { node: ErNode }) {
  return (
    <g>
      <rect
        x={node.x}
        y={node.y}
        width={node.width}
        height={node.height}
        rx={6}
        className="fill-surface stroke-line-strong"
        strokeWidth={1}
      />
      <rect
        x={node.x}
        y={node.y}
        width={node.width}
        height={METRICS.headerHeight}
        rx={6}
        className="fill-surface-sunken"
      />
      {/* 盖住表头圆角的下半部分，让表头与列之间是一条直的分隔线 */}
      <rect
        x={node.x}
        y={node.y + METRICS.headerHeight - 6}
        width={node.width}
        height={6}
        className="fill-surface-sunken"
      />
      <line
        x1={node.x}
        y1={node.y + METRICS.headerHeight}
        x2={node.x + node.width}
        y2={node.y + METRICS.headerHeight}
        className="stroke-line"
        strokeWidth={1}
      />
      <text
        x={node.x + 10}
        y={node.y + METRICS.headerHeight / 2 + 4}
        className="fill-fg text-[12px] font-medium"
      >
        {node.table.name}
      </text>
      {node.table.schema && (
        <text
          x={node.x + node.width - 10}
          y={node.y + METRICS.headerHeight / 2 + 4}
          textAnchor="end"
          className="fill-fg-subtle text-[10px]"
        >
          {node.table.schema}
        </text>
      )}

      {node.table.columns.map((column, index) => {
        const y = node.y + METRICS.headerHeight + index * METRICS.rowHeight;
        return (
          <g key={column.name}>
            <text
              x={node.x + 10}
              y={y + METRICS.rowHeight / 2 + 3.5}
              className={column.isPrimaryKey ? 'fill-accent text-[11px] font-medium' : 'fill-fg text-[11px]'}
            >
              {column.isPrimaryKey ? `🔑 ${column.name}` : column.name}
            </text>
            <text
              x={node.x + node.width - 10}
              y={y + METRICS.rowHeight / 2 + 3.5}
              textAnchor="end"
              className="fill-fg-subtle text-[10px]"
            >
              {column.dataType}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/**
 * 一条外键连线。
 *
 * 从两个框各自**那一列**的锚点出发；起止点分别取左右两侧中距离更近的一侧，
 * 免得线绕过整个框再连回来。中间用三次贝塞尔，控制点水平外推，
 * 使线离开与进入框时都是水平的。
 */
function LinkPath({
  link,
  nodesByKey
}: {
  link: ErLink;
  nodesByKey: ReadonlyMap<string, ErNode>;
}) {
  const fromNode = nodesByKey.get(link.from.table);
  const toNode = nodesByKey.get(link.to.table);
  if (!fromNode || !toNode) {
    return null;
  }

  const from = columnAnchor(fromNode, link.from.column, METRICS);
  const to = columnAnchor(toNode, link.to.column, METRICS);
  if (!from || !to) {
    return null;
  }

  const fromRight = fromNode.x + fromNode.width / 2 <= toNode.x + toNode.width / 2;
  const startX = fromRight ? from.rightX : from.leftX;
  const endX = fromRight ? to.leftX : to.rightX;
  const reach = Math.max(32, Math.abs(endX - startX) / 2);
  const c1 = fromRight ? startX + reach : startX - reach;
  const c2 = fromRight ? endX - reach : endX + reach;

  return (
    <g className="text-accent">
      <path
        d={`M ${startX} ${from.y} C ${c1} ${from.y}, ${c2} ${to.y}, ${endX} ${to.y}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeOpacity={0.7}
      />
      <circle cx={startX} cy={from.y} r={2.5} fill="currentColor" />
      <circle cx={endX} cy={to.y} r={2.5} fill="currentColor" />
    </g>
  );
}

export { tableKey };
