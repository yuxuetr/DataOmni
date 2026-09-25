import type { CypherEntry, CypherNodeValue, CypherRelationshipValue, CypherValue } from './cypherValue';

/**
 * Cypher 结果画成图要回答的几件事：画哪些点和线、点放在哪、线怎么弯。
 * 组件只照着画，这里的每一步都是纯函数。
 */

/**
 * 一张图最多画多少个节点。
 *
 * 量过（2026-09-25）：排布是 O(n² × 轮数)，300 点 51ms、500 点 133ms、1000 点 541ms（vitest / Node，
 * 链加跨接的图）；打包版上拖一个点整张重画，300 点 / 328 线每帧中位 2ms、最长 4ms。
 * 卡住上限的不是拖动而是两件事：排布按平方涨，以及 300 个圈缩进 480px 高的框里时已经只剩 26%，
 * 名字读不出来了——再多画只多一团点。要看全量用表格，或者写聚合。
 * 门在 `cypherGraph.test.ts`：这个常量不超过字面量 300。
 */
export const MAX_GRAPH_NODES = 300;

/** 分类色板的槽位数（`--dm-series-1..8`），超出的标签用中性色，不取模循环 */
export const GRAPH_COLOR_SLOTS = 8;

export interface GraphNode {
  id: string;
  /** 端点不在结果里（比如只 `RETURN r`）：只知道 id，画成空心的 */
  value: CypherNodeValue | null;
}

export interface GraphRelationship {
  id: string;
  value: CypherRelationshipValue;
}

export interface CypherGraph {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  /** 超过上限没画的节点数，以及因此没画的关系数 */
  omittedNodes: number;
  omittedRelationships: number;
}

/** 结果里有没有能画成图的东西 */
export function hasGraphValues(rows: CypherValue[][]): boolean {
  return rows.some((row) => row.some(containsGraphValue));
}

function containsGraphValue(value: CypherValue): boolean {
  switch (value.kind) {
    case 'node':
    case 'relationship':
    case 'path':
      return true;
    case 'list':
      return value.items.some(containsGraphValue);
    case 'map':
      return value.entries.some(([, item]) => containsGraphValue(item));
    default:
      return false;
  }
}

/**
 * 从结果里收节点与关系：按出现次序、按 elementId 去重，钻进列表、映射与路径。
 *
 * 关系的端点不在结果里时补一个只有 id 的节点——`MATCH ()-[r]->() RETURN r` 也画得出来。
 * 节点到上限就不再收，两端有一端没收进来的关系也不画，两样都计数交给界面说明。
 */
export function collectGraph(rows: CypherValue[][], maxNodes = MAX_GRAPH_NODES): CypherGraph {
  const found = new Map<string, CypherNodeValue>();
  const relationships = new Map<string, CypherRelationshipValue>();
  /** 节点的次序：按第一次提到它的位置，端点也算 */
  const order: string[] = [];
  const seen = new Set<string>();
  const mention = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  };

  const visit = (value: CypherValue) => {
    switch (value.kind) {
      case 'node':
        mention(value.elementId);
        found.set(value.elementId, value);
        return;
      case 'relationship':
        if (!relationships.has(value.elementId)) relationships.set(value.elementId, value);
        mention(value.startElementId);
        mention(value.endElementId);
        return;
      case 'path':
        visit(value.start);
        for (const segment of value.segments) {
          visit(segment.node);
          visit(segment.relationship);
        }
        return;
      case 'list':
        value.items.forEach(visit);
        return;
      case 'map':
        value.entries.forEach(([, item]) => visit(item));
        return;
      default:
        return;
    }
  };
  rows.forEach((row) => row.forEach(visit));

  const kept = order.slice(0, maxNodes);
  const keptIds = new Set(kept);
  const drawn = [...relationships.values()].filter(
    (relationship) => keptIds.has(relationship.startElementId) && keptIds.has(relationship.endElementId)
  );
  return {
    nodes: kept.map((id) => ({ id, value: found.get(id) ?? null })),
    relationships: drawn.map((value) => ({ id: value.elementId, value })),
    omittedNodes: order.length - kept.length,
    omittedRelationships: relationships.size - drawn.length
  };
}

