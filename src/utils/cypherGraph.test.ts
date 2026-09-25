import { describe, expect, it } from 'vitest';
import type { CypherNodeValue, CypherRelationshipValue, CypherValue } from './cypherValue';
import {
  GRAPH_COLOR_SLOTS,
  MAX_GRAPH_NODES,
  MIN_NODE_DISTANCE,
  collectGraph,
  edgeGeometry,
  hasGraphValues,
  labelColors,
  layoutGraph,
  nodeCaption,
  relationshipBends,
  type GraphNode
} from './cypherGraph';

const node = (id: string, labels: string[] = ['Person'], properties: CypherNodeValue['properties'] = []): CypherNodeValue => ({
  kind: 'node',
  elementId: id,
  labels,
  properties
});
const rel = (id: string, start: string, end: string, type = 'KNOWS'): CypherRelationshipValue => ({
  kind: 'relationship',
  elementId: id,
  type,
  startElementId: start,
  endElementId: end,
  properties: []
});
const text = (value: string): CypherValue => ({ kind: 'string', value });
const graphNode = (value: CypherNodeValue): GraphNode => ({ id: value.elementId, value });

describe('结果里有没有图', () => {
  it('节点、关系、路径算，嵌在列表与映射里的也算', () => {
    expect(hasGraphValues([[node('a')]])).toBe(true);
    expect(hasGraphValues([[{ kind: 'list', items: [text('x'), node('a')] }]])).toBe(true);
    expect(hasGraphValues([[{ kind: 'map', entries: [['r', rel('r', 'a', 'b')]] }]])).toBe(true);
  });

  it('只有标量的结果没有图，这时不给切换', () => {
    expect(hasGraphValues([[text('a'), { kind: 'integer', value: '1' }]])).toBe(false);
    expect(hasGraphValues([])).toBe(false);
  });
});

