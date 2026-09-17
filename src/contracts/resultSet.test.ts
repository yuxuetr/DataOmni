import { describe, expect, it } from 'vitest';
import {
  appendResultBatch,
  createResultSet,
  ResultColumn,
  truncateResultSet
} from './resultSet';

const columns: ResultColumn[] = [
  {
    name: 'id',
    ordinal: 0,
    databaseType: 'BIGINT',
    logicalType: 'integer',
    nullable: false
  },
  {
    name: 'balance',
    ordinal: 1,
    databaseType: 'NUMERIC(30, 8)',
    logicalType: 'decimal',
    nullable: false,
    precision: 30,
    scale: 8
  }
];

describe('ResultSet', () => {
  it('preserves typed column metadata and explicit editability', () => {
    const resultSet = createResultSet(
      'execution-1',
      columns,
      {
        editable: true,
        source: {
          schema: 'public',
          table: 'accounts',
          keyColumns: ['id']
        }
      },
      {
        id: 'result-set-1',
        now: '2026-09-17T06:30:00.000Z'
      }
    );

    expect(resultSet.columns[1]).toMatchObject({
      logicalType: 'decimal',
      precision: 30,
      scale: 8
    });
    expect(resultSet.editability).toEqual({
      editable: true,
      source: {
        schema: 'public',
        table: 'accounts',
        keyColumns: ['id']
      }
    });
  });

  it('appends ordered batches without losing precise values', () => {
    const empty = createResultSet(
      'execution-1',
      columns,
      {
        editable: false,
        reason: 'complex-query'
      },
      { id: 'result-set-1' }
    );
    const first = appendResultBatch(empty, [
      [
        { type: 'bigint', value: '9007199254740993' },
        { type: 'decimal', value: '12345678901234567890.12345678' }
      ]
    ]);
    const second = appendResultBatch(first, [
      [
        { type: 'bigint', value: '9007199254740994' },
        { type: 'decimal', value: '0.00000001' }
      ]
    ]);

    expect(second.rowCount).toBe(2);
    expect(second.batches.map(batch => batch.offset)).toEqual([0, 1]);
    expect(second.batches[0].rows[0][0]).toEqual({
      type: 'bigint',
      value: '9007199254740993'
    });
  });

  it('rejects rows that do not match the column shape', () => {
    const resultSet = createResultSet(
      'execution-1',
      columns,
      {
        editable: false,
        reason: 'missing-unique-key'
      },
      { id: 'result-set-1' }
    );

    expect(() => appendResultBatch(resultSet, [[1]])).toThrow('预期 2 列');
  });

  it('records why a result was truncated', () => {
    const resultSet = createResultSet(
      'execution-1',
      columns,
      {
        editable: false,
        reason: 'session-read-only'
      },
      { id: 'result-set-1' }
    );
    const truncated = truncateResultSet(resultSet, 'row-limit', 1000);

    expect(truncated.truncation).toEqual({
      isTruncated: true,
      reason: 'row-limit',
      limit: 1000
    });
  });
});