export interface LabelColors {
  /** 每个节点按哪个标签着色；没有标签的、补出来的端点不在里面 */
  labelOf: Map<string, string>;
  /** 标签 → 色板槽位，排不下的是 `null`（中性色） */
  slots: Map<string, number | null>;
}

/**
 * 节点按哪个标签着色：它身上**在这份结果里最少见**的那个，一样少见时取靠前的。
 *
 * 不取第一个标签：Neo4j 按标签建出来的先后返回，`(:Movie:GraphDemo)` 可能回来是
 * `[GraphDemo, Movie]`，于是所有电影都被涂成那个人人都有的标记标签。
 * 槽位按标签第一次出现的次序给，一个标签一个，不取模循环
 */
export function labelColors(nodes: GraphNode[]): LabelColors {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    for (const label of node.value?.labels ?? []) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const labelOf = new Map<string, string>();
  const slots = new Map<string, number | null>();
  for (const node of nodes) {
    const labels = node.value?.labels ?? [];
    if (labels.length === 0) continue;
    const label = labels.reduce((rarest, candidate) => ((counts.get(candidate) ?? 0) < (counts.get(rarest) ?? 0) ? candidate : rarest));
    labelOf.set(node.id, label);
    if (!slots.has(label)) slots.set(label, slots.size < GRAPH_COLOR_SLOTS ? slots.size : null);
  }
  return { labelOf, slots };
}

/** 圈下面写什么：常见的名字类属性优先，其次第一个字符串属性，再次第一个标签 */
const CAPTION_KEYS = ['name', 'title', 'label', 'caption', 'username', 'email', 'id', 'key', 'code'];

export function nodeCaption(node: GraphNode): string {
  const value = node.value;
  if (!value) return '';
  const lookup = new Map<string, CypherEntry[1]>(value.properties);
  for (const key of CAPTION_KEYS) {
    const property = lookup.get(key);
    if (property && isScalar(property)) return scalarText(property);
  }
  const firstString = value.properties.find(([, property]) => property.kind === 'string');
  if (firstString) return scalarText(firstString[1]);
  return value.labels[0] ?? '';
}

function isScalar(value: CypherValue): boolean {
  return value.kind === 'string' || value.kind === 'integer' || value.kind === 'float' || value.kind === 'boolean';
}

function scalarText(value: CypherValue): string {
  switch (value.kind) {
    case 'string':
    case 'integer':
    case 'float':
      return value.value;
    case 'boolean':
      return value.value ? 'true' : 'false';
    default:
      return '';
  }
}

export interface Point {
  x: number;
  y: number;
}

/** 两条线的理想长度，也是斥力的尺度 */
const IDEAL_EDGE_LENGTH = 110;
const LAYOUT_ROUNDS = 300;
/**
 * 斥力的强度与作用距离、往中心收的强度。三个数是量出来的（孤立点、链、星形各排一次）：
 * 斥力不截断时，n 个孤立点铺开的半径约为 强度 × √(n / 收力)，怎么调都挤不紧——
 * `MATCH (n:Label) RETURN n LIMIT 25` 这种全是孤立点的结果最常见，它们会隔着一两百像素散开。
 * 只推近处的，孤立点就按局部的斥力排开
 */
const REPULSION = 80;
const REPULSION_CUTOFF = 200;
const GRAVITY = 0.1;
/**
 * 两个圆心至少隔多远：两个半径（18）再留一段放字的空隙。
 * 受力排不开时（几个中心节点被各自的一圈邻居拉到同一处）最后硬推开
 */
export const MIN_NODE_DISTANCE = 56;
const SEPARATION_ROUNDS = 50;

/**
 * 力导向排布（Fruchterman–Reingold）：连着的互相拉、离得近的互相推、都往中心收一点。
 *
 * 没有随机数：起点是葵花籽排布（第 i 个在黄金角 × i、半径 ∝ √i 处），同一份结果
 * 每次排出来一样——重跑一条查询时图不会换个样子。自环不参与受力。
 */
