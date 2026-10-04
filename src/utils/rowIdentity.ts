import type { ColumnInfo } from '../contracts';
import type { IndexInfo } from './schemaObjects';
import type { SerializedResultValue } from '../contracts/resultSet';
import { isConcurrencyComparable } from './columnTypes';
import { isTaggedResultValue, unwrapResultValue } from './resultValues';
import type { RowKey } from './rowStatements';

/**
 * 「靠哪几列能定位到唯一一行」。
 *
 * 这是网格编辑、并发冲突检测和稳定分页共用的同一个问题。答案必须来自
 * **真实的约束元数据**——目录里的主键和唯一索引——而不是从列名猜。
 * 猜出来的键（比如「叫 id 的那一列」）在一张把别人的 id 冗余存下来的表上
 * 会指向完全错误的行，而拼出的 UPDATE 语法正确、执行成功、不报任何错。
 */

export type RowIdentitySource = 'primary-key' | 'unique-index' | 'whole-row';

export interface RowIdentity {
  /** 键列，按键内次序 */
  columns: string[];
  source: RowIdentitySource;
  /** 唯一索引的名字，用来在界面上说清「靠的是哪个键」；主键时为 null */
  indexName: string | null;
}

/**
 * 没有行标识的三种情形，必须分开说——它们对用户是三件不同的事：
 *
 * - `metadata-pending`：索引还没读回来。列信息先到、索引后到，这中间如果
 *   直接说「没有唯一键」，用户会读到一句随后被推翻的断言。
 * - `metadata-unavailable`：目录查询失败了。此时同样不能改，但原因是**我们
 *   不知道**，不是「这张表没有键」——后者是一句关于他的表的假话。
 * - `no-unique-key`：读完了，确实没有。
 */
export type RowIdentityAbsence = 'metadata-pending' | 'metadata-unavailable' | 'no-unique-key';

/**
 * 索引元数据的三种状态。
 *
 * 用一个 `IndexInfo[] | null` 表达不了「读失败」——空数组和读不到会挤在一起，
 * 而它们导出的结论正好相反（「确实没有唯一键」对「不知道有没有」）。
 */
export type IndexMetadata =
  | { status: 'pending' }
  | { status: 'unavailable' }
  | { status: 'loaded'; indexes: readonly IndexInfo[] };

export type RowIdentityResult =
  | { identity: RowIdentity; absence: null }
  | { identity: null; absence: RowIdentityAbsence };

/**
 * 主键列，按主键内的次序。
 *
 * `primary_key_ordinal` 缺席时退回列在表里的位置——它至少是确定的。按行到达
 * 的顺序拼复合键会在不同驱动上得到不同的列序，而错序的 WHERE 看上去完全正常。
 */
export function primaryKeyColumns(columns: readonly ColumnInfo[]): string[] {
  return columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => column.is_primary_key)
    .sort((left, right) => (
      (left.column.primary_key_ordinal ?? left.index + 1)
      - (right.column.primary_key_ordinal ?? right.index + 1)
    ))
    .map(({ column }) => column.name);
}

/** 选出定位一行用的键。 */
export function describeRowIdentity(
  columns: readonly ColumnInfo[],
  indexes: IndexMetadata
): RowIdentityResult {
  // 表结构本身还没到：拿不出任何列，更谈不上键
  if (columns.length === 0) {
    return { identity: null, absence: 'metadata-pending' };
  }

  const keyColumns = primaryKeyColumns(columns);
  if (keyColumns.length > 0) {
    // 主键不必等索引：它来自列元数据，而且 SQLite 的 INTEGER PRIMARY KEY
    // 根本不在 pragma_index_list 里，等下去也等不到
    return { identity: { columns: keyColumns, source: 'primary-key', indexName: null }, absence: null };
  }

  if (indexes.status !== 'loaded') {
    return {
      identity: null,
      absence: indexes.status === 'pending' ? 'metadata-pending' : 'metadata-unavailable'
    };
  }

  const candidates = indexes.indexes
    .filter(index => isUsableIdentityIndex(index, columns))
    // 列少的优先：条件短、可读，出问题时也更容易看出是哪一行。
    // 同长度按名字，只是为了同一张表每次选出同一个键
    .sort((left, right) => left.columns.length - right.columns.length
      || left.name.localeCompare(right.name));

  const chosen = candidates[0];
  if (!chosen) {
    return { identity: null, absence: 'no-unique-key' };
  }

  return {
    identity: { columns: [...chosen.columns], source: 'unique-index', indexName: chosen.name },
    absence: null
  };
}

