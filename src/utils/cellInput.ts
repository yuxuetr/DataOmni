/** 能绑定进语句的值。`null` 是 SQL 的 NULL，不是「没有值」 */
export type BoundValue = string | number | boolean | null;

/**
 * 一个单元格「要写什么」。
 *
 * 朴素的做法是让编辑框直接给一个字符串，空串当 NULL。那样一来**五件不同的事**
 * 挤进了同一个值：
 *
 * - `null`：写 NULL
 * - `value` 且文本为空：写空字符串。`IS NULL` 和 `= ''` 在查询里是两个不同的
 *   条件，在唯一索引下是两个不同的键，在 NOT NULL 列上一个报错一个不报
 * - `default`：让数据库套用列默认值（自增、`CURRENT_TIMESTAMP`、序列…）。
 *   写成 NULL 得到的是 NULL，不是默认值
 * - `expression`：原样写进语句的 SQL，比如 `CURRENT_TIMESTAMP` 或 `nextval(...)`。
 *   当成字面量绑定进去，存下的是那串字符本身
 * - `unset`：用户没碰过这一列。更新时不进 SET，新增时不进列清单
 *
 * `value` 的载荷不允许是 null——那样 `{kind:'value', value:null}` 和
 * `{kind:'null'}` 会同时表示同一件事，而两条路径迟早会分叉。
 */
export type CellInput =
  | { kind: 'value'; value: string | number | boolean }
  | { kind: 'null' }
  | { kind: 'default' }
  | { kind: 'expression'; sql: string }
  | { kind: 'unset' };

export type CellInputKind = CellInput['kind'];

/** 编辑框里能选的几种状态，按用得多少排 */
export const CELL_INPUT_KINDS: readonly CellInputKind[] = [
  'value', 'null', 'default', 'expression'
];

/**
 * 把已有的值变成编辑起点。
 *
 * NULL 回到 `null` 而不是空文本——否则打开编辑框再直接关掉，就把一个 NULL
 * 变成了空字符串。
 */
export function cellInputFromValue(value: BoundValue): CellInput {
  if (value === null) {
    return { kind: 'null' };
  }
  return { kind: 'value', value };
}

/**
 * 这次编辑相对原值有没有变化。
 *
 * 没变就不该进 SET：MySQL 对「新值等于旧值」的 UPDATE 返回 0 affected rows，
 * 而 0 正是「一行都没匹配上」的信号——提交时那一条会被当成并发冲突，
 * 整批跟着回滚，而用户其实什么也没改。
 *
 * `default` 与 `expression` 一律算变化——它们的结果由数据库决定，这里算不出来。
 */
export function isUnchangedInput(input: CellInput, original: BoundValue): boolean {
  switch (input.kind) {
    case 'unset':
      return true;
    case 'null':
      return original === null;
    case 'value':
      return input.value === original;
    default:
      return false;
  }
}

/** 这一项会不会被写进语句 */
export function willWrite(input: CellInput): boolean {
  return input.kind !== 'unset';
}

/**
 * 新增时「什么都没填」的列。
 *
 * 非空且没有默认值的列上，`unset` 等于把插入交给数据库去拒绝，报出来的是
 * 一句方言各异的约束错误。提前点名这些列，用户改一处就能提交。
 */
export function missingRequiredColumns(
  inputs: Readonly<Record<string, CellInput>>,
  columns: readonly {
    name: string;
    is_nullable: boolean;
    default_value?: string;
    is_generated?: boolean;
  }[]
): string[] {
  return columns
    .filter((column) => {
      // 自增与计算列由数据库填，点名要求用户填反而会让整张表插不进行
      if (column.is_nullable || column.default_value != null || column.is_generated) {
        return false;
      }
      const input = inputs[column.name];
      return !input || input.kind === 'unset' || input.kind === 'default';
    })
    .map((column) => column.name);
}

/**
 * 差异预览里怎么写一个待写入的值。
 *
 * 空字符串写成 `''` 而不是一片空白：差异预览的整个用处就是在按下提交之前
 * 看清楚要写什么，而「空白」在这里同时可能是空串、NULL 和没填。
 */
export function describeCellInput(input: CellInput): string {
  switch (input.kind) {
    case 'null':
      return 'NULL';
    case 'default':
      return 'DEFAULT';
    case 'expression':
      return input.sql;
    case 'unset':
      return '—';
    default:
      return input.value === '' ? "''" : String(input.value);
  }
}

/** 同上，用于原值 */
export function describeBoundValue(value: BoundValue): string {
  if (value === null) {
    return 'NULL';
  }
  return value === '' ? "''" : String(value);
}
