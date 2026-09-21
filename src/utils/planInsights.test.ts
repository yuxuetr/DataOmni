import { describe, expect, it } from 'vitest';
import {
  estimateAccuracy,
  flattenPlan,
  formatPlanMs,
  formatPlanRows,
  worstEstimate,
  type PlanNode,
  type QueryPlan
} from './planInsights';

function node(overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    operation: 'Seq Scan',
    target: null,
    estimatedRows: null,
    actualRows: null,
    cost: null,
    actualMs: null,
    detail: [],
    children: [],
    ...overrides
  };
}

function plan(roots: PlanNode[], analyzed = true): QueryPlan {
  return { roots, analyzed, planningMs: null, executionMs: null, raw: '' };
}

describe('estimateAccuracy', () => {
  it('没跑过就是 unknown，不是「准」', () => {
    // 标成准确，正好把这个提示最该说话的场合变成了沉默
    expect(estimateAccuracy(node({ estimatedRows: 100 }))).toBe('unknown');
    expect(estimateAccuracy(node({ actualRows: 100 }))).toBe('unknown');
  });

  it('按倍数分档，两个方向都算', () => {
    expect(estimateAccuracy(node({ estimatedRows: 100, actualRows: 110 }))).toBe('close');
    expect(estimateAccuracy(node({ estimatedRows: 100, actualRows: 1_200 }))).toBe('off');
    expect(estimateAccuracy(node({ estimatedRows: 100, actualRows: 20_000 }))).toBe('way-off');
    // 高估同样是问题：它会让优化器选哈希连接去处理几行数据
    expect(estimateAccuracy(node({ estimatedRows: 50_000, actualRows: 3 }))).toBe('way-off');
  });

  it('估 0 行不炸也不报成无穷大', () => {
    // 两侧都加 1：估 0 实际 1 是正常的取整误差，不该报成灾难
    expect(estimateAccuracy(node({ estimatedRows: 0, actualRows: 1 }))).toBe('close');
    expect(estimateAccuracy(node({ estimatedRows: 0, actualRows: 5_000 }))).toBe('way-off');
  });
});

describe('worstEstimate', () => {
  it('只挑一个，而且同一档里挑实际行数最多的', () => {
    // 差 100 倍的 10 行和差 100 倍的一百万行不是同一件事
    const small = node({ operation: 'A', estimatedRows: 1, actualRows: 500 });
    const large = node({ operation: 'B', estimatedRows: 1, actualRows: 900_000 });
    expect(worstEstimate(plan([node({ children: [small, large] })]))?.operation).toBe('B');
  });

  it('差得多的那一档优先于差得少的，哪怕行数少', () => {
    const wayOff = node({ operation: 'A', estimatedRows: 1, actualRows: 300 });
    const off = node({ operation: 'B', estimatedRows: 100, actualRows: 1_500 });
    expect(worstEstimate(plan([node({ children: [off, wayOff] })]))?.operation).toBe('A');
  });

  it('都在十倍以内就不指认任何一个', () => {
    // 指出十个「可疑」节点等于没指出任何一个；一个也没有时就该闭嘴
    const fine = node({ estimatedRows: 100, actualRows: 130 });
    expect(worstEstimate(plan([fine]))).toBeNull();
  });

  it('没跑过的计划里一个也挑不出来', () => {
    expect(worstEstimate(plan([node({ estimatedRows: 1 })], false))).toBeNull();
  });
});

describe('flattenPlan', () => {
  it('深度优先，顺序就是树上从上到下的顺序', () => {
    const tree = node({
      operation: 'root',
      children: [
        node({ operation: 'a', children: [node({ operation: 'a1' })] }),
        node({ operation: 'b' })
      ]
    });
    expect(flattenPlan(plan([tree])).map((item) => item.operation))
      .toEqual(['root', 'a', 'a1', 'b']);
  });
});

describe('格式化', () => {
  it('行数按数量级写', () => {
    expect(formatPlanRows(null)).toBe('—');
    expect(formatPlanRows(42)).toBe('42');
    expect(formatPlanRows(1_234)).toBe('1.2k');
    expect(formatPlanRows(1_234_567)).toBe('1.2M');
  });

  it('小数行数不取整——PostgreSQL 的估算会给 0.5 行', () => {
    expect(formatPlanRows(0.5)).toBe('0.50');
  });

  it('不到 1ms 的保留小数，否则一串 0ms 什么也说明不了', () => {
    expect(formatPlanMs(0.026)).toBe('0.026 ms');
    expect(formatPlanMs(12.34)).toBe('12.3 ms');
    expect(formatPlanMs(2_500)).toBe('2.50 s');
    expect(formatPlanMs(null)).toBe('—');
  });
});
