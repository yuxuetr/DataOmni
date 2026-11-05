import type { ColumnInfo } from '../contracts';
import type { SqlDialect } from '../contracts/queryExecution';
import { columnTypeToken } from './columnTypes';
import { tableKey, type ErLink } from './erLayout';
import type { IndexInfo } from './schemaObjects';
import { DEFAULT_EXPRESSION_COLUMN_PLACEHOLDER } from './schemaObjects';
import type { SchemaDraft } from './schemaDraft';
import { columnDefaultSql } from './tableDdl';

/**
 * 代码生成（rfcs/codegen.md）的输入：一份与来源无关的表结构模型，外加四个生成器共用的
 * 类型解析、名字转换与关系规划。生成器只管把它写成各自的文本。
 */

/** 至少有一个目标支持的方言。DuckDB、ClickHouse 没有一个目标认，入口不出现 */
export type CodegenDialect = Extract<SqlDialect, 'postgresql' | 'mysql' | 'sqlite' | 'sqlserver' | 'oracle'>;

export function isCodegenDialect(dialect: SqlDialect): dialect is CodegenDialect {
  return dialect !== 'duckdb' && dialect !== 'clickhouse';
}

export interface CodegenColumn {
  name: string;
  /** 目录里的类型原文 */
  dataType: string;
  nullable: boolean;
  /** 自增、identity、`serial`、SQLite 的 rowid 别名：新增时不用给值 */
  autoIncrement: boolean;
  /** 计算列：值由数据库算，不能写 */
  computed: boolean;
  /** 默认值的 SQL 原文；自增列不带（`nextval(…)` 已由 `autoIncrement` 说明） */
  defaultValue: string | null;
}

export interface CodegenForeignKey {
  name: string;
  columns: string[];
  /** 被引用表的 `tableKey`；不在这份模型里（被筛掉了）时生成器只留外键列、不写关系 */
  referencedTable: string;
  referencedColumns: string[];
  /**
   * 删除被引用行时怎么办。只有 AI 设计的结果里有；读已有的库时不读（ER 查询没有这一项），是 null，
   * 生成器照 `prisma db pull` 读到 NO ACTION 时的写法处理
   */
  onDelete?: 'cascade' | 'set null' | null;
}

export interface CodegenTable {
  /** `tableKey`：`schema.name`，没有 schema 时就是名字 */
  key: string;
  schema: string | null;
  name: string;
  columns: CodegenColumn[];
  /** 按键内次序 */
  primaryKey: string[];
  /** 唯一约束（唯一、非部分、已验证、全是列的索引），不含主键 */
  unique: string[][];
  foreignKeys: CodegenForeignKey[];
}

export interface CodegenSchema {
  dialect: CodegenDialect;
  tables: CodegenTable[];
}

/** 已有库的一张表：单表结构查询读到的列与索引 */
export interface CatalogTable {
  schema: string | null;
  name: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
}

