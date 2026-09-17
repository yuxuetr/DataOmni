import { SerializedResultValue } from './resultSet';

export type RowValues = Record<string, SerializedResultValue>;

export interface OriginalRowReference {
  keyValues: RowValues;
  originalValues: RowValues;
}

interface RowChangeBase {
  id: string;
}

export interface InsertRowChange extends RowChangeBase {
  kind: 'insert';
  values: RowValues;
}

export interface UpdateRowChange extends RowChangeBase {
  kind: 'update';
  row: OriginalRowReference;
  values: RowValues;
}

export interface DeleteRowChange extends RowChangeBase {
  kind: 'delete';
  row: OriginalRowReference;
}

export type RowChange = InsertRowChange | UpdateRowChange | DeleteRowChange;

export type ChangeSetStatus = 'draft' | 'committing' | 'committed' | 'failed';

export interface ChangeSetCommitState {
  startedAt: string | null;
  finishedAt: string | null;
  affectedRows: number | null;
  error: string | null;
}

export interface ChangeSet {
  id: string;
  resultSetId: string;
  target: {
    readonly profileId: string;
    readonly sessionId: string;
    readonly schema: string | null;
    readonly table: string;
  };
  changes: RowChange[];
  status: ChangeSetStatus;
  createdAt: string;
  updatedAt: string;
  commit: ChangeSetCommitState;
}

interface ChangeSetOptions {
  id?: string;
  now?: string;
}

interface RowChangeOptions {
  id?: string;
}

function cloneValue(value: SerializedResultValue): SerializedResultValue {
  if (value !== null && typeof value === 'object') {
    return { ...value };
  }

  return value;
}

function cloneValues(values: RowValues): RowValues {
  return Object.fromEntries(
    Object.entries(values).map(([column, value]) => [column, cloneValue(value)])
  );
}

function cloneRowReference(row: OriginalRowReference): OriginalRowReference {
  if (Object.keys(row.keyValues).length === 0) {
    throw new Error('原始行引用必须包含至少一个键列');
  }

  return {
    keyValues: cloneValues(row.keyValues),
    originalValues: cloneValues(row.originalValues)
  };
}

function assertDraft(changeSet: ChangeSet): void {
  if (changeSet.status !== 'draft') {
    throw new Error(`变更集 ${changeSet.id} 当前状态为 ${changeSet.status}，无法继续修改`);
  }
}

function appendChange(
  changeSet: ChangeSet,
  change: RowChange,
  updatedAt: string
): ChangeSet {
  assertDraft(changeSet);

  return {
    ...changeSet,
    changes: [...changeSet.changes, change],
    updatedAt
  };
}

export function createChangeSet(
  resultSetId: string,
  target: ChangeSet['target'],
  options: ChangeSetOptions = {}
): ChangeSet {
  const now = options.now ?? new Date().toISOString();

  return {
    id: options.id ?? crypto.randomUUID(),
    resultSetId,
    target: { ...target },
    changes: [],
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    commit: {
      startedAt: null,
      finishedAt: null,
      affectedRows: null,
      error: null
    }
  };
}

export function stageInsert(
  changeSet: ChangeSet,
  values: RowValues,
  options: RowChangeOptions = {},
  updatedAt: string = new Date().toISOString()
): ChangeSet {
  return appendChange(
    changeSet,
    {
      id: options.id ?? crypto.randomUUID(),
      kind: 'insert',
      values: cloneValues(values)
    },
    updatedAt
  );
}

export function stageUpdate(
  changeSet: ChangeSet,
  row: OriginalRowReference,
  values: RowValues,
  options: RowChangeOptions = {},
  updatedAt: string = new Date().toISOString()
): ChangeSet {
  if (Object.keys(values).length === 0) {
    throw new Error('更新操作必须包含至少一个修改列');
  }

  return appendChange(
    changeSet,
    {
      id: options.id ?? crypto.randomUUID(),
      kind: 'update',
      row: cloneRowReference(row),
      values: cloneValues(values)
    },
    updatedAt
  );
}

export function stageDelete(
  changeSet: ChangeSet,
  row: OriginalRowReference,
  options: RowChangeOptions = {},
  updatedAt: string = new Date().toISOString()
): ChangeSet {
  return appendChange(
    changeSet,
    {
      id: options.id ?? crypto.randomUUID(),
      kind: 'delete',
      row: cloneRowReference(row)
    },
    updatedAt
  );
}

export function startChangeSetCommit(
  changeSet: ChangeSet,
  startedAt: string = new Date().toISOString()
): ChangeSet {
  assertDraft(changeSet);
  if (changeSet.changes.length === 0) {
    throw new Error('空变更集无法提交');
  }

  return {
    ...changeSet,
    status: 'committing',
    updatedAt: startedAt,
    commit: {
      startedAt,
      finishedAt: null,
      affectedRows: null,
      error: null
    }
  };
}

export function completeChangeSetCommit(
  changeSet: ChangeSet,
  affectedRows: number,
  finishedAt: string = new Date().toISOString()
): ChangeSet {
  if (changeSet.status !== 'committing') {
    throw new Error(`变更集 ${changeSet.id} 当前状态为 ${changeSet.status}，无法完成提交`);
  }

  return {
    ...changeSet,
    status: 'committed',
    updatedAt: finishedAt,
    commit: {
      ...changeSet.commit,
      finishedAt,
      affectedRows,
      error: null
    }
  };
}

export function failChangeSetCommit(
  changeSet: ChangeSet,
  error: string,
  finishedAt: string = new Date().toISOString()
): ChangeSet {
  if (changeSet.status !== 'committing') {
    throw new Error(`变更集 ${changeSet.id} 当前状态为 ${changeSet.status}，无法标记失败`);
  }

  return {
    ...changeSet,
    status: 'failed',
    updatedAt: finishedAt,
    commit: {
      ...changeSet.commit,
      finishedAt,
      affectedRows: null,
      error
    }
  };
}