export function layoutGraph(nodeIds: string[], edges: Array<[string, string]>, rounds = LAYOUT_ROUNDS): Map<string, Point> {
  const count = nodeIds.length;
  const index = new Map(nodeIds.map((id, position) => [id, position]));
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i += 1) {
    const radius = IDEAL_EDGE_LENGTH * 0.6 * Math.sqrt(i + 0.5);
    xs[i] = radius * Math.cos(i * goldenAngle);
    ys[i] = radius * Math.sin(i * goldenAngle);
  }
  const links = edges
    .map(([from, to]) => [index.get(from), index.get(to)] as const)
    .filter((link): link is readonly [number, number] => link[0] !== undefined && link[1] !== undefined && link[0] !== link[1]);

  const k = IDEAL_EDGE_LENGTH;
  const dx = new Float64Array(count);
  const dy = new Float64Array(count);
  const startTemperature = IDEAL_EDGE_LENGTH * Math.max(1, Math.sqrt(count) / 2);
  for (let round = 0; round < rounds; round += 1) {
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        let offsetX = xs[i] - xs[j];
        let offsetY = ys[i] - ys[j];
        let distanceSquared = offsetX * offsetX + offsetY * offsetY;
        if (distanceSquared < 0.01) {
          // 重合时沿一个由下标定下来的方向推开，不用随机数
          offsetX = Math.cos(i + j);
          offsetY = Math.sin(i + j);
          distanceSquared = 1;
        }
        if (distanceSquared > REPULSION_CUTOFF * REPULSION_CUTOFF) continue;
        const force = (REPULSION * REPULSION) / distanceSquared;
        dx[i] += offsetX * force;
        dy[i] += offsetY * force;
        dx[j] -= offsetX * force;
        dy[j] -= offsetY * force;
      }
    }
    for (const [from, to] of links) {
      const offsetX = xs[from] - xs[to];
      const offsetY = ys[from] - ys[to];
      const distance = Math.sqrt(offsetX * offsetX + offsetY * offsetY) || 1;
      const force = distance / k;
      dx[from] -= offsetX * force;
      dy[from] -= offsetY * force;
      dx[to] += offsetX * force;
      dy[to] += offsetY * force;
    }
    const temperature = startTemperature * (1 - round / rounds);
    for (let i = 0; i < count; i += 1) {
      // 往中心收：不连通的几块不至于越推越远
      dx[i] -= xs[i] * GRAVITY;
      dy[i] -= ys[i] * GRAVITY;
      const length = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]);
      if (length > 0) {
        const step = Math.min(length, temperature);
        xs[i] += (dx[i] / length) * step;
        ys[i] += (dy[i] / length) * step;
      }
    }
  }
  separate(xs, ys);
  return new Map(nodeIds.map((id, i) => [id, { x: xs[i], y: ys[i] }]));
}

/** 叠着的两两推开，各让一半，直到没有叠着的或推满轮数 */
function separate(xs: Float64Array, ys: Float64Array) {
  const count = xs.length;
  for (let round = 0; round < SEPARATION_ROUNDS; round += 1) {
    let overlapping = false;
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        let offsetX = xs[i] - xs[j];
        let offsetY = ys[i] - ys[j];
        let distance = Math.sqrt(offsetX * offsetX + offsetY * offsetY);
        if (distance >= MIN_NODE_DISTANCE) continue;
        overlapping = true;
        if (distance < 0.01) {
          offsetX = Math.cos(i + j);
          offsetY = Math.sin(i + j);
          distance = 1;
        }
        const push = (MIN_NODE_DISTANCE - distance) / 2 / distance;
        xs[i] += offsetX * push;
        ys[i] += offsetY * push;
        xs[j] -= offsetX * push;
        ys[j] -= offsetY * push;
      }
    }
    if (!overlapping) return;
  }
}