/** PostgreSQL 的 `serial` 与 CockroachDB 的 `SERIAL`（`unique_rowid()`）不是 identity，只在默认值里看得出 */
const SEQUENCE_DEFAULT = /^\s*(?:nextval\s*\(|unique_rowid\s*\(\s*\))/i;

export function catalogToCodegenSchema(
  dialect: CodegenDialect,
  tables: readonly CatalogTable[],
  links: readonly ErLink[]
): CodegenSchema {
  return {
    dialect,
    tables: tables.map((table) => {
      const key = tableKey(table);
      const columnNames = new Set(table.columns.map((column) => column.name));
      const columns = table.columns.map((column): CodegenColumn => {
        const defaultValue = columnDefaultSql(column, dialect);
        const autoIncrement = column.identity_generation != null
          || (defaultValue != null && SEQUENCE_DEFAULT.test(defaultValue));
        return {
          name: column.name,
          dataType: column.data_type,
          nullable: column.is_nullable,
          autoIncrement,
          computed: Boolean(column.is_generated) && !autoIncrement,
          defaultValue: autoIncrement ? null : defaultValue
        };
      });
      const primaryKey = table.columns
        .filter((column) => column.is_primary_key)
        .sort((left, right) => (left.primary_key_ordinal ?? 0) - (right.primary_key_ordinal ?? 0))
        .map((column) => column.name);
      const unique = table.indexes
        .filter((index) => index.isUnique && !index.isPrimary && !index.isPartial && index.isValid)
        .map((index) => index.columns)
        .filter((indexColumns) => indexColumns.every(
          (name) => name !== DEFAULT_EXPRESSION_COLUMN_PLACEHOLDER && columnNames.has(name)
        ))
        .filter((indexColumns) => !sameColumns(indexColumns, primaryKey));
      return {
        key,
        schema: table.schema,
        name: table.name,
        columns,
        primaryKey,
        unique: dedupeColumnSets(unique),
        foreignKeys: groupLinks(links.filter((link) => link.from.table === key))
      };
    })
  };
}

/** ER 图的连线是一列一条；按约束名并回一条外键，列的次序就是查询给的键内次序 */
function groupLinks(links: readonly ErLink[]): CodegenForeignKey[] {
  const byName = new Map<string, CodegenForeignKey>();
  for (const link of links) {
    const group = byName.get(link.constraintName) ?? {
      name: link.constraintName,
      columns: [],
      referencedTable: link.to.table,
      referencedColumns: []
    };
    group.columns.push(link.from.column);
    group.referencedColumns.push(link.to.column);
    byName.set(link.constraintName, group);
  }
  return [...byName.values()];
}

/**
 * AI 设计的结果转成同一份模型。自增在设计里写在类型上（`aiDesign.ts` 的提示里规定了各家写法），
 * 这里照写法认；SQLite 是单列 `INTEGER` 主键（rowid 别名）
 */
export function draftToCodegenSchema(dialect: CodegenDialect, draft: SchemaDraft): CodegenSchema {
  return {
    dialect,
    tables: draft.tables.map((table) => ({
      key: table.name,
      schema: null,
      name: table.name,
      columns: table.columns.map((column) => {
        const autoIncrement = isDraftAutoIncrement(dialect, column.dataType, table.primaryKey, column.name)
          || (column.defaultValue != null && SEQUENCE_DEFAULT.test(column.defaultValue));
        return {
          name: column.name,
          dataType: stripAutoIncrement(column.dataType),
          nullable: column.nullable,
          autoIncrement,
          computed: false,
          defaultValue: autoIncrement ? null : column.defaultValue
        };
      }),
      primaryKey: [...table.primaryKey],
      unique: dedupeColumnSets(table.unique.filter((columns) => !sameColumns(columns, table.primaryKey))),
      foreignKeys: table.foreignKeys.map((foreignKey, index) => ({
        name: `fk_${table.name}_${index + 1}`,
        columns: [...foreignKey.columns],
        referencedTable: foreignKey.referencedTable,
        referencedColumns: [...foreignKey.referencedColumns],
        onDelete: foreignKey.onDelete
      }))
    }))
  };
}

const AUTO_INCREMENT_CLAUSE = /\s+(?:auto_increment|generated\s+(?:always|by\s+default)\s+as\s+identity(?:\s*\([^)]*\))?|identity\s*\(\s*\d+\s*,\s*\d+\s*\)|identity)\s*$/i;

function isDraftAutoIncrement(
  dialect: CodegenDialect,
  dataType: string,
  primaryKey: readonly string[],
  column: string
): boolean {
  if (AUTO_INCREMENT_CLAUSE.test(dataType) || /^\s*(?:small|big)?serial\s*$/i.test(dataType)) {
    return true;
  }
  return dialect === 'sqlite' && primaryKey.length === 1 && primaryKey[0] === column
    && /^\s*integer\s*$/i.test(dataType);
}

/** `bigint AUTO_INCREMENT` → `bigint`：后面的类型解析只看类型本身 */
function stripAutoIncrement(dataType: string): string {
  const stripped = dataType.replace(AUTO_INCREMENT_CLAUSE, '').trim();
  const serial = /^\s*(small|big)?serial\s*$/i.exec(stripped);
  if (serial) {
    return { small: 'smallint', big: 'bigint' }[serial[1]?.toLowerCase() as 'small' | 'big'] ?? 'integer';
  }
  return stripped;
}

function sameColumns(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name) => right.includes(name));
}

function dedupeColumnSets(sets: readonly string[][]): string[][] {
  return sets.filter((set, index) => sets.findIndex((other) => sameColumns(other, set)) === index);
}

// ---------------------------------------------------------------------------
// 类型：方言原文 → 逻辑类型。各目标从逻辑类型再映射到自己的写法，方言与目标不交叉各写一份
// ---------------------------------------------------------------------------

