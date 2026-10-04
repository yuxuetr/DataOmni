import type { SqlDialect } from '../contracts/queryExecution';
import type { ErLink, ErTable } from './erLayout';
import { quoteQualifiedSqlIdentifier, quoteSqlIdentifier } from './sqlIdentifiers';
import { buildCreateTable } from './tableDdl';

/**
 * 一份还没建出来的多表设计：AI 的输出、ER 图的输入、建表 DDL 的输入三者之间唯一的中间形态。
 *
 * 只描述**新建**的表。改已有的表要生成 ALTER、考虑数据迁移，不在这里（rfcs/ai-design-and-export.md §2.3）。
 */
export interface SchemaDraft {
  tables: TableDraft[];
}

export interface TableDraft {
  name: string;
  columns: ColumnSpec[];
  /** 主键的列名，按次序；空 = 没有主键 */
  primaryKey: string[];
  /** 每项一组列，建成表级 `UNIQUE (…)`——外键只能指向主键或唯一约束 */
  unique: string[][];
  indexes: IndexDraft[];
  foreignKeys: ForeignKeyDraft[];
}

export interface ColumnSpec {
  name: string;
  /** 照原样写进 DDL 的类型（`varchar(64)`、`bigint`）。认不认由数据库说了算，这里不猜 */
  dataType: string;
  nullable: boolean;
  /** 默认值的 SQL 原文；null = 没有 */
  defaultValue: string | null;
}

export interface IndexDraft {
  columns: string[];
}

export interface ForeignKeyDraft {
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  /**
   * 只给两种：五家都认的只有 CASCADE 与 SET NULL（Oracle 没有 RESTRICT / NO ACTION 的写法，
   * SQL Server 没有 RESTRICT）。null = 数据库的默认行为（拒绝删除被引用的行）
   */
  onDelete: 'cascade' | 'set null' | null;
}

/** 能建表的方言。ClickHouse 建表要选引擎、写排序键，这一版不做（databaseSupport 的 structureEditing） */
export type CreatableDialect = Exclude<SqlDialect, 'clickhouse'>;

export type SchemaIssueCode =
  | 'no-tables'
  | 'empty-name'
  | 'duplicate-table'
  | 'table-exists'
  | 'no-columns'
  | 'duplicate-column'
  | 'duplicate-index'
  | 'missing-type'
  | 'name-too-long'
  | 'unknown-column'
  | 'unknown-table'
  | 'references-existing-table'
  | 'column-count-mismatch'
  | 'reference-not-unique'
  | 'set-null-on-not-null'
  | 'on-delete-unsupported'
  | 'unknown-sequence'
  | 'type-mismatch'
  | 'no-primary-key'
  | 'cycle-unsupported';

export interface SchemaIssue {
  severity: 'error' | 'warning';
  code: SchemaIssueCode;
  table: string;
  /** 出事的那一列 / 那组列，逗号分隔；与表整体相关时为空 */
  column: string;
  /** 补充：撞上的名字、另一端的类型、上限几个字节…… */
  detail: string;
}

/**
 * 标识符的字节上限。PostgreSQL 超过 63 字节**静默截断**——两个长名字截完撞在一起才报错，
 * 或者根本不报、建出来的名字和设计里的对不上，所以必须在这一侧拦。
 * 没有列出的方言没有实际会碰到的上限。
 */
const IDENTIFIER_MAX_BYTES: Partial<Record<CreatableDialect, number>> = {
  postgresql: 63,
  mysql: 64,
  sqlserver: 128,
  oracle: 128
};

/** 表名、列名比较时不分大小写：设计里同时有 `Users` 和 `users` 不会是有意的 */
const fold = (name: string): string => name.trim().toLowerCase();

/**
 * 类型比较抹掉大小写和空白，再认几个**确定等价**的写法。
 *
 * PostgreSQL 的 `serial` 家族是「整数 + 序列默认值」的简写，外键那一端就该写成对应的整数——
 * A0 实验里 30 份设计有 12 份这样写，全被报成两端不一致，那是校验在说错话。
 * 其余不一致（`int` 对 `bigint`）MySQL 直接拒绝（3780）、PostgreSQL 放行，报警告让人看
 */
