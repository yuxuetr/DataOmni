import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minus, Plus, RotateCcw } from 'lucide-react';
import { useLanguageStore } from '../stores/languageStore';
import type { CypherValue } from '../utils/cypherValue';
import {
  MAX_GRAPH_NODES,
  collectGraph,
  edgeGeometry,
  labelColors,
  layoutGraph,
  nodeCaption,
  relationshipBends,
  type Point
} from '../utils/cypherGraph';

const RADIUS = 18;
const HEIGHT = 480;
const MIN_SCALE = 0.1;
const MAX_SCALE = 3;
/** 按下到抬起挪了不到这么多像素算点击，不算拖动 */
const CLICK_SLOP = 4;
const CAPTION_CHARS = 16;

function slotColor(slot: number | null | undefined): string {
  return slot === null || slot === undefined ? 'var(--dm-fg-subtle)' : `var(--dm-series-${slot + 1})`;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

interface CypherGraphViewProps {
  rows: CypherValue[][];
  selectedId: string | null;
  onInspect: (value: CypherValue) => void;
}

/**
 * 结果画成图。排布、弯线、配色都在 `utils/cypherGraph.ts`，这里只画和处理拖动。
 *
 * 不接滚轮缩放：图嵌在一列可以上下滚的结果里，滚轮被图吃掉就翻不到下一段结果了。
 */
export function CypherGraphView({ rows, selectedId, onInspect }: CypherGraphViewProps) {
  const t = useLanguageStore((state) => state.t);
  const markerId = useId();
  const graph = useMemo(() => collectGraph(rows), [rows]);
  const layout = useMemo(
    () => layoutGraph(
      graph.nodes.map((node) => node.id),
      graph.relationships.map(({ value }) => [value.startElementId, value.endElementId])
    ),
    [graph]
  );
  const bends = useMemo(() => relationshipBends(graph.relationships), [graph]);
  const colors = useMemo(() => labelColors(graph.nodes), [graph]);
  const [moved, setMoved] = useState<Record<string, Point>>({});
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const position = (id: string): Point => moved[id] ?? layout.get(id) ?? { x: 0, y: 0 };

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || layout.size === 0) return;
    const points = [...layout.values()];
    // 圈的半径加上底下那行字
    const left = Math.min(...points.map((point) => point.x)) - RADIUS - 40;
    const right = Math.max(...points.map((point) => point.x)) + RADIUS + 40;
    const top = Math.min(...points.map((point) => point.y)) - RADIUS - 12;
    const bottom = Math.max(...points.map((point) => point.y)) + RADIUS + 24;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(
      viewport.clientWidth / (right - left),
      viewport.clientHeight / (bottom - top),
      1.5
    )));
    setView({
      scale,
      x: viewport.clientWidth / 2 - ((left + right) / 2) * scale,
      y: viewport.clientHeight / 2 - ((top + bottom) / 2) * scale
    });
  }, [layout]);

  // 换了一份结果：拖过的位置作废，重新放进框里
  useLayoutEffect(() => {
    setMoved({});
    fit();
  }, [fit]);

  const zoomBy = (factor: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // 绕框的中心缩放，不然放大两下图就跑出框了
    const centerX = viewport.clientWidth / 2;
    const centerY = viewport.clientHeight / 2;
    setView((current) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor));
      const ratio = scale / current.scale;
      return { scale, x: centerX - (centerX - current.x) * ratio, y: centerY - (centerY - current.y) * ratio };
    });
  };

  /**
   * 按下去之后跟着指针走，抬起时没怎么动就算点了一下。
   * 监听器直接挂在 window 上（与 ER 图同一个理由：以 state 为依赖的 effect 总慢一帧）
   */
  const track = (event: React.PointerEvent, onMove: (dx: number, dy: number) => void, onClick?: () => void) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const origin = { x: event.clientX, y: event.clientY };
    let dragged = false;
    const move = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - origin.x;
      const dy = moveEvent.clientY - origin.y;
      dragged ||= Math.hypot(dx, dy) > CLICK_SLOP;
      if (dragged) onMove(dx, dy);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      if (!dragged) onClick?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };

  const startPan = (event: React.PointerEvent) => {
    const start = view;
    track(event, (dx, dy) => setView({ ...start, x: start.x + dx, y: start.y + dy }));
  };

  const legend = useMemo(() => {
    const labels = new Map<string, number>();
    const types = new Map<string, number>();
    for (const label of colors.labelOf.values()) labels.set(label, (labels.get(label) ?? 0) + 1);
    for (const { value } of graph.relationships) types.set(value.type, (types.get(value.type) ?? 0) + 1);
    return { labels: [...labels.entries()], types: [...types.entries()] };
  }, [graph, colors]);
  const hasPlaceholders = graph.nodes.some((node) => node.value === null);

  return (
    <div className="overflow-hidden rounded-control border border-line">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface-sunken px-2 py-1 text-xs">
        {legend.labels.map(([label, count]) => (
          <span key={`label:${label}`} className="flex items-center gap-1 text-fg">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: slotColor(colors.slots.get(label)) }} />
            {`${label} (${count})`}
          </span>
        ))}
        {legend.types.map(([type, count]) => (
          <span key={`type:${type}`} className="font-mono text-fg-muted">{`[:${type}] (${count})`}</span>
        ))}
        <span className="ml-auto flex items-center gap-1">
          <GraphButton label={t('er.zoomOut')} onClick={() => zoomBy(1 / 1.25)}><Minus size={13} /></GraphButton>
          <span className="w-9 text-center tabular-nums text-fg-muted">{`${Math.round(view.scale * 100)}%`}</span>
          <GraphButton label={t('er.zoomIn')} onClick={() => zoomBy(1.25)}><Plus size={13} /></GraphButton>
          <GraphButton label={t('er.fit')} onClick={fit}><Maximize2 size={13} /></GraphButton>
          <GraphButton label={t('cypher.graph.relayout')} onClick={() => { setMoved({}); fit(); }}><RotateCcw size={13} /></GraphButton>
        </span>
      </div>
      {(graph.omittedNodes > 0 || hasPlaceholders) && (
        <div className="border-b border-line px-2 py-1 text-xs">
          {graph.omittedNodes > 0 && (
            <p className="text-warning">
              {t('cypher.graph.omitted', { limit: MAX_GRAPH_NODES, count: graph.omittedNodes, relationships: graph.omittedRelationships })}
            </p>
          )}
          {hasPlaceholders && <p className="text-fg-muted">{t('cypher.graph.placeholder')}</p>}
        </div>
      )}
      <div
        ref={viewportRef}
        onPointerDown={startPan}
        className="relative cursor-grab bg-canvas active:cursor-grabbing"
        style={{ height: HEIGHT }}
      >
        <svg width="100%" height="100%" className="block select-none">
          <defs>
            {(['idle', 'selected'] as const).map((state) => (
              <marker
                key={state}
                id={`${markerId}-${state}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 10 5 L 0 9 z" style={{ fill: state === 'selected' ? 'var(--dm-accent)' : 'var(--dm-fg-subtle)' }} />
              </marker>
            ))}
          </defs>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
            {/* 先画线再画圈：线从圈边出发，压在圈下面 */}
            {graph.relationships.map(({ id, value }) => {
              const selfLoop = value.startElementId === value.endElementId;
              const geometry = edgeGeometry(position(value.startElementId), position(value.endElementId), bends.get(id) ?? 0, RADIUS, selfLoop);
              const selected = id === selectedId;
              return (
                <g
                  key={id}
                  className="cursor-pointer"
                  onPointerDown={(event) => track(event, () => {}, () => onInspect(value))}
                >
                  <title>{`[:${value.type}]`}</title>
                  {/* 线只有一两像素宽，点不中：底下垫一条透明的粗线 */}
                  <path d={geometry.path} fill="none" stroke="transparent" strokeWidth={10} />
                  <path
                    d={geometry.path}
                    fill="none"
                    style={{ stroke: selected ? 'var(--dm-accent)' : 'var(--dm-fg-subtle)' }}
                    strokeWidth={selected ? 2 : 1.25}
                    markerEnd={`url(#${markerId}-${selected ? 'selected' : 'idle'})`}
                  />
                  <text
                    x={geometry.label.x}
                    y={geometry.label.y}
                    transform={`rotate(${geometry.label.angle} ${geometry.label.x} ${geometry.label.y})`}
                    textAnchor="middle"
                    dy="-3"
                    className="font-mono text-[9px]"
                    style={{
                      fill: selected ? 'var(--dm-accent)' : 'var(--dm-fg-muted)',
                      stroke: 'var(--dm-canvas)',
                      strokeWidth: 3,
                      paintOrder: 'stroke'
                    }}
                  >
                    {value.type}
                  </text>
                </g>
              );
            })}
            {graph.nodes.map((node) => {
              const point = position(node.id);
              const selected = node.id === selectedId;
              const caption = nodeCaption(node);
              const nodeValue = node.value;
              return (
                <g
                  key={node.id}
                  className={nodeValue ? 'cursor-pointer' : 'cursor-grab'}
                  onPointerDown={(event) => {
                    const start = point;
                    const scale = view.scale;
                    track(
                      event,
                      (dx, dy) => setMoved((current) => ({ ...current, [node.id]: { x: start.x + dx / scale, y: start.y + dy / scale } })),
                      nodeValue ? () => onInspect(nodeValue) : undefined
                    );
                  }}
                >
                  <title>{nodeValue ? `${nodeValue.labels.map((label) => `:${label}`).join('')} ${caption}` : node.id}</title>
                  {nodeValue ? (
                    <circle
                      cx={point.x}
                      cy={point.y}
                      r={RADIUS}
                      style={{
                        fill: slotColor(colors.slots.get(colors.labelOf.get(node.id) ?? '')),
                        stroke: selected ? 'var(--dm-accent)' : 'var(--dm-canvas)'
                      }}
                      strokeWidth={selected ? 3 : 1.5}
                    />
                  ) : (
                    <circle
                      cx={point.x}
                      cy={point.y}
                      r={RADIUS}
                      fill="none"
                      style={{ stroke: 'var(--dm-fg-subtle)' }}
                      strokeWidth={1.25}
                      strokeDasharray="3 3"
                    />
                  )}
                  {caption && (
                    <text
                      x={point.x}
                      y={point.y + RADIUS + 12}
                      textAnchor="middle"
                      className="text-[11px]"
                      style={{ fill: 'var(--dm-fg)', stroke: 'var(--dm-canvas)', strokeWidth: 3, paintOrder: 'stroke' }}
                    >
                      {clip(caption, CAPTION_CHARS)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}

function GraphButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded-control border border-line px-1 py-0.5 text-fg-muted hover:bg-surface-hover hover:text-fg"
    >
      {children}
    </button>
  );
}