function isUsableIdentityIndex(index: IndexInfo, columns: readonly ColumnInfo[]): boolean {
  if (!index.isUnique || index.columns.length === 0) {
    return false;
  }
  // 部分索引只在谓词成立的行上唯一；未验证的索引则从没在存量数据上查过重复
  if (index.isPartial || !index.isValid) {
    return false;
  }

  return index.columns.every(name => {
    const column = columns.find(candidate => candidate.name === name);
    // 匹配不上的是表达式索引（PostgreSQL 返回 `lower(email)`，
    // MySQL 返回函数索引原文）——它唯一的是表达式的值，不是某一列的值
    if (!column) {
      return false;
    }
    // 唯一索引把 NULL 之间看作互不相等，所以一个可空的唯一列上可以有任意多行
    // 是 NULL。`= NULL` 一行都匹配不到，`IS NULL` 又可能匹配一批
    return !column.is_nullable;
  });
}

/**
 * ClickHouse 的行标识：**整行**里比得准的那些列。
 *
 * 它的主键不约束唯一（两行一模一样也收），目录里的键定位不到「这一行」。整行去比，
 * 比得准的列都相等才算同一行；而「恰好一行」不靠这里保证——提交时先数一遍，不是 1 就不执行
 * （见 `pendingChanges` 的 ClickHouse 那一段）。少比几列（浮点、数组）只会让计数更容易不成立，
 * 不会改错行。EPHEMERAL 列不存值，不比
 */
export function wholeRowIdentity(columns: readonly ColumnInfo[]): RowIdentityResult {
  if (columns.length === 0) {
    return { identity: null, absence: 'metadata-pending' };
  }
  const comparable = columns
    .filter((column) => !(column.column_extra ?? '').startsWith('EPHEMERAL'))
    .filter((column) => isConcurrencyComparable(column.data_type, 'clickhouse'))
    .map((column) => column.name);
  if (comparable.length === 0) {
    return { identity: null, absence: 'no-unique-key' };
  }
  return { identity: { columns: comparable, source: 'whole-row', indexName: null }, absence: null };
}

/**
 * 这一行的键值：键列上的值，拆掉展示用的包装——绑进 SQL 的必须是字面量。
 *
 * 整行定位（ClickHouse）时，这一行里显示成二进制的值（非 UTF-8 的 String / FixedString）不进条件：
 * 拆出来的是十六进制文本，拿它当参数去比，服务端按原字节读，比不中还报「值太长」。
 * 少比一列只会让「恰好一行」更难成立，不会改错行。别的键里的二进制值记在 `binary` 里，由语句写成字面量
 */
export function rowKeyOf(identity: RowIdentity | null, values: Readonly<Record<string, unknown>>): RowKey {
  const columns = (identity?.columns ?? []).filter((name) => {
    const value = values[name] as SerializedResultValue;
    return !(identity?.source === 'whole-row' && isTaggedResultValue(value) && value.type === 'binary');
  });
  return rowKeyFromColumns(columns, values);
}

/**
 * 按给定的键列取键值。SQL 标签里就地改查询结果也走这里：键列来自目录，值是结果里带包装的原值
 */
export function rowKeyFromColumns(columns: readonly string[], values: Readonly<Record<string, unknown>>): RowKey {
  const binary = columns.filter((name) => {
    const value = values[name] as SerializedResultValue;
    return isTaggedResultValue(value) && value.type === 'binary';
  });
  return {
    columns: [...columns],
    values: Object.fromEntries(columns.map((name) => [name, unwrapResultValue(values[name] as SerializedResultValue)])),
    ...(binary.length > 0 && { binary })
  };
}
