import { DatabaseType } from './connection';

/**
 * 真正能连上的数据库类型。
 *
 * 唯一的依据是后端编进了哪几个驱动：sqlx 的 features，加上不走 sqlx 的独立驱动
 * （SQL Server 的 tiberius）——都在 `src-tauri/Cargo.toml` 里。
 * 其余类型在界面上可见但不可选——留着是说明路线，选中它只会存下一个永远连不上
 * 的配置。`databaseSupport.test.ts` 直接读 Cargo.toml 比对，防止两边各改各的。
 */
export const SUPPORTED_DATABASE_TYPES: ReadonlySet<DatabaseType> = new Set([
  DatabaseType.SQLite,
  DatabaseType.MySQL,
  DatabaseType.PostgreSQL,
  DatabaseType.SqlServer,
  DatabaseType.Oracle,
  DatabaseType.DuckDB,
  DatabaseType.ClickHouse,
  DatabaseType.MongoDB,
  DatabaseType.Redis,
  DatabaseType.Neo4j,
  DatabaseType.Elasticsearch
]);

/** sqlx 的 driver feature 名到本项目类型的对应 */
export const SQLX_DRIVER_FEATURES: Readonly<Record<string, DatabaseType>> = {
  sqlite: DatabaseType.SQLite,
  mysql: DatabaseType.MySQL,
  postgres: DatabaseType.PostgreSQL
};

/** 不走 sqlx 的驱动：`Cargo.toml` 里有这个依赖，对应的类型就连得上 */
export const STANDALONE_DRIVER_CRATES: Readonly<Record<string, readonly DatabaseType[]>> = {
  tiberius: [DatabaseType.SqlServer],
  oracle: [DatabaseType.Oracle],
  duckdb: [DatabaseType.DuckDB],
  mongodb: [DatabaseType.MongoDB],
  redis: [DatabaseType.Redis],
  neo4j: [DatabaseType.Neo4j],
  // 这两家没有驱动，就是 HTTP：有 reqwest 才连得上
  reqwest: [DatabaseType.Elasticsearch, DatabaseType.ClickHouse]
};

/**
 * 走 SQL 的那一族：编辑器、对象目录查询、表格写入、执行计划都是为它们写的。
 * 与后端 `DatabaseType::speaks_sql` 同一个集合。
 *
 * MongoDB 之前它和「能连上」是同一件事；MongoDB 与 Redis 有驱动而不走 SQL，于是界面上
 * 凡是「这里要跑 SQL」的入口（新建查询标签、ER 图、建表）都要先问这一句。
 * 不走 SQL 的两家之间也各不相同，那些地方按类型分，不靠这一句的否定
 */
export function speaksSql(type: string): boolean {
  return isDatabaseTypeSupported(type as DatabaseType) && !NON_SQL_TYPES.has(type as DatabaseType);
}

const NON_SQL_TYPES: ReadonlySet<DatabaseType> = new Set([
  DatabaseType.MongoDB,
  DatabaseType.Redis,
  DatabaseType.Neo4j,
  DatabaseType.Elasticsearch
]);

/**
 * 有查询编辑器的：走 SQL 的那一族，加上写 Cypher 的 Neo4j、写 Dev Tools 请求的 Elasticsearch、
 * 写 `db.runCommand` 命令文档的 MongoDB。
 * 查询标签、新建查询、打开脚本文件都问这一句；ER 图、建表这些仍然只问 `speaksSql`。
 *
 * 三家复用的是查询**标签**（草稿、去重、持久化都现成），标签里画的是各自的编辑器
 */
export function hasQueryEditor(type: string): boolean {
  return speaksSql(type)
    || type === DatabaseType.Neo4j
    || type === DatabaseType.Elasticsearch
    || type === DatabaseType.MongoDB;
}

export function isDatabaseTypeSupported(type: DatabaseType): boolean {
  return SUPPORTED_DATABASE_TYPES.has(type);
}

/**
 * 能连上、但还没接完的功能。只有分阶段接入的类型会出现在这里。
 *
 * 一处声明、三处消费：界面上对应的按钮据此不出现（而不是点了才报错），
 * 会话的能力标记据此给出，连接表单那一格的「有缺口」说明据此逐项列出——
 * 三处读的是同一份清单，不会一处说能做、另一处说不能。
 */
export type PendingFeature =
  | 'dataEditing'
  /** 在查询结果里直接改（表数据页照样能改） */
  | 'resultEditing'
  | 'transactions'
  | 'explain'
  | 'structureEditing'
  | 'import'
  | 'streamingExport';

/**
 * 分阶段接入的库还没接上的功能。SQL Server、Oracle、DuckDB 的各个阶段都已接上（TODOs 4.2）。
 *
 * ClickHouse 这四项不是「还没做完」，是这一版有意不做：没有通用事务；CSV 导入做不到
 * 「中途失败什么都不留」；建表要选引擎、写排序键，表单做不通用。表数据页能改，一次一项、
 * 执行前后各数一遍（`pendingChanges` 的 ClickHouse 那一段）；查询结果里不开这套，到表数据页改
 */
export const PENDING_FEATURES: Readonly<Partial<Record<DatabaseType, readonly PendingFeature[]>>> = {
  [DatabaseType.ClickHouse]: ['resultEditing', 'transactions', 'structureEditing', 'import']
};

/**
 * 清单里的功能是**有意不做**、不是「还没接完」的类型。界面上的三处说法（连接表单那一格、
 * 表数据页与结果网格的只读说明）据此换一句：说「分阶段接入」会让人等一个不会来的功能
 */
const GAPS_BY_DESIGN: ReadonlySet<string> = new Set([DatabaseType.ClickHouse]);

/** 收字符串，理由同 `supportsFeature` */
export function hasGapsByDesign(dbType: string): boolean {
  return GAPS_BY_DESIGN.has(dbType);
}

/** `dbType` 收字符串：调用方手里常常只有方言名（`'sqlserver'`），它与类型值同形 */
export function supportsFeature(dbType: string, feature: PendingFeature): boolean {
  return !PENDING_FEATURES[dbType as DatabaseType]?.includes(feature);
}
