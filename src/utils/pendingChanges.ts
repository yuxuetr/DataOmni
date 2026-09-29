import { isUnchangedInput, type BoundValue, type CellInput } from './cellInput';
import {
  buildDeleteStatement,
  buildInsertStatement,
  buildRowCountStatement,
  buildUpdateStatement,
  type BoundStatement,
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

/**
 * 网格里这一格该画排队的新值还是加载时的值：返回新值，没改的列与待删的行返回 undefined。
 *
 * 排了队的行只给撤销、不能再编辑，格子里要是还画着旧值，用户就看不到自己改成了什么。
 */
export function pendingCellInput(
  pending: PendingUpdate | PendingDelete | undefined,
  column: string
): CellInput | undefined {
  return pending?.kind === 'update' ? pending.values[column] : undefined;
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
   *
   * ClickHouse 的写语句报不出影响行数（`ALTER … UPDATE` 与 `DELETE` 都报 0），那一条不给；
   * 核对落在它前后的两条 `SELECT count()` 上，比的是它们返回的那个数
   */
  expectRows?: number;
}

export function pendingStatements(
  changes: readonly PendingChange[],
  target: TableTarget
): WriteStatementPayload[] {
  return changes.flatMap((change) => changeStatements(change, target));
}

/** 一项改动要发的语句。多数方言是一条；ClickHouse 是「数一遍 → 执行 → 核对」三条 */
export function changeStatements(change: PendingChange, target: TableTarget): WriteStatementPayload[] {
  if (target.dialect === 'clickhouse') {
    return clickHouseStatements(change, target);
  }
  // 原值一并进 WHERE：键定位到行，原值确认这一行还是我们读到的那一行。
  // 两者配合后端「必须恰好影响一行」的核对，一次往返就把并发冲突挡在事务里
  const statement = change.kind === 'insert'
    ? buildInsertStatement(target, change.values)
    : change.kind === 'update'
      ? buildUpdateStatement(target, change.key, change.values, { values: change.original })
      : buildDeleteStatement(target, change.key, { values: change.original });
  return [payload(statement, 1)];
}

function payload(statement: BoundStatement, expectRows?: number): WriteStatementPayload {
  return { sql: statement.sql, params: statement.params, ...(expectRows === undefined ? {} : { expectRows }) };
}

/**
 * ClickHouse 没有事务，写语句也报不出改了几行。一项改动于是展开成三条，后端照顺序跑、逐条核对：
 *
 * - 新增：一条 `INSERT`，比服务端报的写入行数（它报得出）。
 * - 改：执行前整行数一遍必须恰好 1（0 是被别处改了，多于 1 是有一模一样的行、分不出是哪一行）；
 *   `ALTER TABLE … UPDATE` 等它做完；再按新值数，至少 1 行（新值恰好和另一行一样不算没改成）。
 *   写成表达式的列新值算不出来，不进这次核对。
 * - 删：执行前恰好 1；`DELETE`；再数一遍，0 行。
 *
 * 数完到执行之间别处写进一行一模一样的，会被一起改——这一点没有事务就消除不了，界面上写明
 */
function clickHouseStatements(change: PendingChange, target: TableTarget): WriteStatementPayload[] {
  if (change.kind === 'insert') {
    return [payload(buildInsertStatement(target, change.values), 1)];
  }
  const before = payload(buildRowCountStatement(target, change.key), 1);
  if (change.kind === 'delete') {
    return [
      before,
      payload(buildDeleteStatement(target, change.key)),
      payload(buildRowCountStatement(target, change.key), 0)
    ];
  }
  const knownAfter = change.key.columns.filter((column) => {
    const input = change.values[column];
    return input === undefined || input.kind === 'value' || input.kind === 'null';
  });
  const afterValues = Object.fromEntries(knownAfter.map((column) => {
    const input = change.values[column];
    const value = input === undefined ? change.key.values[column]
      : input.kind === 'value' ? input.value
        : null;
    return [column, value ?? null];
  }));
  const update = payload(buildUpdateStatement(target, change.key, change.values));
  // 比得准的列全写成了表达式：新值一个都算不出来，没有可核对的
  if (knownAfter.length === 0) {
    return [before, update];
  }
  return [
    before,
    update,
    payload(buildRowCountStatement(target, { columns: knownAfter, values: afterValues }, true), 1)
  ];
}

/**
 * 还能不能再排一项改动。
 *
 * ClickHouse 一次只提交一项：没有回滚，攒了三项、第二项失败时第一项已经生效，而用户看到的是
 * 「这一批没成」。同一行上接着改会合并进已有的那一项，算同一项
 */
export function canStageAnother(
  changes: readonly PendingChange[],
  rowId: string | null,
  dialect: string
): boolean {
  if (dialect !== 'clickhouse' || changes.length === 0) {
    return true;
  }
  return rowId !== null && changes.every((change) => change.kind !== 'insert' && change.rowId === rowId);
}