const SERIAL_BASE: Record<string, string> = { smallserial: 'smallint', serial: 'integer', bigserial: 'bigint' };
/** 自增是列的属性、不是另一种类型：`bigint GENERATED ALWAYS AS IDENTITY` 的外键那一端就是 `bigint` */
const AUTO_INCREMENT_CLAUSE =
  /\s+(?:generated\s+(?:always|by\s+default)\s+as\s+identity(?:\s*\([^)]*\))?|auto_increment|identity\s*\(\s*\d+\s*,\s*\d+\s*\))/gi;
const normalizeType = (dataType: string, dialect: CreatableDialect): string => {
  const compact = dataType.replace(AUTO_INCREMENT_CLAUSE, '').toLowerCase().replace(/\s+/g, '');
  const base = compact === 'int' ? 'integer' : compact;
  return dialect === 'postgresql' ? SERIAL_BASE[base] ?? base : base;
};

/**
 * 默认值里用到的序列。设计里没有「序列」这种对象，所以引用任何一个都建不出来——
 * A0 实验里 PostgreSQL 执行失败的 7 份设计全是 `DEFAULT nextval('users_id_seq')` 而序列不存在
 */
const NEXTVAL = /\bnextval\s*\(/i;

/**
 * 结构性校验：名字、引用、外键两端。**不校验类型是否属于该方言**——手写一份类型清单一定
 * 会漏（扩展类型、域、别名），误拒一个合法设计比放过一个错类型更糟；错类型在执行时由数据库
 * 原话报出来。
 *
 * 校验不修：发现的问题原样列出，由人或 AI 去改。
 */
export function validateSchemaDraft(
  draft: SchemaDraft,
  dialect: CreatableDialect,
  existingTables: readonly string[] = []
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const report = (
    severity: SchemaIssue['severity'],
    code: SchemaIssueCode,
    table: string,
    column = '',
    detail = ''
  ) => issues.push({ severity, code, table, column, detail });

  if (draft.tables.length === 0) {
    report('error', 'no-tables', '');
    return issues;
  }

  const maxBytes = IDENTIFIER_MAX_BYTES[dialect];
  const checkLength = (table: string, column: string, name: string) => {
    if (maxBytes !== undefined && new TextEncoder().encode(name).length > maxBytes) {
      report('error', 'name-too-long', table, column, String(maxBytes));
    }
  };

  const existing = new Set(existingTables.map(fold));
  const tablesByName = new Map<string, TableDraft>();
  for (const table of draft.tables) {
    const key = fold(table.name);
    if (key === '') {
      report('error', 'empty-name', table.name);
      continue;
    }
    if (tablesByName.has(key)) {
      report('error', 'duplicate-table', table.name);
      continue;
    }
    tablesByName.set(key, table);
    if (existing.has(key)) {
      report('error', 'table-exists', table.name);
    }
    checkLength(table.name, '', table.name);
  }

  // 索引名由表名与列名拼成（`indexName`），(a_b) 与 (a, b)、表 a_b 的 (c) 与表 a 的 (b_c) 拼出同一个名字；
  // 撞上时第二条 CREATE INDEX 失败，前面的表已经建好了。MySQL、SQL Server 的索引名只在表内唯一
  const indexNames = new Set<string>();
  const indexScope = (table: string) => (dialect === 'mysql' || dialect === 'sqlserver' ? `${fold(table)}\0` : '');

  for (const table of tablesByName.values()) {
    const columns = new Map<string, ColumnSpec>();
    if (table.columns.length === 0) {
      report('error', 'no-columns', table.name);
    }
    for (const column of table.columns) {
      const key = fold(column.name);
      if (key === '') {
        report('error', 'empty-name', table.name, column.name);
        continue;
      }
      if (columns.has(key)) {
        report('error', 'duplicate-column', table.name, column.name);
        continue;
      }
      columns.set(key, column);
      checkLength(table.name, column.name, column.name);
      if (column.dataType.trim() === '') {
        report('error', 'missing-type', table.name, column.name);
      }
      if (column.defaultValue !== null && NEXTVAL.test(column.defaultValue)) {
        report('error', 'unknown-sequence', table.name, column.name, column.defaultValue);
      }
    }

    const checkColumns = (names: readonly string[]) => {
      const missing = names.filter((name) => !columns.has(fold(name)));
      for (const name of missing) {
        report('error', 'unknown-column', table.name, name);
      }
      return missing.length === 0;
    };

    if (table.primaryKey.length === 0) {
      // 这个程序里没有主键的表不可编辑（定位不到一行），但日志表可能就是不要主键
      report('warning', 'no-primary-key', table.name);
    } else {
      checkColumns(table.primaryKey);
    }
    table.unique.forEach(checkColumns);
    for (const index of table.indexes) {
      checkColumns(index.columns);
      const name = indexName(table.name, index.columns);
      checkLength(table.name, index.columns.join(', '), name);
      const scoped = indexScope(table.name) + fold(name);
      if (indexNames.has(scoped)) {
        report('error', 'duplicate-index', table.name, index.columns.join(', '), name);
      }
      indexNames.add(scoped);
    }

    for (const key of table.foreignKeys) {
      const label = key.columns.join(', ');
      const ownColumnsExist = checkColumns(key.columns);
      const target = tablesByName.get(fold(key.referencedTable));
      if (!target) {
        // 指向库里已有的表是合理的设计（新的文章表引用已有的用户表）。那张表的列、主键
        // 这里不知道，列存不存在、是不是唯一由数据库在建表时查——报警告让人知道这一条没核对过
        if (existing.has(fold(key.referencedTable))) {
          report('warning', 'references-existing-table', table.name, label, key.referencedTable);
        } else {
          report('error', 'unknown-table', table.name, label, key.referencedTable);
        }
        continue;
      }
      if (key.columns.length !== key.referencedColumns.length || key.columns.length === 0) {
        report('error', 'column-count-mismatch', table.name, label, key.referencedColumns.join(', '));
        continue;
      }
      const targetColumns = new Map(target.columns.map((column) => [fold(column.name), column]));
      const missingTarget = key.referencedColumns.filter((name) => !targetColumns.has(fold(name)));
      if (missingTarget.length > 0) {
        for (const name of missingTarget) {
          report('error', 'unknown-column', target.name, name);
        }
        continue;
      }
      // 五家都要求被引用的列组是主键或唯一约束（MySQL 8.4 起默认也要求）
      if (!isUniqueKey(target, key.referencedColumns)) {
        report('error', 'reference-not-unique', table.name, label, `${target.name} (${key.referencedColumns.join(', ')})`);
      }
      // DuckDB 1.x 的外键只认默认行为：「FOREIGN KEY constraints cannot use CASCADE, SET NULL or SET DEFAULT」
      if (dialect === 'duckdb' && key.onDelete !== null) {
        report('error', 'on-delete-unsupported', table.name, label, key.onDelete);
      }
      if (!ownColumnsExist) {
        continue;
      }
      key.columns.forEach((name, position) => {
        const own = columns.get(fold(name));
        const referenced = targetColumns.get(fold(key.referencedColumns[position] ?? ''));
        if (!own || !referenced) {
          return;
        }
        if (normalizeType(own.dataType, dialect) !== normalizeType(referenced.dataType, dialect)) {
          // MySQL 对 int → bigint 这类不一致直接拒绝（3780），PostgreSQL 放行。报警告
          report('warning', 'type-mismatch', table.name, own.name, `${referenced.dataType}`);
        }
        const inPrimaryKey = table.primaryKey.some((keyColumn) => fold(keyColumn) === fold(name));
        if (key.onDelete === 'set null' && (!own.nullable || inPrimaryKey)) {
          report('error', 'set-null-on-not-null', table.name, own.name);
        }
      });
    }
  }

  // DuckDB 不能事后加外键（ALTER TABLE … ADD FOREIGN KEY 未实现），环只能拒绝
  if (dialect === 'duckdb') {
    for (const table of orderForCreation(draft).deferred) {
      report('error', 'cycle-unsupported', table.table, table.key.columns.join(', '));
    }
  }

  return issues;
}

function isUniqueKey(table: TableDraft, columns: readonly string[]): boolean {
  const wanted = new Set(columns.map(fold));
  const sameSet = (candidate: readonly string[]) =>
    candidate.length === wanted.size && candidate.every((name) => wanted.has(fold(name)));
  return sameSet(table.primaryKey) || table.unique.some(sameSet);
}

interface DeferredForeignKey {
  table: string;
  key: ForeignKeyDraft;
}

/**
 * 建表次序：被引用的表先建。外键指向**已经建好或正在建的**表就写在 CREATE TABLE 里
 * （自引用照样内联，五家都认）；指向后面才建的表——只有环里才会这样——挪到最后用 ALTER 补。
 *
 * 次序在环之外尽量保持设计里的次序：生成的脚本要能和设计对着读。
 */
export function orderForCreation(draft: SchemaDraft): {
  tables: TableDraft[];
  deferred: DeferredForeignKey[];
} {
  const byName = new Map(draft.tables.map((table) => [fold(table.name), table]));
  const created = new Set<string>();
  const ordered: TableDraft[] = [];
  const remaining = [...draft.tables];

  const dependencies = (table: TableDraft) =>
    table.foreignKeys
      .map((key) => fold(key.referencedTable))
      .filter((name) => name !== fold(table.name) && byName.has(name));

  while (remaining.length > 0) {
    const readyIndex = remaining.findIndex((table) =>
      dependencies(table).every((name) => created.has(name)));
    // 没有一张就绪 = 剩下的都在环里或挂在环上：按设计次序先建第一张，它的前向外键挪到后面
    const index = readyIndex === -1 ? 0 : readyIndex;
    const [next] = remaining.splice(index, 1);
    if (!next) {
      break;
    }
    ordered.push(next);
    created.add(fold(next.name));
  }

  const position = new Map(ordered.map((table, index) => [fold(table.name), index]));
  const deferred: DeferredForeignKey[] = [];
  for (const table of ordered) {
    for (const key of table.foreignKeys) {
      const target = position.get(fold(key.referencedTable));
      const own = position.get(fold(table.name));
      if (target !== undefined && own !== undefined && target > own) {
        deferred.push({ table: table.name, key });
      }
    }
  }
  return { tables: ordered, deferred };
}

/**
 * 整份设计的建表脚本：CREATE TABLE（主键、唯一、内联外键）按依赖排好，再是环上的外键，最后是索引。
 *
 * 前提是 `validateSchemaDraft` 没有 error——这里不再重复校验，拿到坏设计会拼出坏语句，
 * 由数据库报错。
 */
export function buildCreateSchema(
  draft: SchemaDraft,
  dialect: CreatableDialect,
  schema: string | null = null
): string[] {
  const order = orderForCreation(declaredSpelling(draft));
  const { tables } = order;
  // SQLite 不能事后加外键，但它建表时不检查被引用的表在不在（到写数据时才查），环照样内联
  const deferred = dialect === 'sqlite' ? [] : order.deferred;
  const deferredKeys = new Set(deferred.map((entry) => entry.key));
  const reference = (table: string) =>
    quoteQualifiedSqlIdentifier(schema ? [schema, table] : [table], dialect);
  const list = (names: readonly string[]) =>
    names.map((name) => quoteSqlIdentifier(name, dialect)).join(', ');

  const statements: string[] = [];
  for (const table of tables) {
    const primaryKey = new Set(table.primaryKey.map(fold));
    // 主键写成约束而不是标在列上：`buildCreateTable` 按列的次序拼主键，而复合主键
    // (tenant_id, id) 的次序决定索引怎么用，列的次序又不该为此挪动
    const constraints = [
      ...(table.primaryKey.length > 0 ? [`PRIMARY KEY (${list(table.primaryKey)})`] : []),
      ...table.unique.map((columns) => `UNIQUE (${list(columns)})`),
      ...table.foreignKeys
        .filter((key) => !deferredKeys.has(key))
        .map((key) => foreignKeyClause(key, reference, list))
    ];
    const plan = buildCreateTable({
      schema,
      table: table.name,
      dialect,
      // 主键列一律 NOT NULL，理由同 buildCreateTable
      columns: table.columns.map((column) => columnDraft(column, primaryKey.has(fold(column.name)))),
      constraints
    });
    statements.push(...plan.statements);
  }

  for (const { table, key } of deferred) {
    statements.push(`ALTER TABLE ${reference(table)} ADD ${foreignKeyClause(key, reference, list)}`);
  }

  for (const table of tables) {
    for (const index of table.indexes) {
      const name = indexName(table.name, index.columns);
      // Oracle 与 SQL Server 的 CREATE INDEX 不收带 schema 的索引名；索引跟着表的 schema 走
      statements.push(`CREATE INDEX ${quoteSqlIdentifier(name, dialect)} ON ${reference(table.name)} (${list(index.columns)})`);
    }
  }
  return statements;
}

function foreignKeyClause(
  key: ForeignKeyDraft,
  reference: (table: string) => string,
  list: (names: readonly string[]) => string
): string {
  const onDelete = key.onDelete === 'cascade'
    ? ' ON DELETE CASCADE'
    : key.onDelete === 'set null'
      ? ' ON DELETE SET NULL'
      : '';
  return `FOREIGN KEY (${list(key.columns)}) REFERENCES ${reference(key.referencedTable)} (${list(key.referencedColumns)})${onDelete}`;
}

/** 索引名要在 schema 内唯一（PostgreSQL、Oracle），所以带上表名 */
function indexName(table: string, columns: readonly string[]): string {
  return ['ix', table, ...columns].join('_');
}

function columnDraft(column: ColumnSpec, inPrimaryKey: boolean) {
  return {
    origin: null,
    name: column.name,
    dataType: column.dataType,
    nullable: column.nullable && !inPrimaryKey,
    defaultValue: column.defaultValue,
    dropped: false,
    primaryKey: false
  };
}

/**
 * 引用处的名字换成声明处的写法。
 *
 * 校验按 `fold` 认名字（`Users` 就是 `users`），而建表语句给名字加引号：PostgreSQL、Oracle 上
 * `"Users"` 与 `"users"` 是两个名字，照模型的原样拼，校验过了的设计建表时报关系或列不存在；
 * 图按名字找表和列，同样连不上。设计本身不改（人看的、校验的仍是模型给的那一份），只在生成时换。
 * 指向库里已有表的引用照原样——那边的写法这里不知道
 */
function declaredSpelling(draft: SchemaDraft): SchemaDraft {
  const tablesByName = new Map(draft.tables.map((table) => [fold(table.name), table]));
  const spelling = (columns: readonly ColumnSpec[]) => {
    const declared = new Map(columns.map((column) => [fold(column.name), column.name]));
    return (names: readonly string[]) => names.map((name) => declared.get(fold(name)) ?? name);
  };
  return {
    ...draft,
    tables: draft.tables.map((table) => {
      const own = spelling(table.columns);
      return {
        ...table,
        primaryKey: own(table.primaryKey),
        unique: table.unique.map(own),
        indexes: table.indexes.map((index) => ({ ...index, columns: own(index.columns) })),
        foreignKeys: table.foreignKeys.map((key) => {
          const target = tablesByName.get(fold(key.referencedTable));
          return {
            ...key,
            columns: own(key.columns),
            referencedTable: target?.name ?? key.referencedTable,
            referencedColumns: target ? spelling(target.columns)(key.referencedColumns) : key.referencedColumns
          };
        })
      };
    })
  };
}

/**
 * 画成 ER 图要的形状，喂给现成的 `ErDiagramCanvas`。表不带 schema（建在连接的默认 schema 里）；
 * 复合外键拆成逐列的线，和从目录读出来的一样
 */
export function draftToEr(design: SchemaDraft): { tables: ErTable[]; links: ErLink[] } {
  const draft = declaredSpelling(design);
  const tables = draft.tables.map((table) => {
    const primaryKey = new Set(table.primaryKey.map(fold));
    return {
      schema: null,
      name: table.name,
      columns: table.columns.map((column) => ({
        name: column.name,
        dataType: column.dataType,
        isPrimaryKey: primaryKey.has(fold(column.name)),
        isNullable: column.nullable
      }))
    };
  });
  const links = draft.tables.flatMap((table) =>
    table.foreignKeys.flatMap((key, index) =>
      key.columns.map((column, position) => ({
        constraintName: `${table.name}#${index}`,
        from: { table: table.name, column },
        to: { table: key.referencedTable, column: key.referencedColumns[position] ?? '' }
      }))));
  return { tables, links };
}
