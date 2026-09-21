import { describe, expect, it } from 'vitest';
import { describeTableEditability } from './tableEditability';
import type { RowIdentityResult } from './rowIdentity';

const identity = (columns: string[]): RowIdentityResult => ({
  identity: { columns, source: 'primary-key', indexName: null },
  absence: null
});

describe('describeTableEditability', () => {
  it('单列键可以改', () => {
    expect(describeTableEditability(identity(['id']))).toEqual({
      editable: true,
      reason: null,
      keyColumns: ['id']
    });
  });

  it('复合键暂时只读，并说得出是哪几列', () => {
    // 写入路径只会拼第一列，亮着的按钮会静默改掉一批同前缀的行
    expect(describeTableEditability(identity(['tenant', 'sku']))).toEqual({
      editable: false,
      reason: 'composite-key',
      keyColumns: ['tenant', 'sku']
    });
  });

  it('没有行标识时把原因原样带出来', () => {
    for (const absence of ['metadata-pending', 'metadata-unavailable', 'no-unique-key'] as const) {
      expect(describeTableEditability({ identity: null, absence })).toEqual({
        editable: false,
        reason: absence,
        keyColumns: []
      });
    }
  });
});