describe('收节点与关系', () => {
  it('同一个节点出现在好几行、好几条路径里只画一次', () => {
    const a = node('a');
    const b = node('b');
    const path: CypherValue = {
      kind: 'path',
      start: a,
      segments: [{ relationship: rel('r1', 'a', 'b'), forward: true, node: b }]
    };
    const graph = collectGraph([[a, path], [b, path]]);
    expect(graph.nodes.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(graph.relationships.map((entry) => entry.id)).toEqual(['r1']);
  });

  it('钻进列表与映射', () => {
    const graph = collectGraph([[{ kind: 'map', entries: [['people', { kind: 'list', items: [node('a'), node('b')] }]] }]]);
    expect(graph.nodes.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('只返回关系时端点补成只有 id 的节点', () => {
    // `MATCH ()-[r]->() RETURN r`：没有这一条就是一张空图
    const graph = collectGraph([[rel('r1', 'a', 'b')]]);
    expect(graph.nodes).toEqual([{ id: 'a', value: null }, { id: 'b', value: null }]);
    expect(graph.relationships).toHaveLength(1);
  });

  it('端点后来在结果里出现了，就用真的节点', () => {
    const graph = collectGraph([[rel('r1', 'a', 'b'), node('b', ['City'])]]);
    expect(graph.nodes.map((entry) => entry.value?.labels ?? null)).toEqual([null, ['City']]);
  });

  it('到上限就不收了，接到没收的节点上的关系也不画，两样都记数', () => {
    const graph = collectGraph([[node('a'), node('b'), node('c'), rel('r1', 'a', 'b'), rel('r2', 'b', 'c')]], 2);
    expect(graph.nodes.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(graph.relationships.map((entry) => entry.id)).toEqual(['r1']);
    expect(graph.omittedNodes).toBe(1);
    expect(graph.omittedRelationships).toBe(1);
  });

  it('上限不超过 300', () => {
    // 量过的数在常量的注释里：排布按 n² 涨，300 个圈缩进框里已经读不出名字。
    // 这条门比的是字面量——改大这个常量得先重新量过，并改这里
    expect(MAX_GRAPH_NODES).toBeLessThanOrEqual(300);
  });
});

describe('标签的颜色', () => {
  it('按第一次出现的次序一个标签一个槽', () => {
    const { slots, labelOf } = labelColors([
      graphNode(node('a', ['Movie'])),
      graphNode(node('b', ['Person'])),
      graphNode(node('c', ['Movie']))
    ]);
    expect([...slots.entries()]).toEqual([['Movie', 0], ['Person', 1]]);
    expect(labelOf.get('c')).toBe('Movie');
  });

  it('按节点身上最少见的标签，不按第一个', () => {
    // 打包版上发现的：`(:Movie:GraphDemo)` 回来是 [GraphDemo, Movie]，电影全被涂成 GraphDemo
    const { labelOf, slots } = labelColors([
      graphNode(node('p1', ['Person', 'GraphDemo'])),
      graphNode(node('p2', ['Person', 'GraphDemo'])),
      graphNode(node('m1', ['GraphDemo', 'Movie'])),
      graphNode(node('c1', ['GraphDemo', 'City']))
    ]);
    expect([labelOf.get('p1'), labelOf.get('m1'), labelOf.get('c1')]).toEqual(['Person', 'Movie', 'City']);
    expect(slots.has('GraphDemo')).toBe(false);
  });

  it('一样少见时取靠前的', () => {
    expect(labelColors([graphNode(node('a', ['Actor', 'Person']))]).labelOf.get('a')).toBe('Actor');
  });

  it('排不下的给中性色，不取模：第九种不能和第一种同色', () => {
    const nodes = Array.from({ length: GRAPH_COLOR_SLOTS + 1 }, (_, i) => graphNode(node(`n${i}`, [`L${i}`])));
    const { slots } = labelColors(nodes);
    expect(slots.get('L0')).toBe(0);
    expect(slots.get(`L${GRAPH_COLOR_SLOTS - 1}`)).toBe(GRAPH_COLOR_SLOTS - 1);
    expect(slots.get(`L${GRAPH_COLOR_SLOTS}`)).toBeNull();
  });

  it('没有标签的节点和补出来的端点不占槽', () => {
    const { slots, labelOf } = labelColors([graphNode(node('a', [])), { id: 'b', value: null }]);
    expect(slots.size).toBe(0);
    expect(labelOf.size).toBe(0);
  });
});

describe('圈下面写什么', () => {
  it('名字类属性优先，不管它排在第几', () => {
    expect(nodeCaption(graphNode(node('a', ['Person'], [['age', { kind: 'integer', value: '3' }], ['name', text('Alice')]])))).toBe('Alice');
    expect(nodeCaption(graphNode(node('a', ['Movie'], [['released', { kind: 'integer', value: '1999' }], ['title', text('The Matrix')]])))).toBe('The Matrix');
  });

  it('没有名字类的取第一个字符串属性，再没有就写标签', () => {
    expect(nodeCaption(graphNode(node('a', ['City'], [['zip', text('100000')]])))).toBe('100000');
    expect(nodeCaption(graphNode(node('a', ['City'], [['population', { kind: 'integer', value: '5' }]])))).toBe('City');
  });

  it('名字类属性不是标量时跳过它', () => {
    expect(nodeCaption(graphNode(node('a', ['X'], [['name', { kind: 'list', items: [] }], ['note', text('n')]])))).toBe('n');
  });

  it('补出来的端点什么也不写', () => {
    expect(nodeCaption({ id: 'a', value: null })).toBe('');
  });
});

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe('排布', () => {
  it('没有随机数：同一份输入排出来一模一样', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const edges: Array<[string, string]> = [['a', 'b'], ['b', 'c']];
    expect(layoutGraph(ids, edges)).toEqual(layoutGraph(ids, edges));
  });

  it('连着的比不连着的近', () => {
    const positions = layoutGraph(['a', 'b', 'c', 'd'], [['a', 'b'], ['c', 'd']]);
    const at = (id: string) => positions.get(id)!;
    expect(distance(at('a'), at('b'))).toBeLessThan(distance(at('a'), at('c')));
    expect(distance(at('c'), at('d'))).toBeLessThan(distance(at('b'), at('d')));
  });

  it('星形的叶子互相推开，圈不叠在一起', () => {
    const ids = ['hub', ...Array.from({ length: 30 }, (_, i) => `leaf${i}`)];
    const positions = [...layoutGraph(ids, ids.slice(1).map((id) => ['hub', id] as [string, string])).values()];
    let closest = Infinity;
    for (let i = 0; i < positions.length; i += 1) {
      for (let j = i + 1; j < positions.length; j += 1) closest = Math.min(closest, distance(positions[i], positions[j]));
    }
    // 圈半径 18：两圈之间至少留出一个圈的空隙
    expect(closest).toBeGreaterThan(54);
  });

  it('连得很密的也不叠在一起', () => {
    // 打包版上发现的：两个城市各连着六个人，被拉到同一处叠成一团
    const people = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const edges: Array<[string, string]> = people.flatMap((person, i) => [
      [person, i % 2 === 0 ? 'berlin' : 'tokyo'] as [string, string],
      [person, people[(i + 1) % people.length]] as [string, string],
      [person, people[(i + 5) % people.length]] as [string, string]
    ]);
    const positions = [...layoutGraph([...people, 'berlin', 'tokyo'], edges).values()];
    let closest = Infinity;
    for (let i = 0; i < positions.length; i += 1) {
      for (let j = i + 1; j < positions.length; j += 1) closest = Math.min(closest, distance(positions[i], positions[j]));
    }
    expect(closest).toBeGreaterThanOrEqual(MIN_NODE_DISTANCE - 0.5);
  });

  it('零个、一个、自环、重复的边、指向不存在节点的边都排得出有限的坐标', () => {
    expect(layoutGraph([], []).size).toBe(0);
    const positions = layoutGraph(['a', 'b'], [['a', 'a'], ['a', 'b'], ['a', 'b'], ['a', 'ghost']]);
    for (const point of positions.values()) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    }
    expect(layoutGraph(['solo'], []).get('solo')).toEqual({ x: expect.any(Number), y: expect.any(Number) });
  });

  it('不连通的几块不会越推越远', () => {
    // 斥力不截断时 20 个孤立点铺到一千多像素外，缩放到能看全时每个圈只剩一个点
    const ids = Array.from({ length: 20 }, (_, i) => `n${i}`);
    const positions = [...layoutGraph(ids, []).values()];
    const spread = Math.max(...positions.map((point) => Math.hypot(point.x, point.y)));
    expect(spread).toBeLessThan(600);
  });
});

describe('几条关系连同一对节点', () => {
  const relationships = (list: CypherRelationshipValue[]) => list.map((value) => ({ id: value.elementId, value }));

  it('只有一条是直的', () => {
    expect(relationshipBends(relationships([rel('r', 'a', 'b')])).get('r')).toBe(0);
  });

  it('A→B 与 B→A 弯向两边', () => {
    // 两个都是相对自己走向的「往左」：一左一右时数值同号
    const bends = relationshipBends(relationships([rel('r1', 'a', 'b'), rel('r2', 'b', 'a')]));
    const first = edgeGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, bends.get('r1')!, 10);
    const second = edgeGeometry({ x: 100, y: 0 }, { x: 0, y: 0 }, bends.get('r2')!, 10);
    expect(Math.sign(first.label.y)).toBe(-Math.sign(second.label.y));
    expect(first.label.y).not.toBe(0);
  });

  it('三条同向的：一条直的，另两条一边一条', () => {
    const bends = relationshipBends(relationships([rel('r1', 'a', 'b'), rel('r2', 'a', 'b'), rel('r3', 'a', 'b')]));
    expect([bends.get('r1')!, bends.get('r2')!, bends.get('r3')!].map(Math.sign)).toEqual([-1, 0, 1]);
  });

  it('自环按第几个排，圈一个比一个大', () => {
    const bends = relationshipBends(relationships([rel('l1', 'a', 'a'), rel('l2', 'a', 'a')]));
    expect([bends.get('l1'), bends.get('l2')]).toEqual([0, 1]);
    const small = edgeGeometry({ x: 0, y: 0 }, { x: 0, y: 0 }, 0, 18, true);
    const large = edgeGeometry({ x: 0, y: 0 }, { x: 0, y: 0 }, 1, 18, true);
    expect(large.label.y).toBeLessThan(small.label.y);
  });
});

describe('一条线的画法', () => {
  it('直线停在终点圈的边上，箭头不被圈盖住', () => {
    const geometry = edgeGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 0, 20);
    expect(geometry.path).toBe('M 20 0 L 80 0');
  });

  it('类型的字头朝上：往左走的线文字不倒过来', () => {
    expect(edgeGeometry({ x: 100, y: 0 }, { x: 0, y: 0 }, 0, 10).label.angle).toBe(0);
    expect(Math.abs(edgeGeometry({ x: 0, y: 100 }, { x: 10, y: 0 }, 0, 10).label.angle)).toBeLessThanOrEqual(90);
  });
});
