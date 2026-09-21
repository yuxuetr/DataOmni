import { isUnchangedInput, type BoundValue, type CellInput } from './cellInput';
import {
  buildDeleteStatement,
  buildInsertStatement,
  buildUpdateStatement,
  type RowKey,
  type TableTarget
} from './rowStatements';

/**
 * 还没提交的改动。
 *
 * 此前是一改一提交：每按一次保存就是一条自动提交的语句。改三行就是三次独立
 * 提交，中间任何一条失败，前面几条已经落库了——用户看到一句错误，而数据停在
 * 一个他没打算要的中间状态。而且没有任何一处能在按下去**之前**告诉他这一批
 * 到底会改什么。
 */

export interface PendingInsert {
  id: string;
  kind: 'insert';
  values: Record<string, CellInput>;
}

export interface PendingUpdate {
  id: string;
  kind: 'update';
  /** 同一行的多次编辑要合并成一条，靠它认人 */
  rowId: string;
  key: RowKey;
  /** 这一行加载时的值，用来显示「从什么改成什么」并判断哪些列真的变了 */
  original: Record<string, BoundValue>;
  values: Record<string, CellInput>;
}

export interface PendingDelete {
  id: string;
  kind: 'delete';
  rowId: string;
  key: RowKey;
  original: Record<string, BoundValue>;
}

export type PendingChange = PendingInsert | PendingUpdate | PendingDelete;

/**
 * 一行的身份。
 *
 * 用键值而不是行在页面上的下标：翻页、排序、筛选之后同一个下标是另一行，
 * 而待提交的改动跨得过这些操作。
 */
export function rowIdOf(key: RowKey): string {
  return JSON.stringify(key.columns.map((column) => key.values[column] ?? null));
}

function newId(): string {
  return crypto.randomUUID();
}

export function pendingForRow(
  changes: readonly PendingChange[],
  rowId: string
): PendingUpdate | PendingDelete | undefined {
  return changes.find(
    (change): change is PendingUpdate | PendingDelete =>
      change.kind !== 'insert' && change.rowId === rowId
  );
}

/** 只留下真的变了的列 */
function changedOnly(
  values: Readonly<Record<string, CellInput>>,
  original: Readonly<Record<string, BoundValue>>
): Record<string, CellInput> {
  return Object.fromEntries(
    Object.entries(values).filter(([column, input]) =>
      !isUnchangedInput(input, original[column] ?? null))
  );
}

/**
 * 记下一次行内编辑。
 *
 * 同一行只保留一条待提交改动：重复编辑合并进去，改回原值的列自动退出，
 * 全部改回原值时整条改动消失——否则「待提交 3 项」里会混着什么也不做的那几项。
 */
export function stageUpdate(
  changes: readonly PendingChange[],
  key: RowKey,
  original: Readonly<Record<string, BoundValue>>,
  values: Readonly<Record<string, CellInput>>,
  id: string = newId()
): PendingChange[] {
  const rowId = rowIdOf(key);
  const existing = pendingForRow(changes, rowId);
  // 已经排了删除的行不再接受编辑；界面上那一行本来就该是不可编辑的
  if (existing?.kind === 'delete') {
    return [...changes];
  }

  const merged = changedOnly(
    { ...(existing?.kind === 'update' ? existing.values : {}), ...values },
    original
  );
  const without = changes.filter((change) => change !== existing);
  if (Object.keys(merged).length === 0) {
    return without;
  }

  return [
    ...without,
    {
      id: existing?.id ?? id,
      kind: 'update',
      rowId,
      key,
      original: { ...original },
      values: merged
    }
  ];
}

/** 删除盖过同一行上待提交的编辑——改完再删，那次编辑不必发出去 */
export function stageDelete(
  changes: readonly PendingChange[],
  key: RowKey,
  original: Readonly<Record<string, BoundValue>>,
  id: string = newId()
): PendingChange[] {
  const rowId = rowIdOf(key);
  const existing = pendingForRow(changes, rowId);
  if (existing?.kind === 'delete') {
    return [...changes];
  }

  return [
    ...changes.filter((change) => change !== existing),
    { id: existing?.id ?? id, kind: 'delete', rowId, key, original: { ...original } }
  ];
}

export function stageInsert(
  changes: readonly PendingChange[],
  values: Readonly<Record<string, CellInput>>,
  id: string = newId()
): PendingChange[] {
  return [...changes, { id, kind: 'insert', values: { ...values } }];
}

export function revertChange(
  changes: readonly PendingChange[],
  id: string
): PendingChange[] {
  return changes.filter((change) => change.id !== id);
}

/** 一条待提交改动会写到哪几列 */
export function changedColumns(change: PendingChange): string[] {
  return change.kind === 'delete' ? [] : Object.keys(change.values);
}

/** 发给 `execute_write_batch` 的一条语句 */
export interface WriteStatementPayload {
  sql: string;
  params: BoundValue[];
  /**
   * 必须影响的行数，由后端在事务里核对。
   *
   * UPDATE / DELETE 一律是 1：零行说明那一行被别人改了或删了，多行说明键不唯一。
   * 两种都必须整批回滚，而不是提交完再报告。
   */
  expectRows: number;
}

export function pendingStatements(
  changes: readonly PendingChange[],
  target: TableTarget
): WriteStatementPayload[] {
  return changes.map((change) => {
    const statement = change.kind === 'insert'
      ? buildInsertStatement(target, change.values)
      : change.kind === 'update'
        ? buildUpdateStatement(target, change.key, change.values)
        : buildDeleteStatement(target, change.key);
    return { sql: statement.sql, params: statement.params, expectRows: 1 };
  });
}
