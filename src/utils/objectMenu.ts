import type { DatabaseObject, DatabaseObjectKind } from '../contracts/databaseMetadata';
import { quoteQualifiedSqlIdentifier, type SqlIdentifierDialect } from './sqlIdentifiers';

export type ObjectMenuAction =
  | 'open-data'
  | 'open-structure'
  | 'view-definition'
  | 'copy-name';

/**
 * 每种对象右键能做什么。
 *
 * 写成 `Record` 而不是一串 `if`：新增一种对象类型时这里编译不过，
 * 逼着想一遍它能做什么——漏掉的后果是右键出来一个空菜单。
 *
 * 三条边界都是真的，不是保守：
 * - **函数、存储过程、序列没有行**，打开表视图只会查询失败。
 * - **视图不给「打开结构」**：结构页是个可编辑的编辑器（`TableStructureEditor`），
 *   它不知道自己打开的是不是视图，改列会生成对视图无效的 DDL。
 *   让结构页认得视图是另一件事，不在这条里顺手做。
 * - **表不给「查看定义」**：表的定义就在结构页里，它同时还给列、索引、外键。
 *
 * 由此来的不变量：**每种对象恰好有一条看它是什么的路**——表走结构页，
 * 其余走定义弹窗。视图此前两条都没有：不给结构页，也不给查看定义，
 * 于是一个视图的 SELECT 原文在界面上根本读不到（`pg_get_viewdef` 明明已经
 * 在 `schema_metadata.rs` 里了，只是没有入口）。
 */
export const OBJECT_MENU_ACTIONS: Record<DatabaseObjectKind, readonly ObjectMenuAction[]> = {
  table: ['open-data', 'open-structure', 'copy-name'],
  view: ['open-data', 'view-definition', 'copy-name'],
  'materialized-view': ['open-data', 'view-definition', 'copy-name'],
  function: ['view-definition', 'copy-name'],
  procedure: ['view-definition', 'copy-name'],
  sequence: ['view-definition', 'copy-name']
};

/**
 * 例程的显示名带着参数签名——`calc_total(integer)`——因为同名重载要分得开
 * （见 `object_catalog.rs` 里 `pg_get_function_identity_arguments` 那一段）。
 *
 * 把整串当成一个标识符引起来会得到 `"calc_total(integer)"`，那是**一个名字里
 * 带括号的函数**，粘进 SQL 必然报错。括号那一半原样留在引号外：
 * `"public"."calc_total"(integer)` 正是 PostgreSQL 指定某个重载的写法。
 *
 * 按 `kind` 拆而不是看名字里有没有括号：表真的可以叫 `weird(name)`，
 * 照括号拆会把它的名字切坏。
 */
function splitRoutineSignature(
  object: Pick<DatabaseObject, 'name' | 'kind'>
): { name: string; signature: string } {
  if (object.kind !== 'function' && object.kind !== 'procedure') {
    return { name: object.name, signature: '' };
  }
  const open = object.name.indexOf('(');
  return open === -1
    ? { name: object.name, signature: '' }
    : { name: object.name.slice(0, open), signature: object.name.slice(open) };
}

/**
 * 带引号的限定名，拿去就能粘进 SQL。
 *
 * 复制裸名字没有用：`order` 是关键字，`My Table` 带空格，PostgreSQL 上还
 * 少了 schema。手写查询时要的就是能直接粘的那一串。
 */
export function qualifiedObjectName(
  object: Pick<DatabaseObject, 'name' | 'schema' | 'kind'>,
  dialect: SqlIdentifierDialect
): string {
  const { name, signature } = splitRoutineSignature(object);
  const parts = object.schema ? [object.schema, name] : [name];
  return quoteQualifiedSqlIdentifier(parts, dialect) + signature;
}
