export type ResultColumnLogicalType =
  | 'boolean'
  | 'integer'
  | 'decimal'
  | 'text'
  | 'binary'
  | 'date'
  | 'time'
  | 'datetime'
  | 'json'
  | 'unknown';

export interface ResultColumn {
  name: string;
  ordinal: number;
  databaseType: string;
  logicalType: ResultColumnLogicalType;
  nullable: boolean;
  precision?: number;
  scale?: number;
}

export type SerializedResultValue =
  | null
  | boolean
  | number
  | string
  | {
      type: 'bigint' | 'decimal' | 'date' | 'time' | 'datetime' | 'json' | 'binary';
      value: string;
    };

export type ResultRow = SerializedResultValue[];

export interface ResultBatch {
  index: number;
  offset: number;
  rows: ResultRow[];
}

export type ResultSetTruncationReason = 'row-limit' | 'byte-limit' | 'cancelled';

export interface ResultSetTruncation {
  isTruncated: boolean;
  reason: ResultSetTruncationReason | null;
  limit: number | null;
}

export interface EditableResultSet {
  editable: true;
  source: {
    schema: string | null;
    table: string;
    keyColumns: string[];
  };
}

export interface ReadOnlyResultSet {
  editable: false;
  reason:
    | 'not-a-table-result'
    | 'complex-query'
    | 'missing-unique-key'
    | 'unsupported-column-type'
    | 'session-read-only';
}

export type ResultSetEditability = EditableResultSet | ReadOnlyResultSet;

export interface ResultSet {
  id: string;
  executionId: string;
  columns: ResultColumn[];
  batches: ResultBatch[];
  rowCount: number;
  truncation: ResultSetTruncation;
  editability: ResultSetEditability;
  createdAt: string;
}

interface CreateResultSetOptions {
  id?: string;
  now?: string;
  truncation?: ResultSetTruncation;
}

function cloneEditability(editability: ResultSetEditability): ResultSetEditability {
  if (!editability.editable) {
    return { ...editability };
  }

  return {
    editable: true,
    source: {
      ...editability.source,
      keyColumns: [...editability.source.keyColumns]
    }
  };
}

function cloneResultValue(value: SerializedResultValue): SerializedResultValue {
  if (value !== null && typeof value === 'object') {
    return { ...value };
  }

  return value;
}

export function createResultSet(
  executionId: string,
  columns: ResultColumn[],
  editability: ResultSetEditability,
  options: CreateResultSetOptions = {}
): ResultSet {
  return {
    id: options.id ?? crypto.randomUUID(),
    executionId,
    columns: columns.map(column => ({ ...column })),
    batches: [],
    rowCount: 0,
    truncation: options.truncation
      ? { ...options.truncation }
      : {
          isTruncated: false,
          reason: null,
          limit: null
        },
    editability: cloneEditability(editability),
    createdAt: options.now ?? new Date().toISOString()
  };
}

export function appendResultBatch(
  resultSet: ResultSet,
  rows: ResultRow[]
): ResultSet {
  const invalidRowIndex = rows.findIndex(row => row.length !== resultSet.columns.length);
  if (invalidRowIndex >= 0) {
    throw new Error(
      `结果批次第 ${invalidRowIndex + 1} 行包含 ${rows[invalidRowIndex].length} 列，预期 ${resultSet.columns.length} 列`
    );
  }

  const batch: ResultBatch = {
    index: resultSet.batches.length,
    offset: resultSet.rowCount,
    rows: rows.map(row => row.map(cloneResultValue))
  };

  return {
    ...resultSet,
    batches: [...resultSet.batches, batch],
    rowCount: resultSet.rowCount + rows.length
  };
}

export function truncateResultSet(
  resultSet: ResultSet,
  reason: ResultSetTruncationReason,
  limit: number | null
): ResultSet {
  return {
    ...resultSet,
    truncation: {
      isTruncated: true,
      reason,
      limit
    }
  };
}
