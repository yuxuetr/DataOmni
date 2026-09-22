/**
 * ER 关系图的布局。
 *
 * 纯函数：给一组表和外键，算出每个框放在哪、多大。渲染只负责照着画。
 * 这样「会不会重叠」「孤立的表有没有被漏掉」这类问题能在单测里回答，
 * 而不是靠盯着截图看。
 */

export interface ErColumn {
  name: string;
  dataType: string;
  isPrimaryKey: boolean;
  isNullable: boolean;
}

export interface ErTable {
  /** PostgreSQL 才有；同名不同 schema 的表是两张不同的表 */
  schema: string | null;
  name: string;
  columns: ErColumn[];
}

export interface ErLink {
  constraintName: string;
  from: { table: string; column: string };
  to: { table: string; column: string };
}

export interface ErNode {
  /** `schema.table`，没有 schema 时就是表名 */
  key: string;
  table: ErTable;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ErLayoutResult {
  nodes: ErNode[];
  width: number;
  height: number;
}

export interface ErMetrics {
  nodeWidth: number;
  headerHeight: number;
  rowHeight: number;
  /** 同一个分组内相邻两列之间的水平间距 */
  columnGap: number;
  /** 同一列内相邻两个框之间的垂直间距 */
  nodeGap: number;
  /** 两个连通分量之间的垂直间距 */
  groupGap: number;
  padding: number;
  /** 孤立的表按几列排。每张各占一行会把图拉得极长而右边全空。 */
  isolatedColumns: number;
}

export const DEFAULT_ER_METRICS: ErMetrics = {
  nodeWidth: 232,
  headerHeight: 30,
  rowHeight: 20,
  columnGap: 96,
  nodeGap: 28,
  groupGap: 48,
  padding: 32,
  isolatedColumns: 4
};

export function tableKey(table: Pick<ErTable, 'schema' | 'name'>): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

export function layoutErDiagram(
  tables: readonly ErTable[],
  links: readonly ErLink[],
  metrics: ErMetrics = DEFAULT_ER_METRICS
): ErLayoutResult {
  // 先按 key 排序：布局必须与输入顺序无关，否则每次刷新图都换一个样子，
  // 没法拿两次结果对照着看
  const sorted = [...tables].sort((left, right) => tableKey(left).localeCompare(tableKey(right)));
  const byKey = new Map(sorted.map(table => [tableKey(table), table]));

  // 悬空引用要丢掉：跨库外键、或元数据只读了一半，都会留下指向不存在的表的边。
  // 不丢的话后面会按它造出一个没有列的幽灵节点。
  const realLinks = links.filter(
    link => byKey.has(link.from.table) && byKey.has(link.to.table)
  );

  const groups = connectedGroups(sorted.map(tableKey), realLinks);
  // 有关联的分组在上、孤立的表在下：打开图最先看到的应该是主干
  const linkedGroups = groups.filter(group => group.length > 1);
  const isolated = groups.filter(group => group.length === 1).map(group => group[0]);

  const nodes: ErNode[] = [];
  let cursorY = metrics.padding;

  for (const group of linkedGroups) {
    // 传表而不是键：realLinks 已经滤掉悬空引用，分组里不会再出现查不到的键，
    // 于是 layoutGroup 里不需要一个「查不到就跳过」的分支
    const placed = layoutGroup(
      group.map(key => ({ key, table: byKey.get(key)! })),
      realLinks,
      metrics,
      cursorY
    );
    nodes.push(...placed.nodes);
    cursorY = placed.nextY + metrics.groupGap;
  }

  nodes.push(
    ...layoutIsolated(
      isolated.map(key => ({ key, table: byKey.get(key)! })),
      metrics,
      cursorY
    )
  );

  const width = nodes.reduce((max, node) => Math.max(max, node.x + node.width), 0);
  const height = nodes.reduce((max, node) => Math.max(max, node.y + node.height), 0);

  return {
    nodes,
    width: width + metrics.padding,
    height: height + metrics.padding
  };
}

export interface ColumnAnchor {
  leftX: number;
  rightX: number;
  y: number;
}

/**
 * 某一列在框上的连线锚点。
 *
 * 连到列自己的那一行，不是连到框的中心——「关联字段的连线」要看得出是
 * 哪两个字段在关联，连到中间就只剩下「这两张表有关系」。
 */
export function columnAnchor(
  node: ErNode,
  columnName: string,
  metrics: ErMetrics = DEFAULT_ER_METRICS
): ColumnAnchor | undefined {
  const index = node.table.columns.findIndex(column => column.name === columnName);
  if (index === -1) {
    return undefined;
  }

  return {
    leftX: node.x,
    rightX: node.x + node.width,
    y: node.y + metrics.headerHeight + index * metrics.rowHeight + metrics.rowHeight / 2
  };
}

export function nodeHeight(table: ErTable, metrics: ErMetrics = DEFAULT_ER_METRICS): number {
  return metrics.headerHeight + table.columns.length * metrics.rowHeight;
}

/** 无向连通分量。大的排前面，孤立的表落在最后。 */
function connectedGroups(keys: readonly string[], links: readonly ErLink[]): string[][] {
  const neighbours = new Map<string, Set<string>>(keys.map(key => [key, new Set<string>()]));
  for (const link of links) {
    if (link.from.table === link.to.table) {
      continue;
    }
    neighbours.get(link.from.table)?.add(link.to.table);
    neighbours.get(link.to.table)?.add(link.from.table);
  }

  const seen = new Set<string>();
  const groups: string[][] = [];

  for (const key of keys) {
    if (seen.has(key)) {
      continue;
    }

    const group: string[] = [];
    const queue = [key];
    seen.add(key);
    while (queue.length > 0) {
      const current = queue.shift()!;
      group.push(current);
      for (const next of [...(neighbours.get(current) ?? [])].sort()) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    groups.push(group);
  }

  // 关系密集的分组放在最上面：打开图最先看到的应该是主干，不是一堆孤立的表
  return groups.sort(
    (left, right) => right.length - left.length || left[0].localeCompare(right[0])
  );
}

/**
 * 一个连通分量的布局：按「被引用的在左、引用别人的在右」分层。
 *
 * 层号取自最长依赖链：某张表的层 = 它引用的所有表的层的最大值 + 1。
 * 环（互相引用、自引用）靠迭代上限打断，不会转不出来。
 */
function layoutGroup(
  group: ReadonlyArray<{ key: string; table: ErTable }>,
  links: readonly ErLink[],
  metrics: ErMetrics,
  startY: number
): { nodes: ErNode[]; nextY: number } {
  const tableByKey = new Map(group.map(entry => [entry.key, entry.table]));
  const inGroup = new Set(tableByKey.keys());
  const dependencies = links.filter(
    link =>
      inGroup.has(link.from.table)
      && inGroup.has(link.to.table)
      && link.from.table !== link.to.table
  );

  const layer = new Map<string, number>(group.map(entry => [entry.key, 0]));
  // 迭代次数上限就是分组大小：无环时这么多轮一定收敛，有环时到点停下
  for (let round = 0; round < group.length; round += 1) {
    let changed = false;
    for (const link of dependencies) {
      const target = (layer.get(link.to.table) ?? 0) + 1;
      if (target > (layer.get(link.from.table) ?? 0)) {
        layer.set(link.from.table, target);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  const byLayer = new Map<number, string[]>();
  for (const key of [...tableByKey.keys()].sort()) {
    const index = layer.get(key) ?? 0;
    byLayer.set(index, [...(byLayer.get(index) ?? []), key]);
  }

  const nodes: ErNode[] = [];
  let bottom = startY;

  for (const [index, keys] of [...byLayer.entries()].sort(([a], [b]) => a - b)) {
    const x = metrics.padding + index * (metrics.nodeWidth + metrics.columnGap);
    let y = startY;
    for (const key of keys) {
      const table = tableByKey.get(key)!;
      const height = nodeHeight(table, metrics);
      nodes.push({ key, table, x, y, width: metrics.nodeWidth, height });
      y += height + metrics.nodeGap;
      bottom = Math.max(bottom, y - metrics.nodeGap);
    }
  }

  return { nodes, nextY: bottom };
}

type MetadataRow = Record<string, unknown>;

/**
 * 列行（每列一行）合成表。
 *
 * 列按 ordinal 排，不按到达顺序——驱动不保证行序，而列顺序错了，
 * 图上每一行都对不上真实的表结构。
 */
export function toErTables(rows: readonly MetadataRow[]): ErTable[] {
  const byKey = new Map<string, { table: ErTable; ordinals: number[] }>();

  for (const row of rows) {
    const name = text(row.table_name);
    const columnName = text(row.column_name);
    if (!name || !columnName) {
      continue;
    }

    const schema = text(row.table_schema) || null;
    const key = schema ? `${schema}.${name}` : name;
    const entry = byKey.get(key) ?? { table: { schema, name, columns: [] }, ordinals: [] };

    entry.table.columns.push({
      name: columnName,
      dataType: text(row.data_type),
      isPrimaryKey: bool(row.is_primary_key),
      isNullable: bool(row.is_nullable)
    });
    entry.ordinals.push(Number(row.ordinal) || 0);
    byKey.set(key, entry);
  }

  return [...byKey.values()].map(({ table, ordinals }) => ({
    ...table,
    columns: table.columns
      .map((column, index) => ({ column, ordinal: ordinals[index] }))
      .sort((left, right) => left.ordinal - right.ordinal)
      .map(({ column }) => column)
  }));
}

/** 外键行合成连线。每一行就是一条「这一列连到那一列」，复合外键自然是多条。 */
export function toErLinks(rows: readonly MetadataRow[]): ErLink[] {
  return rows.flatMap(row => {
    const fromTable = qualify(text(row.table_schema), text(row.table_name));
    const toTable = qualify(text(row.referenced_schema), text(row.referenced_table));
    const fromColumn = text(row.column_name);
    const toColumn = text(row.referenced_column);

    // SQLite 允许省略被引用列（默认父表主键）。没有列名就连不到具体的行，
    // 这条边只好丢掉——画一条连到框中心的线会让人以为那是某个真实字段。
    if (!fromTable || !toTable || !fromColumn || !toColumn) {
      return [];
    }

    return [
      {
        constraintName: text(row.constraint_name),
        from: { table: fromTable, column: fromColumn },
        to: { table: toTable, column: toColumn }
      }
    ];
  });
}

function qualify(schema: string, name: string): string {
  if (!name) {
    return '';
  }
  return schema ? `${schema}.${name}` : name;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/** MySQL 与 SQLite 的布尔是 1 / 0，PostgreSQL 才是真布尔。 */
function bool(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  return value === '1' || value === 'true';
}

/**
 * 孤立的表排成网格。
 *
 * 每行内部按最高的那个对齐下一行，不按固定行高——固定行高要么被最高的撑得
 * 到处是空隙，要么在列多的表上重叠。
 */
function layoutIsolated(
  entries: ReadonlyArray<{ key: string; table: ErTable }>,
  metrics: ErMetrics,
  startY: number
): ErNode[] {
  const nodes: ErNode[] = [];
  const perRow = Math.max(1, metrics.isolatedColumns);
  let y = startY;

  for (let start = 0; start < entries.length; start += perRow) {
    const row = entries.slice(start, start + perRow);
    let tallest = 0;

    row.forEach((entry, index) => {
      const height = nodeHeight(entry.table, metrics);
      nodes.push({
        key: entry.key,
        table: entry.table,
        x: metrics.padding + index * (metrics.nodeWidth + metrics.columnGap),
        y,
        width: metrics.nodeWidth,
        height
      });
      tallest = Math.max(tallest, height);
    });

    y += tallest + metrics.nodeGap;
  }

  return nodes;
}

/**
 * 把文本截到给定的显示宽度。
 *
 * SVG 的 `<text>` 不会自动截断也不会换行：长类型名会直接压在列名上。
 * 宽度按显示宽度算，CJK 占两格——按字符数算的话，一行中文会溢出一倍。
 */
export function truncateLabel(text: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return '';
  }
  if (displayWidth(text) <= maxWidth) {
    return text;
  }

  // 放不下省略号时就别加了，不然截出来只剩一个「…」
  const budget = maxWidth > 1 ? maxWidth - 1 : maxWidth;
  let width = 0;
  let cut = '';
  for (const character of text) {
    const next = width + (isWide(character) ? 2 : 1);
    if (next > budget) {
      break;
    }
    width = next;
    cut += character;
  }

  return maxWidth > 1 ? `${cut}…` : cut;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    width += isWide(character) ? 2 : 1;
  }
  return width;
}

function isWide(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x20000 && code <= 0x3fffd);
}

/**
 * 搜索命中的表。
 *
 * 表名与列名都参与匹配：找一张表常常是从「哪张表有 customer_id 这一列」
 * 开始的，只匹配表名会让这条路走不通。
 *
 * 返回命中的 key 集合；空查询返回 `null` 表示「不过滤」，
 * 与「一个都没命中」（空集合）是两件事——后者该让整张图暗下来。
 */
export function matchErTables(
  nodes: ReadonlyArray<{ key: string; table: ErTable }>,
  query: string
): Set<string> | null {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return null;
  }

  return new Set(
    nodes
      .filter(({ key, table }) =>
        key.toLowerCase().includes(needle)
        || table.columns.some(column => column.name.toLowerCase().includes(needle))
      )
      .map(({ key }) => key)
  );
}

/**
 * 画哪些表。
 *
 * 与搜索是两件事，而这个区别值得说清楚：**搜索压暗，过滤删掉**。
 * 搜索要保住图的形状，不然剩下的几张表认不出原来在哪；过滤的整个用处
 * 恰恰是让图变小——两百张表的库里，把不相干的压暗仍然什么都看不清。
 */
export interface ErFilter {
  /** 要画的 schema。空数组 = 不按 schema 过滤 */
  schemas: readonly string[];
  /** 以这张表为中心，只画它和 `depth` 跳以内的表。null = 不按关系过滤 */
  focus: string | null;
  depth: number;
  /** 藏掉在这张图里没有任何连线的表 */
  hideUnlinked: boolean;
}

export const NO_ER_FILTER: ErFilter = {
  schemas: [],
  focus: null,
  depth: 1,
  hideUnlinked: false
};

export function isErFilterActive(filter: ErFilter): boolean {
  return filter.schemas.length > 0 || filter.focus !== null || filter.hideUnlinked;
}

/**
 * 数据里出现过的 schema，去重后排序。只有一个时界面上不必给这个选择。
 *
 * 没有 schema 的方言（MySQL、SQLite）归一成空串，而不是单独开一条 null 分支：
 * 那种库里 schema 只有一个，这个选择根本不会出现在界面上。
 */
export function erSchemas(tables: readonly ErTable[]): string[] {
  return [...new Set(tables.map(table => table.schema ?? ''))].sort();
}

/**
 * 按 schema、表与关系筛出要画的部分。
 *
 * 三步依次做，顺序是有意义的：
 *
 * 1. **schema**：先把范围划出来。后两步都在这个范围内谈。
 * 2. **没有连线的表**：判据是「在**这张图里**没有连线」，不是「在整个库里
 *    没有外键」——一张表的外键指向一个被排掉的 schema，它在这张图里就是孤立的。
 *    焦点表例外：把用户刚点中的那张表藏掉，剩下一张空图，没人能理解发生了什么。
 * 3. **焦点**：从焦点出发按连线走 `depth` 跳。方向不算数——「谁引用了我」和
 *    「我引用了谁」都是关系，只看一个方向会漏掉一半。
 *
 * 连线最后统一收一遍：两端都还在才留下。留着一条指向已被排掉的表的连线，
 * 顶栏上那句「N 条关联」就成了假话。
 */
export function filterErDiagram(
  tables: readonly ErTable[],
  links: readonly ErLink[],
  filter: ErFilter
): { tables: ErTable[]; links: ErLink[] } {
  const allowedSchemas = new Set(filter.schemas);
  let kept = new Set(
    tables
      .filter(table => allowedSchemas.size === 0 || allowedSchemas.has(table.schema ?? ''))
      .map(table => tableKey(table))
  );

  const within = (link: ErLink, keys: Set<string>) =>
    keys.has(link.from.table) && keys.has(link.to.table);

  if (filter.hideUnlinked) {
    const linked = new Set<string>();
    for (const link of links) {
      if (within(link, kept)) {
        linked.add(link.from.table);
        linked.add(link.to.table);
      }
    }
    kept = new Set(
      [...kept].filter(key => linked.has(key) || key === filter.focus)
    );
  }

  const focus = filter.focus;
  if (focus !== null) {
    kept = neighbourhood(focus, links, kept, filter.depth);
  }

  return {
    tables: tables.filter(table => kept.has(tableKey(table))),
    links: links.filter(link => within(link, kept))
  };
}

/** 从 `focus` 出发，沿连线走最多 `depth` 跳能到的表（含 focus 自己） */
function neighbourhood(
  focus: string,
  links: readonly ErLink[],
  candidates: Set<string>,
  depth: number
): Set<string> {
  const reached = new Set<string>();
  if (!candidates.has(focus)) {
    // 焦点被 schema 这一层排掉了。返回空集合而不是忽略焦点：
    // 悄悄画出整张图会让人以为焦点没生效
    return reached;
  }

  const neighbours = new Map<string, Set<string>>();
  for (const link of links) {
    if (!candidates.has(link.from.table) || !candidates.has(link.to.table)) {
      continue;
    }
    for (const [a, b] of [
      [link.from.table, link.to.table],
      [link.to.table, link.from.table]
    ]) {
      const bucket = neighbours.get(a) ?? new Set<string>();
      bucket.add(b);
      neighbours.set(a, bucket);
    }
  }

  reached.add(focus);
  let frontier = [focus];
  for (let hop = 0; hop < Math.max(0, depth); hop += 1) {
    const next: string[] = [];
    for (const key of frontier) {
      for (const neighbour of neighbours.get(key) ?? []) {
        if (!reached.has(neighbour)) {
          reached.add(neighbour);
          next.push(neighbour);
        }
      }
    }
    if (next.length === 0) {
      break;
    }
    frontier = next;
  }

  return reached;
}
