import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Download,
  Filter,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Undo2
} from 'lucide-react';
import { clsx } from 'clsx';
import { save } from '@tauri-apps/plugin-dialog';
import {
  rasterizeSvgToJpegBytes,
  rasterizeSvgToPngBase64,
  readCssColor,
  serializeSvgWithInlineStyles
} from '../utils/svgExport';
import { buildSingleImagePdf, bytesToBase64 } from '../utils/pdfExport';
import { invoke } from '@tauri-apps/api/core';
import { useQueryStore } from '../stores/queryStore';
import { useAppStore } from '../stores/appStore';
import { useLanguageStore } from '../stores/languageStore';
import { describeError } from '../utils/describeError';
import {
  DEFAULT_ER_METRICS,
  columnAnchor,
  erSchemas,
  filterErDiagram,
  isErFilterActive,
  layoutErDiagram,
  matchErTables,
  NO_ER_FILTER,
  tableKey,
  toErLinks,
  toErTables,
  truncateLabel,
  type ErFilter,
  type ErLink,
  type ErNode,
  type ErTable
} from '../utils/erLayout';
import type { ConnectionProfile } from '../contracts';
import type { TranslationKey } from '../i18n/translate';
import { requireDatabase } from '../utils/requireDatabase';
import { SegmentedControl } from './FormControls';

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
 * 一行里列名与类型各能放多少个字符宽。
 *
 * 232px 的框去掉两侧 10px 内边距还剩 212px；11px 的无衬线字体一个字符
 * 约 6px，10px 的约 5.4px。留一点空隙，分成 20 / 16 两份。
 */
type ExportFormat = 'svg' | 'png' | 'pdf';

/** 矢量在前：需要放进文档再排版的场景，SVG 才是对的那个 */
const EXPORT_FORMATS: Array<{ format: ExportFormat; labelKey: TranslationKey }> = [
  { format: 'svg', labelKey: 'er.exportSvg' },
  { format: 'png', labelKey: 'er.exportPng' },
  { format: 'pdf', labelKey: 'er.exportPdf' }
];

const NAME_BUDGET = 20;
const TYPE_BUDGET = 16;

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
  // 我们自己执行过 DDL 就会 +1，图跟着重拉。外部改动靠刷新按钮。
  const schemaVersion = useAppStore((state) => state.schemaVersion);

  const [tables, setTables] = useState<ErTable[] | null>(null);
  const [links, setLinks] = useState<ErLink[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setError(null);
      setTables(null);
      if (!database) {
        return;
      }

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
          requireDatabase(database).select(queries.columns, params),
          requireDatabase(database).select(queries.foreign_keys, params)
        ]);

        const diagramTables = toErTables(Array.isArray(columnRows) ? columnRows : []);
        const diagramLinks = toErLinks(Array.isArray(linkRows) ? linkRows : []);

        if (!cancelled) {
          setLinks(diagramLinks);
          setTables(diagramTables);
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
  }, [connection, database, t, schemaVersion, reloadToken]);

  if (error) {
    return (
      <p className="flex items-start gap-2 px-4 py-3 text-xs text-danger">
        <AlertCircle size={14} className="mt-0.5 shrink-0" />
        <span className="min-w-0 flex-1 break-words">{error}</span>
      </p>
    );
  }

  // 未连接是正常状态，不是错误：这个标签会从工作区快照里恢复，
  // 在任何连接建立之前就挂载。画成红色报错等于把正常流程说成故障。
  if (!database) {
    return <p className="px-4 py-3 text-xs text-fg-subtle">{t('er.needsConnection')}</p>;
  }

  if (!tables) {
    return (
      <p className="flex items-center gap-2 px-4 py-3 text-xs text-fg-subtle">
        <Loader2 size={14} className="animate-spin" />
        {t('er.loading')}
      </p>
    );
  }

  if (tables.length === 0) {
    return <p className="px-4 py-3 text-xs text-fg-subtle">{t('er.empty')}</p>;
  }

  return (
    <ErDiagramCanvas
      tables={tables}
      links={links}
      onRefresh={() => setReloadToken(token => token + 1)}
    />
  );
}