export type LogicalType =
  | { kind: 'int'; bytes: 1 | 2 | 4 | 8; unsigned: boolean }
  | { kind: 'decimal'; precision: number | null; scale: number | null }
  | { kind: 'float'; bytes: 4 | 8 }
  | { kind: 'bool' }
  /** `length` 为 null 是没写长度；`max` 是 SQL Server 的 `(max)` */
  | { kind: 'string'; length: number | 'max' | null; fixed: boolean; national: boolean }
  | { kind: 'text' }
  | { kind: 'uuid' }
  | { kind: 'json'; binary: boolean }
  | { kind: 'bytes' }
  | { kind: 'date' }
  | { kind: 'time' }
  | { kind: 'timestamp'; withTimeZone: boolean }
  /** 认不出的不猜：生成器各有写法，并在结果开头列出来 */
  | { kind: 'unknown' };

const MULTI_WORD_TYPES: [RegExp, string][] = [
  [/^character varying\b/, 'varchar'],
  [/^national character varying\b/, 'nvarchar'],
  [/^national char(?:acter)?\b/, 'nchar'],
  [/^double precision\b/, 'double'],
  [/^timestamp(?:\(\d+\))? with time zone\b/, 'timestamptz'],
  [/^timestamp(?:\(\d+\))? with local time zone\b/, 'timestamptz'],
  [/^timestamp(?:\(\d+\))? without time zone\b/, 'timestamp'],
  [/^time(?:\(\d+\))? with time zone\b/, 'timetz'],
  [/^time(?:\(\d+\))? without time zone\b/, 'time'],
  [/^bit varying\b/, 'varbit']
];

function typeParameters(lower: string): string[] {
  const match = /\(([^)]*)\)/.exec(lower);
  return match ? match[1].split(',').map((part) => part.trim()) : [];
}

function intBytes(token: string, dialect: CodegenDialect): 1 | 2 | 4 | 8 | null {
  switch (token) {
    case 'tinyint':
      return 1;
    case 'smallint':
    case 'int2':
    case 'smallserial':
    case 'serial2':
      return 2;
    case 'mediumint':
    case 'int4':
    case 'serial':
    case 'serial4':
      return 4;
    case 'int':
    case 'integer':
      // SQLite 的 INTEGER 是 64 位；Oracle 的 INTEGER 是 NUMBER(38)，取最宽的整数
      return dialect === 'sqlite' || dialect === 'oracle' ? 8 : 4;
    case 'bigint':
    case 'int8':
    case 'bigserial':
    case 'serial8':
      return 8;
    default:
      return null;
  }
}