/**
 * 同一对节点之间有好几条关系时各弯各的，不然全叠在一条线上。
 *
 * 返回每条关系相对**它自己的走向**往左弯多少（0 是直线）。同一对之间按出现次序
 * 对称排开：一条是直的，两条一左一右——A→B 与 B→A 也是一左一右。
 * 自环返回第几个（0、1、2…），画成越来越大的圈。
 */
export function relationshipBends(relationships: GraphRelationship[], spacing = 28): Map<string, number> {
  const groups = new Map<string, GraphRelationship[]>();
  for (const relationship of relationships) {
    const { startElementId: start, endElementId: end } = relationship.value;
    const key = start < end ? `${start}\u0000${end}` : `${end}\u0000${start}`;
    const group = groups.get(key) ?? [];
    group.push(relationship);
    groups.set(key, group);
  }
  const bends = new Map<string, number>();
  for (const group of groups.values()) {
    group.forEach((relationship, position) => {
      const { startElementId: start, endElementId: end } = relationship.value;
      if (start === end) {
        bends.set(relationship.id, position);
        return;
      }
      // 相对「id 小的 → id 大的」的偏移，换算到这条关系自己的走向上
      const offset = (position - (group.length - 1) / 2) * spacing;
      bends.set(relationship.id, start < end ? offset : -offset);
    });
  }
  return bends;
}

export interface EdgeGeometry {
  /** SVG path 的 d */
  path: string;
  /** 类型写在哪、转多少度（保持字头朝上） */
  label: Point & { angle: number };
}

/**
 * 一条关系怎么画：从起点圈的边上出发、到终点圈的边上停（箭头才不会被圈盖住），
 * 按 `bend` 弯成二次贝塞尔；自环在圈的正上方画一个环。
 */
export function edgeGeometry(start: Point, end: Point, bend: number, radius: number, selfLoop = false): EdgeGeometry {
  if (selfLoop) {
    const size = radius * (1.6 + bend * 0.7);
    const spread = Math.PI / 5;
    const from = { x: start.x + radius * Math.sin(-spread), y: start.y - radius * Math.cos(spread) };
    const to = { x: start.x + radius * Math.sin(spread), y: start.y - radius * Math.cos(spread) };
    const top = start.y - radius - size * 2;
    return {
      path: `M ${round(from.x)} ${round(from.y)} C ${round(start.x - size)} ${round(top)} ${round(start.x + size)} ${round(top)} ${round(to.x)} ${round(to.y)}`,
      label: { x: start.x, y: top + size * 0.5, angle: 0 }
    };
  }
  const offsetX = end.x - start.x;
  const offsetY = end.y - start.y;
  const distance = Math.sqrt(offsetX * offsetX + offsetY * offsetY) || 1;
  // 左手法向：沿走向看往左
  const normal = { x: offsetY / distance, y: -offsetX / distance };
  const control = {
    x: (start.x + end.x) / 2 + normal.x * bend * 2,
    y: (start.y + end.y) / 2 + normal.y * bend * 2
  };
  const from = towards(start, control, radius);
  const to = towards(end, control, radius);
  // 二次贝塞尔在 t = 0.5 处
  const middle = { x: (from.x + 2 * control.x + to.x) / 4, y: (from.y + 2 * control.y + to.y) / 4 };
  let angle = (Math.atan2(offsetY, offsetX) * 180) / Math.PI;
  if (angle > 90) angle -= 180;
  if (angle < -90) angle += 180;
  return {
    path: bend === 0
      ? `M ${round(from.x)} ${round(from.y)} L ${round(to.x)} ${round(to.y)}`
      : `M ${round(from.x)} ${round(from.y)} Q ${round(control.x)} ${round(control.y)} ${round(to.x)} ${round(to.y)}`,
    label: { ...middle, angle }
  };
}

/** 从圆心朝 `target` 走 `distance` 的那一点 */
function towards(center: Point, target: Point, distance: number): Point {
  const offsetX = target.x - center.x;
  const offsetY = target.y - center.y;
  const length = Math.sqrt(offsetX * offsetX + offsetY * offsetY) || 1;
  return { x: center.x + (offsetX / length) * distance, y: center.y + (offsetY / length) * distance };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