/**
 * 画布本身：拿到算好的布局就能画，不依赖连接。
 * 拆出来是为了能单独喂数据渲染核对版式。
 */
export function ErDiagramCanvas({
  tables,
  links,
  onRefresh
}: {
  tables: ErTable[];
  links: ErLink[];
  /** 外部改了结构时用：数据库不会推送这件事，只能主动再查一遍 */
  onRefresh?: () => void;
}) {
  const t = useLanguageStore((state) => state.t);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ErFilter>(NO_ER_FILTER);
  const [filterOpen, setFilterOpen] = useState(false);
  /**
   * 手工挪过的框的偏移量，按 key 存。
   *
   * 存偏移而不是绝对坐标：自动布局在结构变化后会重算，存绝对坐标的话
   * 挪过的框会留在原地，和重排后的其它框叠在一起。
   */
  const [dragOffsets, setDragOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const [exported, setExported] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);



  // 过滤在布局之前：它的整个用处就是让图变小，压暗留不住这份收益
  const visible = useMemo(() => filterErDiagram(tables, links, filter), [tables, links, filter]);
  const layout = useMemo(
    () => layoutErDiagram(visible.tables, visible.links, METRICS),
    [visible]
  );
  // 过滤之后图整个换了形状，而平移是「在旧的那张图上的位置」——不归零的话，
  // 之前往右拖过的人会看到一片空白。缩放不动：那是用户明确选的
  useEffect(() => {
    setOffset({ x: 0, y: 0 });
  }, [filter]);

  const schemas = useMemo(() => erSchemas(tables), [tables]);
  const allKeys = useMemo(
    () => tables.map(table => tableKey(table)).sort((a, b) => a.localeCompare(b)),
    [tables]
  );
  const filtering = isErFilterActive(filter);

  // null = 没在搜索，全亮；空集合 = 搜了但一个都没命中，全暗
  const matches = useMemo(() => matchErTables(layout.nodes, query), [layout, query]);

  // 把手工偏移叠上去，连线自然跟着动——它取的就是这份节点坐标
  const nodes = useMemo(
    () =>
      layout.nodes.map(node => {
        const offset = dragOffsets[node.key];
        return offset ? { ...node, x: node.x + offset.x, y: node.y + offset.y } : node;
      }),
    [layout, dragOffsets]
  );

  /**
   * 拖动一个框。
   *
   * 鼠标位移要除以缩放比例：缩到 50% 时拖 100 个屏幕像素，图上应该走 200，
   * 不除的话缩得越小越拖不动。
   *
   * `stopPropagation` 是必须的——不然这次按下同时会被画布的平移接管，
   * 框和整张图一起动。
   */
  const nodesByKey = useMemo(() => new Map(nodes.map(node => [node.key, node])), [nodes]);

  // 画布要把拖出去的框算进来，不然往右下角一拖就被裁掉
  const canvas = useMemo(() => {
    const right = nodes.reduce((max, node) => Math.max(max, node.x + node.width), layout.width);
    const bottom = nodes.reduce((max, node) => Math.max(max, node.y + node.height), layout.height);
    return { width: right + 32, height: bottom + 32 };
  }, [nodes, layout]);

  const dragNode = (key: string, event: React.PointerEvent) => {
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();

    const origin = { x: event.clientX, y: event.clientY };
    const start = dragOffsets[key] ?? { x: 0, y: 0 };

    const move = (moveEvent: PointerEvent) => {
      setDragOffsets(current => ({
        ...current,
        [key]: {
          x: start.x + (moveEvent.clientX - origin.x) / scale,
          y: start.y + (moveEvent.clientY - origin.y) / scale
        }
      }));
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };

  const resetPositions = () => setDragOffsets({});

  const exportDiagram = async (format: ExportFormat) => {
    const svg = svgRef.current;
    if (!svg) {
      return;
    }

    setExportError(null);
    setExportMenuOpen(false);

    try {
      const path = await save({
        defaultPath: `er-diagram-${new Date().toISOString().slice(0, 10)}.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }]
      });
      // 取消保存对话框不是错误，不该留下任何提示
      if (!path) {
        return;
      }

      setExporting(true);
      const markup = serializeSvgWithInlineStyles(svg, {
        background: readCssColor('--dm-canvas', '#ffffff'),
        width: canvas.width,
        height: canvas.height
      });

      if (format === 'svg') {
        await invoke('write_text_file', { path, contents: markup });
      } else if (format === 'png') {
        const contentsBase64 = await rasterizeSvgToPngBase64(
          markup,
          canvas.width,
          canvas.height
        );
        await invoke('write_binary_file', { path, contentsBase64 });
      } else {
        const image = await rasterizeSvgToJpegBytes(markup, canvas.width, canvas.height);
        const pdf = buildSingleImagePdf({
          image: image.bytes,
          filter: 'DCTDecode',
          imageWidth: image.width,
          imageHeight: image.height,
          // 1 像素 = 1 点：页面尺寸就是图的尺寸，不去凑 A4，
          // 关系图的比例远不是纸张比例，硬塞进去只会留下大片空白
          pageWidth: canvas.width,
          pageHeight: canvas.height
        });
        await invoke('write_binary_file', { path, contentsBase64: bytesToBase64(pdf) });
      }

      setExported(path);
      window.setTimeout(() => setExported(null), 2500);
    } catch (cause) {
      setExportError(describeError(cause, t('er.exportFailed')));
    } finally {
      setExporting(false);
    }
  };

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const next = Math.min(
      viewport.clientWidth / canvas.width,
      viewport.clientHeight / canvas.height,
      1
    );
    setScale(Math.max(MIN_SCALE, next));
    setOffset({ x: 0, y: 0 });
  }, [canvas]);

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

  const linkedKeys = new Set(visible.links.flatMap(link => [link.from.table, link.to.table]));
  const unlinked = layout.nodes.filter(node => !linkedKeys.has(node.key)).length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-line bg-surface-sunken px-4 py-2">
        <span className="text-xs text-fg-muted">
          {t('er.summary', { tables: layout.nodes.length, links: visible.links.length })}
        </span>
        {/* 过滤中要说清楚分母，否则「5 张表」读起来像整个库只有五张 */}
        {filtering && (
          <span className="text-xs text-accent">
            {t('er.filteredOf', { total: tables.length })}
          </span>
        )}
        {unlinked > 0 && (
          <span className="text-xs text-fg-subtle">{t('er.unlinkedNote', { count: unlinked })}</span>
        )}
        <div className="relative ml-auto">
          <ErFilterMenu
            open={filterOpen}
            onOpenChange={setFilterOpen}
            filter={filter}
            onChange={setFilter}
            schemas={schemas}
            tableKeys={allKeys}
            active={filtering}
          />
        </div>
        <div className="relative">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-subtle"
          />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('er.searchPlaceholder')}
            aria-label={t('er.searchPlaceholder')}
            className="w-52 rounded-control border border-line bg-surface py-1 pl-6 pr-2 text-xs text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
          />
        </div>
        {matches && (
          <span className="text-xs text-fg-subtle">
            {t('er.matchCount', { count: matches.size })}
          </span>
        )}
        {exported && (
          <span className="max-w-64 truncate text-xs text-success">
            {t('er.exported', { path: exported })}
          </span>
        )}
        {exportError && <span className="text-xs text-danger">{exportError}</span>}
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
          <ToolButton label={t('er.resetPositions')} onClick={resetPositions}>
            <Undo2 size={13} />
          </ToolButton>
          <div className="relative">
            <ToolButton
              label={t('er.export')}
              onClick={() => setExportMenuOpen(open => !open)}
            >
              {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            </ToolButton>
            {exportMenuOpen && (
              <>
                {/* 点空白处收起来。不铺这一层的话菜单只能靠再点一次按钮关掉 */}
                <div className="fixed inset-0 z-10" onClick={() => setExportMenuOpen(false)} />
                <div className="absolute right-0 top-full z-20 mt-1 w-32 overflow-hidden rounded-control border border-line bg-surface-raised shadow-lg">
                  {EXPORT_FORMATS.map(({ format, labelKey }) => (
                    <button
                      key={format}
                      type="button"
                      onClick={() => void exportDiagram(format)}
                      className="block w-full px-3 py-1.5 text-left text-xs text-fg hover:bg-surface-hover"
                    >
                      {t(labelKey)}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {onRefresh && (
            <ToolButton label={t('er.refresh')} onClick={onRefresh}>
              <RefreshCw size={13} />
            </ToolButton>
          )}
        </div>
      </div>

      <div
        ref={viewportRef}
        onPointerDown={startPan}
        className="relative min-h-0 flex-1 cursor-grab overflow-hidden bg-canvas active:cursor-grabbing"
      >
        {/* 过滤到一张不剩时画布是空白的，而空白看起来像加载失败 */}
        {layout.nodes.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <p className="text-xs text-fg-subtle">{t('er.filteredEmpty')}</p>
            <button
              type="button"
              onClick={() => setFilter(NO_ER_FILTER)}
              className="rounded-control border border-line px-2 py-1 text-xs text-fg-muted hover:bg-surface-hover"
            >
              {t('er.filterClear')}
            </button>
          </div>
        )}
        <svg
          ref={svgRef}
          width={canvas.width * scale}
          height={canvas.height * scale}
          viewBox={`0 0 ${canvas.width} ${canvas.height}`}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
          className="select-none"
        >
          {/* 先画线再画框：线从框的边缘出发，压在框下面才不会盖住列名 */}
          <g>
            {visible.links.map((link, index) => (
              <LinkPath
                key={`${link.constraintName}:${link.from.table}.${link.from.column}:${index}`}
                link={link}
                nodesByKey={nodesByKey}
              />
            ))}
          </g>
          {nodes.map(node => (
            <TableBox
              key={node.key}
              node={node}
              query={query}
              dimmed={matches !== null && !matches.has(node.key)}
              onDragStart={event => dragNode(node.key, event)}
            />
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

function TableBox({
  node,
  query,
  dimmed,
  onDragStart
}: {
  node: ErNode;
  query: string;
  dimmed: boolean;
  onDragStart: (event: React.PointerEvent) => void;
}) {
  const needle = query.trim().toLowerCase();

  return (
    // 没命中的表压暗而不是隐藏：藏起来会让图的形状跟着变，
    // 反而认不出剩下的是哪几张表
    <g opacity={dimmed ? 0.22 : 1} onPointerDown={onDragStart} style={{ cursor: 'grab' }}>
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
        const y = node.y + METRICS.rowHeight / 2 + 3.5 + METRICS.headerHeight + index * METRICS.rowHeight;
        // 列名优先，类型拿剩下的。不截断的话长 enum 会直接压在列名上。
        const name = truncateLabel(column.name, NAME_BUDGET);
        const type = truncateLabel(column.dataType, TYPE_BUDGET);
        const hit = needle.length > 0 && column.name.toLowerCase().includes(needle);
        return (
          <g key={column.name}>
            {hit && (
              <rect
                x={node.x + 1}
                y={y - METRICS.rowHeight / 2 - 3.5}
                width={node.width - 2}
                height={METRICS.rowHeight}
                className="fill-accent-soft"
              />
            )}
            <text
              x={node.x + 10}
              y={y}
              className={
                column.isPrimaryKey ? 'fill-accent text-[11px] font-medium' : 'fill-fg text-[11px]'
              }
            >
              {column.isPrimaryKey ? `🔑 ${name}` : name}
              <title>{column.name}</title>
            </text>
            <text
              x={node.x + node.width - 10}
              y={y}
              textAnchor="end"
              className="fill-fg-subtle text-[10px]"
            >
              {type}
              <title>{column.dataType}</title>
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

  // 自引用：两个锚点在同一个框上，按「哪边更近」算会得到一条从右边缘绕到
  // 左边缘、横穿整张图的线。改成从右侧出去、再从右侧回来的一个环。
  if (fromNode === toNode) {
    const x = fromNode.x + fromNode.width;
    const bulge = 44;
    return (
      <g className="text-accent">
        <path
          d={`M ${x} ${from.y} C ${x + bulge} ${from.y}, ${x + bulge} ${to.y}, ${x} ${to.y}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeOpacity={0.7}
        />
        <circle cx={x} cy={from.y} r={2.5} fill="currentColor" />
        <circle cx={x} cy={to.y} r={2.5} fill="currentColor" />
      </g>
    );
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

/**
 * 过滤菜单。
 *
 * 与搜索框并排，而它们做的是相反的事：搜索压暗，过滤删掉。所以按钮在过滤
 * 生效时会亮起来——「图上只有五张表」和「这个库只有五张表」必须一眼分得开。
 */
function ErFilterMenu({
  open,
  onOpenChange,
  filter,
  onChange,
  schemas,
  tableKeys,
  active
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filter: ErFilter;
  onChange: (filter: ErFilter) => void;
  schemas: readonly string[];
  tableKeys: readonly string[];
  active: boolean;
}) {
  const t = useLanguageStore((state) => state.t);

  const toggleSchema = (schema: string) => {
    const next = filter.schemas.includes(schema)
      ? filter.schemas.filter((item) => item !== schema)
      : [...filter.schemas, schema];
    onChange({ ...filter, schemas: next });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-label={t('er.filter')}
        className={clsx(
          'flex items-center gap-1 rounded-control border px-2 py-1 text-xs transition-colors',
          active
            ? 'border-accent-line bg-accent-soft text-accent'
            : 'border-line text-fg-muted hover:bg-surface-hover'
        )}
      >
        <Filter size={12} />
        {t('er.filter')}
      </button>

      {open && (
        <>
          {/* 点外面关掉。菜单里有复选框和下拉，失焦关闭会在选到一半时把它收走 */}
          <div className="fixed inset-0 z-10" onClick={() => onOpenChange(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-72 space-y-3 rounded-panel border border-line bg-surface-raised p-3 shadow-xl">
            {/* schema 只有一个时这个选择没有意义，不占位置 */}
            {schemas.length > 1 && (
              <div>
                <p className="mb-1 text-xs text-fg-muted">{t('er.filterSchema')}</p>
                <div className="max-h-32 space-y-0.5 overflow-y-auto">
                  {schemas.map((schema) => (
                    <label key={schema} className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={filter.schemas.includes(schema)}
                        onChange={() => toggleSchema(schema)}
                        className="accent-accent"
                      />
                      <span className="truncate text-xs text-fg">{schema}</span>
                    </label>
                  ))}
                </div>
                {filter.schemas.length === 0 && (
                  <p className="mt-0.5 text-xs text-fg-subtle">{t('er.filterSchemaAll')}</p>
                )}
              </div>
            )}

            <div>
              <p className="mb-1 text-xs text-fg-muted">{t('er.filterFocus')}</p>
              <select
                value={filter.focus ?? ''}
                onChange={(event) =>
                  onChange({ ...filter, focus: event.target.value || null })
                }
                className="w-full rounded-control border border-line bg-surface px-1.5 py-1 text-xs text-fg"
              >
                <option value="">{t('er.filterFocusNone')}</option>
                {tableKeys.map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-xs text-fg-subtle">{t('er.filterDepth')}</span>
                <SegmentedControl<string>
                  value={String(filter.depth)}
                  options={[1, 2, 3].map((depth) => ({
                    value: String(depth),
                    label: String(depth)
                  }))}
                  onChange={(value) => onChange({ ...filter, depth: Number(value) })}
                  disabled={filter.focus === null}
                />
              </div>
            </div>

            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={filter.hideUnlinked}
                onChange={(event) =>
                  onChange({ ...filter, hideUnlinked: event.target.checked })
                }
                className="mt-0.5 accent-accent"
              />
              <span className="min-w-0">
                <span className="text-xs text-fg">{t('er.filterHideUnlinked')}</span>
                <span className="block text-xs text-fg-subtle">
                  {t('er.filterHideUnlinkedNote')}
                </span>
              </span>
            </label>

            <button
              type="button"
              disabled={!active}
              onClick={() => onChange(NO_ER_FILTER)}
              className="w-full rounded-control border border-line px-2 py-1 text-xs text-fg-muted hover:bg-surface-hover disabled:opacity-40"
            >
              {t('er.filterClear')}
            </button>
          </div>
        </>
      )}
    </>
  );
}
