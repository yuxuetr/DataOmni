import { describe, expect, it } from 'vitest';
import { explainVerdict, planLine } from './mongoExplain';

const stage = (name: string, depth = 0, index: string | null = null) => ({ depth, stage: name, index });

describe('mongoExplain', () => {
  it('有 COLLSCAN 就是扫全集合，哪怕另一支用了索引', () => {
    expect(explainVerdict({ stages: [stage('COLLSCAN')] })).toBe('collection-scan');
    expect(explainVerdict({ stages: [stage('OR'), stage('IXSCAN', 1, 'a_1'), stage('COLLSCAN', 1)] })).toBe('collection-scan');
  });

  it('索引扫描与按 _id 直取都算用上了索引', () => {
    expect(explainVerdict({ stages: [stage('FETCH'), stage('IXSCAN', 1, 'email_1')] })).toBe('index');
    expect(explainVerdict({ stages: [stage('EXPRESS_IXSCAN', 0, 'email_1')] })).toBe('index');
    expect(explainVerdict({ stages: [stage('IDHACK')] })).toBe('index');
  });

  it('两者都不是时不下结论', () => {
    expect(explainVerdict({ stages: [stage('EOF')] })).toBe('other');
    expect(explainVerdict({ stages: [] })).toBe('other');
  });

  it('一行里缩进表示层级、带索引名', () => {
    expect(planLine(stage('IXSCAN', 2, 'email_1'))).toBe('    IXSCAN (email_1)');
    expect(planLine(stage('FETCH'))).toBe('FETCH');
  });
});