export function logicalType(dataType: string, dialect: CodegenDialect): LogicalType {
  let lower = dataType.trim().toLowerCase();
  if (dialect === 'postgresql' && /\[\]$/.test(lower)) {
    return { kind: 'unknown' };
  }
  for (const [pattern, replacement] of MULTI_WORD_TYPES) {
    if (pattern.test(lower)) {
      lower = lower.replace(pattern, replacement);
      break;
    }
  }
  const token = columnTypeToken(lower);
  const parameters = typeParameters(lower);
  const unsigned = /\bunsigned\b/.test(lower);

  if (dialect === 'mysql' && token === 'tinyint' && parameters[0] === '1') {
    return { kind: 'bool' };
  }
  if (dialect === 'mysql' && token === 'bit' && (parameters[0] ?? '1') === '1') {
    return { kind: 'bool' };
  }
  const bytes = intBytes(token, dialect);
  if (bytes != null) {
    // SQL Server 的 tinyint 是 0–255
    const isUnsigned = unsigned || (dialect === 'sqlserver' && token === 'tinyint');
    return { kind: 'int', bytes, unsigned: isUnsigned };
  }

  switch (token) {
    case 'number': {
      // Oracle：NUMBER(p) 是整数，按位数取最窄的整数；带小数位或不写精度的是 decimal
      const precision = parameters[0] != null ? Number(parameters[0]) : null;
      const scale = parameters[1] != null ? Number(parameters[1]) : 0;
      if (precision != null && Number.isFinite(precision) && scale === 0 && precision <= 18) {
        return { kind: 'int', bytes: precision <= 4 ? 2 : precision <= 9 ? 4 : 8, unsigned: false };
      }
      return { kind: 'decimal', precision: Number.isFinite(precision) ? precision : null, scale: precision == null ? null : scale };
    }
    case 'decimal':
    case 'dec':
    case 'numeric':
    case 'fixed': {
      const precision = parameters[0] != null ? Number(parameters[0]) : null;
      const scale = parameters[1] != null ? Number(parameters[1]) : precision != null ? 0 : null;
      return {
        kind: 'decimal',
        precision: precision != null && Number.isFinite(precision) ? precision : null,
        scale: scale != null && Number.isFinite(scale) ? scale : null
      };
    }
    case 'money':
    case 'smallmoney':
      return { kind: 'decimal', precision: null, scale: null };
    case 'real':
    case 'float4':
    case 'binary_float':
      return { kind: 'float', bytes: dialect === 'sqlite' ? 8 : 4 };
    case 'float':
      // MySQL 的 FLOAT 是 4 字节；PostgreSQL、SQL Server 不写精度的 float 是 8 字节
      return { kind: 'float', bytes: dialect === 'mysql' ? 4 : 8 };
    case 'double':
    case 'float8':
    case 'binary_double':
      return { kind: 'float', bytes: 8 };
    case 'bool':
    case 'boolean':
      return { kind: 'bool' };
    case 'bit':
      return dialect === 'sqlserver' ? { kind: 'bool' } : { kind: 'unknown' };
    case 'varchar':
    case 'varchar2':
    case 'nvarchar':
    case 'nvarchar2':
    case 'char':
    case 'character':
    case 'nchar':
    case 'bpchar': {
      const raw = parameters[0];
      const length = raw === 'max' ? 'max' : raw != null && /^\d+/.test(raw) ? parseInt(raw, 10) : null;
      return {
        kind: 'string',
        length,
        fixed: token === 'char' || token === 'character' || token === 'nchar' || token === 'bpchar',
        national: token.startsWith('n')
      };
    }
    case 'text':
    case 'tinytext':
    case 'mediumtext':
    case 'longtext':
    case 'ntext':
    case 'clob':
    case 'nclob':
    case 'citext':
    case 'name':
    case 'enum':
    case 'set':
    case 'xml':
      return { kind: 'text' };
    case 'uuid':
    case 'uniqueidentifier':
      return { kind: 'uuid' };
    case 'json':
      return { kind: 'json', binary: false };
    case 'jsonb':
      return { kind: 'json', binary: true };
    case 'bytea':
    case 'blob':
    case 'tinyblob':
    case 'mediumblob':
    case 'longblob':
    case 'binary':
    case 'varbinary':
    case 'raw':
    case 'image':
      return { kind: 'bytes' };
    case 'date':
      // Oracle 的 DATE 带时分秒
      return dialect === 'oracle' ? { kind: 'timestamp', withTimeZone: false } : { kind: 'date' };
    case 'time':
    case 'timetz':
      return { kind: 'time' };
    case 'datetime':
    case 'datetime2':
    case 'smalldatetime':
      return { kind: 'timestamp', withTimeZone: false };
    case 'timestamp':
      // MySQL 的 TIMESTAMP 存的是 UTC 时刻；SQL Server 的 timestamp 是 rowversion
      if (dialect === 'sqlserver') return { kind: 'bytes' };
      return { kind: 'timestamp', withTimeZone: dialect === 'mysql' };
    case 'timestamptz':
    case 'datetimeoffset':
      return { kind: 'timestamp', withTimeZone: true };
    case 'rowversion':
      return { kind: 'bytes' };
    default:
      return { kind: 'unknown' };
  }
}

// ---------------------------------------------------------------------------
// 名字
// ---------------------------------------------------------------------------

/** `user_orders`、`UserOrders`、`user orders`、`userOrders` 都拆成 user / orders */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** 类型名。拆不出字母数字（全是中文之类）时给 `fallback` */
export function pascalCase(name: string, fallback = 'Table'): string {
  const words = nameWords(name);
  const joined = words.map(capitalize).join('');
  if (!joined) return fallback;
  return /^\d/.test(joined) ? `T${joined}` : joined;
}

export function camelCase(name: string, fallback = 'column'): string {
  const words = nameWords(name);
  const joined = words.map((word, index) => (index === 0 ? word : capitalize(word))).join('');
  if (!joined) return fallback;
  return /^\d/.test(joined) ? `c${capitalize(joined)}` : joined;
}

export function snakeCase(name: string, fallback = 'column'): string {
  const joined = nameWords(name).join('_');
  if (!joined) return fallback;
  return /^\d/.test(joined) ? `c_${joined}` : joined;
}

/**
 * 一个作用域（一个类、一个结构体、一份 schema 里的类型名）里的名字分配：撞上保留字或已有的名字就加序号。
 * 保留字的处理交给 `escape`：Rust 加下划线，其余目标没有这种限制时原样
 */
export class NameScope {
  private readonly taken = new Set<string>();

  constructor(
    private readonly reserved: ReadonlySet<string> = new Set(),
    private readonly escape: (name: string) => string = (name) => `${name}_`
  ) {}

  claim(candidate: string): string {
    const base = this.reserved.has(candidate) ? this.escape(candidate) : candidate;
    let name = base;
    for (let suffix = 2; this.taken.has(name.toLowerCase()); suffix += 1) {
      name = `${base}${suffix}`;
    }
    this.taken.add(name.toLowerCase());
    return name;
  }

  has(name: string): boolean {
    return this.taken.has(name.toLowerCase());
  }
}

// ---------------------------------------------------------------------------
// 关系
// ---------------------------------------------------------------------------

export interface RelationPlan {
  foreignKey: CodegenForeignKey;
  source: CodegenTable;
  target: CodegenTable;
  /** 外键列正好是主键或一条唯一约束：对面那一侧是单个而不是集合 */
  oneToOne: boolean;
  /** 外键一侧的关系名（还没套大小写）：单列外键是列名去掉 `_id`，其余是被引用表名 */
  forwardBase: string;
  /** 被引用一侧的关系名：引用它的表名；同一对表之间不止一条（含自引用）时加上 `_by_<forwardBase>` */
  backBase: string;
  /** 同一对表之间不止这一条关系（含自引用）：Prisma 要给关系起名，SeaORM 不能写 `Related` */
  ambiguous: boolean;
}

export interface RelationPlanning {
  relations: RelationPlan[];
  /** 被引用表不在这份模型里的外键（ER 图筛掉了它），只留外键列 */
  dangling: { table: CodegenTable; foreignKey: CodegenForeignKey }[];
}

export function planRelations(schema: CodegenSchema): RelationPlanning {
  const byKey = new Map(schema.tables.map((table) => [table.key, table]));
  const relations: RelationPlan[] = [];
  const dangling: RelationPlanning['dangling'] = [];
  for (const source of schema.tables) {
    for (const foreignKey of source.foreignKeys) {
      const target = byKey.get(foreignKey.referencedTable);
      if (!target) {
        dangling.push({ table: source, foreignKey });
        continue;
      }
      const oneToOne = sameColumns(foreignKey.columns, source.primaryKey)
        || source.unique.some((columns) => sameColumns(columns, foreignKey.columns));
      const single = foreignKey.columns.length === 1
        ? foreignKey.columns[0].replace(/(?:_id|_ID|(?<=[a-z])Id)$/, '')
        : '';
      const forwardBase = single && single !== foreignKey.columns[0] ? single : target.name;
      relations.push({ foreignKey, source, target, oneToOne, forwardBase, backBase: source.name, ambiguous: false });
    }
  }
  for (const relation of relations) {
    const siblings = relations.filter(
      (other) => other.source === relation.source && other.target === relation.target
    );
    relation.ambiguous = siblings.length > 1 || relation.source === relation.target;
    if (relation.ambiguous) {
      relation.backBase = `${relation.source.name}_by_${relation.forwardBase}`;
    }
  }
  return { relations, dangling };
}

// ---------------------------------------------------------------------------
// 生成结果
// ---------------------------------------------------------------------------

export interface GeneratedFile {
  /** 相对路径：单文件目标就是文件名 */
  path: string;
  contents: string;
}

export type CodegenNote =
  | { kind: 'unknown-type'; table: string; column: string; dataType: string }
  | { kind: 'skipped-table'; table: string; reason: 'no-primary-key' }
  | { kind: 'ignored-table'; table: string; reason: 'no-unique-identifier' }
  | { kind: 'dangling-foreign-key'; table: string; constraint: string; referencedTable: string }
  /** 关系没生成：被引用的列不是主键或唯一约束，或者一端的表生成不了 */
  | { kind: 'skipped-relation'; table: string; constraint: string; reason: 'target-not-unique' | 'ignored-table' | 'skipped-table' };

export interface GeneratedCode {
  files: GeneratedFile[];
  notes: CodegenNote[];
}

/** 生成的文件开头那段说明（英文：生成的是给开发者看的代码） */
export function noteLines(notes: readonly CodegenNote[]): string[] {
  return notes.map((note) => {
    switch (note.kind) {
      case 'unknown-type':
        return `${note.table}.${note.column}: type "${note.dataType}" has no mapping; check this field by hand`;
      case 'skipped-table':
        return `${note.table}: skipped, the table has no primary key`;
      case 'ignored-table':
        return `${note.table}: marked @@ignore, the table has no primary key or unique constraint`;
      case 'dangling-foreign-key':
        return `${note.table}: relation ${note.constraint} not generated, ${note.referencedTable} is not in the selection`;
      case 'skipped-relation':
        return `${note.table}: relation ${note.constraint} not generated, ${{
          'target-not-unique': 'it references columns that are not a primary key or unique constraint',
          'ignored-table': 'one of its tables is marked @@ignore',
          'skipped-table': 'one of its tables is skipped'
        }[note.reason]}`;
    }
  });
}
