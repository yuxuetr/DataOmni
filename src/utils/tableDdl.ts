import type { ColumnInfo } from '../contracts';
import type { TranslationKey } from '../i18n/translate';
import { columnTypeToken, isNumericColumnType } from './columnTypes';
import {
  quoteQualifiedSqlIdentifier,
  quoteSqlIdentifier,
  type SqlIdentifierDialect
} from './sqlIdentifiers';
import { quoteSqlStringLiteral } from './sqlLiterals';

/**
 * 由「原结构 + 草稿」拼出 ALTER TABLE。
 *
 * 三种方言在这件事上差得比读目录时还远，而差别全在**能不能只改被点名的那一项**：
 *
 * - PostgreSQL 每种改动都有自己的子命令（`ALTER COLUMN x TYPE t`、
 *   `SET NOT NULL`、`SET DEFAULT`），改什么写什么。
 * - MySQL 只有 `MODIFY COLUMN x <整段定义>`。没写进去的排序规则、注释、
 *   AUTO_INCREMENT 会被**静默丢掉**——语句成功，属性没了。
 * - SQLite 的 ALTER TABLE 只有四种形态：加列、删列、改列名、改表名。
 *   改类型要按官方的十二步重建整张表，而重建脚本必须覆盖索引、触发器、
 *   视图与外键；少一项就是一张看起来一样、其实不等价的表。
 *
 * 所以这里不追求三家一致：做不到的操作**逐条说明理由**，由界面显示出来，
 * 而不是拼一条跑不通或者跑得通但不等价的语句。
 */

/** 结构编辑器里一列的当前状态 */
export interface ColumnDraft {
  /** 目录里的原列；null 表示这是新加的 */
  origin: ColumnInfo | null;
  name: string;
  dataType: string;
  nullable: boolean;
  /** 默认值的 **SQL 原文**（`0`、`'active'`、`CURRENT_TIMESTAMP`）；null = 没有默认值 */
  defaultValue: string | null;
  /** 标记删除。原列才有意义，新加的列直接从草稿里去掉 */
  dropped: boolean;
  /**
   * 进不进主键。
   *
   * 只有**新建表**用得上：`buildTableDdl` 不看这一项——改主键要先验证现有
   * 数据的唯一性，还要考虑外键引用，不是改一格就能算出来的事，当前版本不做。
   * 改结构时这一格是只读的。
   */
  primaryKey: boolean;
}

export interface TableDdlRequest {
  schema: string | null;
  table: string;
  /** 改过的表名；与 `table` 相同表示不改名 */
  newTableName: string;
  dialect: SqlIdentifierDialect;
  columns: readonly ColumnDraft[];
  /**
   * 改表名单独成句，放在最后。TiDB 要这样：它不收一条 ALTER 里同时改列又改表名
   * （8200）；OceanBase 也要：要重写表的改列（换类型、缩短长度）与 `RENAME TO` 同句
   * 报 1235（4.4.2 上试过，加列、删列、改列名不受影响——但预览时分不清是哪种，一律拆）。
   * 代价是不再原子——第二条失败时列已经改了，预览里照实说。
   * 由 [`renamesApart`] 按服务端版本决定，别处不该手写 true
   */
  renameApart?: boolean;
  /**
   * 每个改类型单独成句，放在改列名之后、其余改动之前。CockroachDB 要这样：要重写数据的改类型
   * （int → text、带排序规则的字符列）与别的子命令同句报「cannot be combined with other ALTER TABLE
   * commands」（25.2 上试过；varchar 加长这种不重写的不受影响——但预览时分不清，一律拆）。
   * 那边的 DDL 本来就逐条提交，拆开不损失原子性。由 [`typeChangesApart`] 按服务端版本决定
   */
  typeChangesApart?: boolean;
}

/** `version()` 里带 `CockroachDB` 的 PostgreSQL 连接要把改类型拆出来 */
export function typeChangesApart(dialect: SqlIdentifierDialect, serverVersion: string | null): boolean {
  return dialect === 'postgresql' && (serverVersion ?? '').includes('CockroachDB');
}

/** `VERSION()` 里带 `TiDB` 或 `OceanBase` 的 MySQL 连接要把改表名拆出来 */
export function renamesApart(dialect: SqlIdentifierDialect, serverVersion: string | null): boolean {
  const version = serverVersion ?? '';
  return dialect === 'mysql' && (version.includes('TiDB') || version.includes('OceanBase'));
}

export type DdlAction =
  | 'add-column'
  | 'drop-column'
  | 'rename-column'
  | 'change-type'
  | 'change-nullability'
  | 'change-default';

/** 这一项做不到，以及为什么 */
export interface DdlRefusal {
  column: string;
  action: DdlAction;
  reason: TranslationKey;
}

/** 会连数据一起没掉的操作。确认框逐条列出，不只给一段 SQL */
export interface DdlImpact {
  kind: 'drop-column';
  column: string;
}

export interface DdlPlan {
  statements: string[];
  refusals: DdlRefusal[];
  impacts: DdlImpact[];
}

/**
 * 一行什么都没填。
 *
 * 新建表的表格里留着一行空白是**还没写**，不是「一个没有名字的列」。把它
 * 当成缺项点名，等于对话框一打开就先报一次错；把它拼进语句，等于发一条
 * 语法错误的 SQL。两种都不对，所以它既不点名也不进语句。
 */
function isBlankDraft(column: ColumnDraft): boolean {
  return !column.origin && column.name.trim() === '' && column.dataType.trim() === '';
}

/** 会进语句的列：去掉标记删除的和整行空白的 */
export function usableDraftColumns(columns: readonly ColumnDraft[]): ColumnDraft[] {
  return columns.filter((column) => !column.dropped && !isBlankDraft(column));
}

/**
 * 填了一半的列。缺了名字或类型就整条不生成，而不是拼一条语法错误的语句。
 *
 * 没名字时用类型来指代那一行——总得说得出是哪一行，而「—」说不出。
 */
export function incompleteDraftColumns(columns: readonly ColumnDraft[]): string[] {
  return usableDraftColumns(columns)
    .filter((column) => column.name.trim() === '' || column.dataType.trim() === '')
    .map((column) => column.name.trim() || column.dataType.trim());
}

function tableReference(request: TableDdlRequest, name: string): string {
  return quoteQualifiedSqlIdentifier(
    request.schema ? [request.schema, name] : [name],
    request.dialect
  );
}

/**
 * MySQL 目录里的默认值转成 SQL 原文。
 *
 * `COLUMN_DEFAULT` 不是 SQL：`DEFAULT 'active'` 在目录里是裸的 `active`，
 * 和 `DEFAULT 0` 的 `0` 长得一样。唯一能区分字面量与表达式的是 `EXTRA` 里的
 * `DEFAULT_GENERATED`——已在 MySQL 8.4 上核对：
 * `DEFAULT 'CURRENT_TIMESTAMP'`（字符串）与 `DEFAULT CURRENT_TIMESTAMP`
 * （表达式）的 `COLUMN_DEFAULT` 完全相同，只有 EXTRA 不同。
 *
 * PostgreSQL 与 SQLite 的目录给的本来就是 SQL 原文，原样返回。
 */
export function columnDefaultSql(
  column: ColumnInfo,
  dialect: SqlIdentifierDialect
): string | null {
  const raw = column.default_value;
  if (raw == null) {
    return null;
  }
  if (dialect === 'oracle') {
    // `DATA_DEFAULT` 是 LONG，原样带着结尾的空白（SQL 里 TRIM 不了它）；默认值去不掉，
    // 只能 `DEFAULT NULL`，之后目录里是字面的 `NULL`——那就是没有默认值
    const trimmed = raw.trim();
    return trimmed === '' || trimmed.toUpperCase() === 'NULL' ? null : trimmed;
  }
  if (dialect !== 'mysql') {
    return raw;
  }
  if ((column.column_extra ?? '').includes('DEFAULT_GENERATED')) {
    return raw;
  }
  return isNumericColumnType(column.data_type) ? raw : quoteSqlStringLiteral(raw, 'mysql');
}

/**
 * 一列的定义：名字、类型、可空、默认值。
 *
 * Oracle 要求 DEFAULT 写在约束前面（反过来是 ORA-03076）；另外几家两种次序都收，
 * 保持原来的写法——那几份在真库上跑过的语料照的就是它。
 */
function columnDefinition(
  column: ColumnDraft,
  notNull: boolean,
  dialect: SqlIdentifierDialect
): string {
  const nullability = notNull ? ['NOT NULL'] : [];
  const defaultValue = column.defaultValue != null ? [`DEFAULT ${column.defaultValue}`] : [];
  return [
    quoteSqlIdentifier(column.name, dialect),
    column.dataType.trim(),
    ...(dialect === 'oracle' ? [...defaultValue, ...nullability] : [...nullability, ...defaultValue])
  ].join(' ');
}

/** 一列在 ADD COLUMN 里的定义。四家通用的那一小段（SQL Server 不写 COLUMN 这个词） */
function addColumnDefinition(column: ColumnDraft, dialect: SqlIdentifierDialect): string {
  return columnDefinition(column, !column.nullable, dialect);
}

/**
 * MySQL 重述一整段列定义。
 *
 * 顺序按 MySQL 的 `column_definition` 文法：类型、排序规则、可空、默认值、
 * 自动更新、自增、注释。顺序错了 MySQL 直接拒绝，不会猜。
 */
function mysqlColumnDefinition(column: ColumnDraft): string {
  const origin = column.origin;
  const parts = [quoteSqlIdentifier(column.name, 'mysql'), column.dataType.trim()];
  const collation = origin?.collation;
  if (collation) {
    parts.push(`COLLATE ${collation}`);
  }
  parts.push(column.nullable ? 'NULL' : 'NOT NULL');
  if (column.defaultValue != null) {
    parts.push(`DEFAULT ${column.defaultValue}`);
  }
  const extra = origin?.column_extra ?? '';
  // `on update CURRENT_TIMESTAMP` 与 DEFAULT 是一对，不带上它等于把它删了。
  // 只取到函数名与精度为止：EXTRA 里后面还可能跟着 `INVISIBLE`
  const onUpdate = /on update (\w+(?:\(\d*\))?)/i.exec(extra);
  if (onUpdate) {
    parts.push(`ON UPDATE ${onUpdate[1]}`);
  }
  if (extra.includes('auto_increment')) {
    parts.push('AUTO_INCREMENT');
  }
  // 不写就变回可见列，语句照样成功（MySQL 8.4 上核对过）
  if (/\bINVISIBLE\b/i.test(extra)) {
    parts.push('INVISIBLE');
  }
  if (origin?.comment) {
    parts.push(`COMMENT ${quoteSqlStringLiteral(origin.comment, 'mysql')}`);
  }
  return parts.join(' ');
}

/**
 * `DEFAULT CURRENT_TIMESTAMP` 也带 `DEFAULT_GENERATED`，但它不是表达式：`NOW()`、`LOCALTIMESTAMP` 在目录里
 * 都归一成 `CURRENT_TIMESTAMP[(n)]`，表达式 `(CURRENT_TIMESTAMP)` 存成 `now()`；MariaDB 存 `current_timestamp()`。
 * 原样写回就是同一个默认值（MySQL 8.4、MariaDB 11.8 上核对过）
 */
const CURRENT_TIMESTAMP_DEFAULT = /^current_timestamp(?:\(\d*\))?$/i;

/**
 * MySQL 能不能重述这一列。
 *
 * 表达式默认值在目录里是**归一化后**的形式——`DEFAULT (UPPER('x'))` 存成
 * `upper(_utf8mb4\'x\')`（已在 MySQL 8.4 上核对）。把它原样写回去，得到的
 * 未必是同一个默认值，而语句大概率不报错。计算列同理：`MODIFY` 要求连
 * 表达式一起重述。两种都点名拒绝，理由显示在界面上——用户可以去 SQL
 * 编辑器里自己写一条，那是他知情的选择。
 */
function mysqlRestatementRefusal(column: ColumnDraft): TranslationKey | null {
  const origin = column.origin;
  if (!origin) {
    return null;
  }
  if (origin.is_generated && !(origin.column_extra ?? '').includes('auto_increment')) {
    return 'ddl.refuse.mysqlGeneratedColumn';
  }
  if ((origin.column_extra ?? '').includes('DEFAULT_GENERATED') && !CURRENT_TIMESTAMP_DEFAULT.test(origin.default_value ?? '')) {
    return 'ddl.refuse.mysqlExpressionDefault';
  }
  if (MYSQL_SPATIAL_TYPES.has(origin.data_type.toLowerCase())) {
    return 'ddl.refuse.mysqlSpatialColumn';
  }
  return null;
}

/**
 * 空间列的 SRID 是列定义的一部分，重述时不写就被删掉（语句成功；列上有空间索引时
 * 报 3644）。它在 `COLUMNS.SRS_ID` 里，而这一列 TiDB 与 MariaDB 都没有，TiDB 又不看
 * 版本注释的版本号，共用的列目录查询读不了它——所以拒绝，不重述一条可能丢掉 SRID 的定义。
 */
const MYSQL_SPATIAL_TYPES = new Set([
  'geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring',
  'multipolygon', 'geometrycollection', 'geomcollection'
]);

interface ColumnChange {
  renamed: boolean;
  typeChanged: boolean;
  nullabilityChanged: boolean;
  defaultChanged: boolean;
}

function diffColumn(column: ColumnDraft, dialect: SqlIdentifierDialect): ColumnChange {
  const origin = column.origin;
  if (!origin) {
    return {
      renamed: false,
      typeChanged: false,
      nullabilityChanged: false,
      defaultChanged: false
    };
  }
  return {
    renamed: column.name !== origin.name,
    // 类型比较去掉两端空白但保留大小写：`INT` 与 `int` 在 MySQL 里等价，
    // 但在一个把类型当自由文本的编辑器里，改了大小写就是用户真的改了什么
    typeChanged: column.dataType.trim() !== origin.data_type.trim(),
    nullabilityChanged: column.nullable !== origin.is_nullable,
    defaultChanged: column.defaultValue !== columnDefaultSql(origin, dialect)
  };
}

/**
 * 由草稿生成 ALTER TABLE。
 *
 * **原子性**决定了语句怎么切。PostgreSQL 与 SQLite 的 DDL 在事务里，多条
 * 语句由 `execute_write_batch` 兜住；MySQL 的 DDL 会**隐式提交**，事务对它
 * 没有意义，一批里第二条失败时第一条已经落库。所以 MySQL 一律合成**一条**
 * ALTER TABLE——MySQL 8 的单条 DDL 是原子的——包括改列名与改表名。
 *
 * 另两家不能这么做：`RENAME` 在 PostgreSQL 与 SQLite 里不允许与别的动作并列。
 */
export function buildTableDdl(request: TableDdlRequest): DdlPlan {
  const { dialect } = request;
  if (dialect === 'sqlserver') {
    return buildSqlServerTableDdl(request);
  }
  if (dialect === 'oracle') {
    return buildOracleTableDdl(request);
  }
  const statements: string[] = [];
  const refusals: DdlRefusal[] = [];
  const impacts: DdlImpact[] = [];
  const current = tableReference(request, request.table);
  const combines = dialect === 'mysql';
  let renameTable: string | null = null;

  // 改列名在 PostgreSQL 与 SQLite 里必须单独成句，放在最前面，
  // 后面的动作一律用新名字
  const renames: string[] = [];
  const retypes: string[] = [];
  // 删列排在加列之前：删掉 `code` 再新建一个同名的 `code` 是一次合理的编辑，
  // 而反过来的次序在三家里都会撞上「列已存在」。同一条 ALTER 里的动作
  // PostgreSQL 与 MySQL 都按书写次序执行，所以次序就是语义。
  const drops: string[] = [];
  const alters: string[] = [];
  const adds: string[] = [];
  // DuckDB 加列时不收约束（「Adding columns with constraints not yet supported」）：
  // NOT NULL 的新列先加、再 SET NOT NULL
  const afterAdds: string[] = [];

  for (const column of request.columns) {
    const origin = column.origin;

    if (column.dropped) {
      if (!origin) {
        continue;
      }
      drops.push(`DROP COLUMN ${quoteSqlIdentifier(origin.name, dialect)}`);
      impacts.push({ kind: 'drop-column', column: origin.name });
      continue;
    }

    if (!origin) {
      if (!isBlankDraft(column)) {
        if (dialect === 'duckdb' && !column.nullable) {
          adds.push(`ADD COLUMN ${columnDefinition(column, false, dialect)}`);
          afterAdds.push(`ALTER COLUMN ${quoteSqlIdentifier(column.name, dialect)} SET NOT NULL`);
        } else {
          adds.push(`ADD COLUMN ${addColumnDefinition(column, dialect)}`);
        }
      }
      continue;
    }

    const change = diffColumn(column, dialect);
    const changedActions = changedDdlActions(change);
    if (changedActions.length === 0) {
      continue;
    }

    const quotedOld = quoteSqlIdentifier(origin.name, dialect);
    const quoted = quoteSqlIdentifier(column.name, dialect);

    if (dialect === 'mysql') {
      // 改名之外还改了别的，用 CHANGE 一次做完：`RENAME COLUMN` 之后再
      // `MODIFY` 依赖同一条 ALTER 里前后动作的生效次序，那是没有保证的
      const needsRestatement =
        change.typeChanged || change.nullabilityChanged || (change.renamed && change.defaultChanged);
      if (needsRestatement) {
        const refusal = mysqlRestatementRefusal(column);
        if (refusal) {
          for (const action of changedActions) {
            refusals.push({ column: column.name, action, reason: refusal });
          }
          continue;
        }
        alters.push(
          change.renamed
            ? `CHANGE COLUMN ${quotedOld} ${mysqlColumnDefinition(column)}`
            : `MODIFY COLUMN ${mysqlColumnDefinition(column)}`
        );
        continue;
      }
      if (change.renamed) {
        alters.push(`RENAME COLUMN ${quotedOld} TO ${quoted}`);
        continue;
      }
      alters.push(defaultAction(quoted, column.defaultValue));
      continue;
    }

    if (change.renamed) {
      renames.push(`ALTER TABLE ${current} RENAME COLUMN ${quotedOld} TO ${quoted}`);
    }

    if (dialect === 'sqlite') {
      // SQLite 的 ALTER TABLE 只有加列、删列、改列名、改表名四种形态
      for (const action of changedActions) {
        if (action !== 'rename-column') {
          refusals.push({ column: column.name, action, reason: 'ddl.refuse.sqliteRebuild' });
        }
      }
      continue;
    }

    if (change.typeChanged) {
      const dataType = column.dataType.trim();
      // 排序规则跟着类型走：不写就换成新类型的默认值，语句照样成功。目录给的是服务端
      // 引好的名字；改成数字之类不收排序规则的类型时不写，写了是错误
      const collation = origin.collation && POSTGRES_COLLATABLE_TYPES.has(columnTypeToken(dataType).replace(/\[.*$/, ''))
        ? ` COLLATE ${origin.collation}`
        : '';
      const retype = `ALTER COLUMN ${quoted} TYPE ${dataType}${collation}`;
      if (request.typeChangesApart) {
        retypes.push(`ALTER TABLE ${current} ${retype}`);
      } else {
        alters.push(retype);
      }
    }
    if (change.nullabilityChanged) {
      alters.push(`ALTER COLUMN ${quoted} ${column.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`);
    }
    if (change.defaultChanged) {
      alters.push(defaultAction(quoted, column.defaultValue));
    }
  }

  const ordered = [...drops, ...alters, ...adds, ...afterAdds];
  if (request.newTableName !== request.table) {
    const renameTo = `RENAME TO ${quoteSqlIdentifier(request.newTableName, dialect)}`;
    if (combines && !request.renameApart) {
      ordered.push(renameTo);
    } else {
      renameTable = `ALTER TABLE ${current} ${renameTo}`;
    }
  }

  statements.push(...renames, ...retypes);

  if (ordered.length > 0) {
    if (dialect === 'sqlite' || dialect === 'duckdb') {
      // SQLite 一条 ALTER TABLE 只能做一件事，DuckDB 也是（「Only one ALTER command per
      // statement is supported」）。两家的 DDL 都在事务里，一批照样整体生效或整体不生效
      statements.push(...ordered.map((action) => `ALTER TABLE ${current} ${action}`));
    } else {
      statements.push(`ALTER TABLE ${current} ${ordered.join(', ')}`);
    }
  }

  // 改表名放最后：前面几条都还在用旧名字
  if (renameTable) {
    statements.push(renameTable);
  }

  return { statements, refusals, impacts };
}

const SQL_SERVER_CHARACTER_TYPES = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext']);

/** `character varying` 的首词是 `character`；`citext` 是扩展类型，也收排序规则 */
const POSTGRES_COLLATABLE_TYPES = new Set(['text', 'varchar', 'character', 'char', 'bpchar', 'name', 'citext']);

/**
 * 删掉一列上的默认值约束。
 *
 * SQL Server 的默认值是一个**有名字的约束**，建表时没起名就是系统起的
 * `DF__t__col__7FEAFD3E`——前端不知道这个名字，所以在服务端现查现删。
 * 删列之前也必须先删它：约束还在时 `DROP COLUMN` 报 5074。
 */
function sqlServerDropDefault(table: string, column: string): string {
  const tableLiteral = quoteSqlStringLiteral(table, 'sqlserver');
  // `EXEC (...)` 里只能拼字面量与变量，不能调函数：`QUOTENAME` 得先算进变量
  return [
    `DECLARE @drop nvarchar(max) = (SELECT N'ALTER TABLE ' + ${tableLiteral} + N' DROP CONSTRAINT ' + QUOTENAME(dc.name)`,
    '  FROM sys.default_constraints dc',
    '  JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id',
    `  WHERE dc.parent_object_id = OBJECT_ID(${tableLiteral}) AND c.name = ${quoteSqlStringLiteral(column, 'sqlserver')});`,
    'IF @drop IS NOT NULL EXEC sp_executesql @drop'
  ].join('\n');
}

/**
 * SQL Server 的改结构。和另外三家的差别都在语法之外：
 *
 * - `ALTER COLUMN` 一次重述类型与可空性，**不写 COLLATE 就重置成库的默认
 *   排序规则**（已在 SQL Server 2022 上核对：`Latin1_General_CS_AS` 变成了
 *   `SQL_Latin1_General_CP1_CI_AS`，语句照样成功）。所以字符型一律带上原列的
 *   排序规则，不写 NULL / NOT NULL 也不行——省略时按会话设置定。
 * - 默认值不能 `SET DEFAULT`，只能删约束再加一个；删列前同样要先删它。
 * - 改名走 `sp_rename`，新名字**不带方括号**（带了就成了名字的一部分）。
 * - 自增、计算列与 rowversion 除了改名什么都不能改，点名拒绝。
 * - 同样会被 `ALTER COLUMN` 静默摘掉的还有 SPARSE 与动态数据掩码（只改可空性也一样）：
 *   SPARSE 写在 COLLATE 之后、NULL 之前，掩码另起一句 `ADD MASKED` 加回去。
 *   两样都从列目录的 `column_extra` 来。
 *
 * DDL 在 SQL Server 里是事务性的，一批语句由 `execute_write_batch` 兜住，
 * 所以每个动作单独一句，不用像 MySQL 那样挤进一条。
 */
function buildSqlServerTableDdl(request: TableDdlRequest): DdlPlan {
  const current = tableReference(request, request.table);
  const quote = (name: string) => quoteSqlIdentifier(name, 'sqlserver');
  const literal = (text: string) => quoteSqlStringLiteral(text, 'sqlserver');
  const refusals: DdlRefusal[] = [];
  const impacts: DdlImpact[] = [];
  const renames: string[] = [];
  const drops: string[] = [];
  const alters: string[] = [];
  const adds: string[] = [];

  for (const column of request.columns) {
    const origin = column.origin;
    if (column.dropped) {
      if (origin) {
        drops.push(sqlServerDropDefault(current, origin.name));
        drops.push(`ALTER TABLE ${current} DROP COLUMN ${quote(origin.name)}`);
        impacts.push({ kind: 'drop-column', column: origin.name });
      }
      continue;
    }
    if (!origin) {
      if (!isBlankDraft(column)) {
        adds.push(`ALTER TABLE ${current} ADD ${addColumnDefinition(column, 'sqlserver')}`);
      }
      continue;
    }

    const change = diffColumn(column, 'sqlserver');
    if (change.renamed) {
      renames.push(
        `EXEC sp_rename ${literal(`${current}.${quote(origin.name)}`)}, ${literal(column.name)}, N'COLUMN'`
      );
    }
    const others = changedDdlActions(change).filter((action) => action !== 'rename-column');
    if (others.length === 0) {
      continue;
    }
    if (origin.is_generated) {
      for (const action of others) {
        refusals.push({ column: column.name, action, reason: 'ddl.refuse.sqlServerGeneratedColumn' });
      }
      continue;
    }

    const quoted = quote(column.name);
    if (change.typeChanged || change.nullabilityChanged) {
      const dataType = column.dataType.trim();
      // 排序规则名要拼进语句：来自目录，但照样只放行真实名字里会有的字符
      const collation = origin.collation
        && /^[A-Za-z0-9_]+$/.test(origin.collation)
        && SQL_SERVER_CHARACTER_TYPES.has(columnTypeToken(dataType))
        ? ` COLLATE ${origin.collation}`
        : '';
      const extra = origin.column_extra ?? '';
      const sparse = /^SPARSE\b/.test(extra) ? ' SPARSE' : '';
      alters.push(
        `ALTER TABLE ${current} ALTER COLUMN ${quoted} ${dataType}${collation}${sparse} ${column.nullable ? 'NULL' : 'NOT NULL'}`
      );
      // 掩码写不进 ALTER COLUMN，而 ALTER COLUMN 一定会把它摘掉：另起一句加回去。
      // 这段是列目录里服务端自己转义好的 SQL 原文
      const mask = /MASKED WITH \(FUNCTION = N'.*'\)$/.exec(extra);
      if (mask) {
        alters.push(`ALTER TABLE ${current} ALTER COLUMN ${quoted} ADD ${mask[0]}`);
      }
    }
    if (change.defaultChanged) {
      alters.push(sqlServerDropDefault(current, column.name));
      if (column.defaultValue != null) {
        alters.push(`ALTER TABLE ${current} ADD DEFAULT ${column.defaultValue} FOR ${quoted}`);
      }
    }
  }

  const statements = [...renames, ...drops, ...alters, ...adds];
  // 改表名放最后：前面几条都还在用旧名字
  if (request.newTableName !== request.table) {
    statements.push(`EXEC sp_rename ${literal(current)}, ${literal(request.newTableName)}`);
  }
  return { statements, refusals, impacts };
}

/**
 * Oracle 的改结构。几条都是在 Oracle Free 23ai 上试出来的：
 *
 * - **每条 DDL 自己提交**，一批语句不是一个事务，中途失败时前面的已经生效。所以
 *   能合的合进一条：`MODIFY (...)` 与 `ADD (...)` 可以同在一条 ALTER TABLE 里；
 *   `DROP` 不能和它们并列（ORA-03048），改列名、改表名也只能各自成句。
 * - `MODIFY` 只写改了的那几项：把已经可空的列再写一次 `NULL` 是 ORA-01451，
 *   `NOT NULL` 同理是 ORA-01442。同一列只能出现一次，改了的几项写在一起。
 * - 默认值去不掉，只能 `DEFAULT NULL`（`columnDefaultSql` 把目录里随之出现的
 *   `NULL` 读回没有默认值）。
 * - 自增（identity）与虚拟列除了改名不动，理由同 SQL Server：它们的值由数据库产生，
 *   类型、可空、默认值都连着生成规则。
 */
function buildOracleTableDdl(request: TableDdlRequest): DdlPlan {
  const current = tableReference(request, request.table);
  const quote = (name: string) => quoteSqlIdentifier(name, 'oracle');
  const refusals: DdlRefusal[] = [];
  const impacts: DdlImpact[] = [];
  const renames: string[] = [];
  const drops: string[] = [];
  const modifies: string[] = [];
  const adds: string[] = [];

  for (const column of request.columns) {
    const origin = column.origin;
    if (column.dropped) {
      if (origin) {
        drops.push(quote(origin.name));
        impacts.push({ kind: 'drop-column', column: origin.name });
      }
      continue;
    }
    if (!origin) {
      if (!isBlankDraft(column)) {
        adds.push(addColumnDefinition(column, 'oracle'));
      }
      continue;
    }

    const change = diffColumn(column, 'oracle');
    if (change.renamed) {
      renames.push(`ALTER TABLE ${current} RENAME COLUMN ${quote(origin.name)} TO ${quote(column.name)}`);
    }
    const others = changedDdlActions(change).filter((action) => action !== 'rename-column');
    if (others.length === 0) {
      continue;
    }
    if (origin.is_generated) {
      for (const action of others) {
        refusals.push({ column: column.name, action, reason: 'ddl.refuse.oracleGeneratedColumn' });
      }
      continue;
    }
    const parts = [quote(column.name)];
    if (change.typeChanged) {
      parts.push(column.dataType.trim());
    }
    if (change.defaultChanged) {
      parts.push(`DEFAULT ${column.defaultValue ?? 'NULL'}`);
    }
    if (change.nullabilityChanged) {
      parts.push(column.nullable ? 'NULL' : 'NOT NULL');
    }
    modifies.push(parts.join(' '));
  }

  const statements = [...renames];
  if (drops.length > 0) {
    statements.push(`ALTER TABLE ${current} DROP (${drops.join(', ')})`);
  }
  const clauses = [
    ...(modifies.length > 0 ? [`MODIFY (${modifies.join(', ')})`] : []),
    ...(adds.length > 0 ? [`ADD (${adds.join(', ')})`] : [])
  ];
  if (clauses.length > 0) {
    statements.push(`ALTER TABLE ${current} ${clauses.join(' ')}`);
  }
  // 改表名放最后：前面几条都还在用旧名字。新名字不带 schema，Oracle 不收
  if (request.newTableName !== request.table) {
    statements.push(`ALTER TABLE ${current} RENAME TO ${quote(request.newTableName)}`);
  }
  return { statements, refusals, impacts };
}

function defaultAction(quotedColumn: string, defaultValue: string | null): string {
  return defaultValue == null
    ? `ALTER COLUMN ${quotedColumn} DROP DEFAULT`
    : `ALTER COLUMN ${quotedColumn} SET DEFAULT ${defaultValue}`;
}

function changedDdlActions(change: ColumnChange): DdlAction[] {
  const actions: DdlAction[] = [];
  if (change.renamed) {
    actions.push('rename-column');
  }
  if (change.typeChanged) {
    actions.push('change-type');
  }
  if (change.nullabilityChanged) {
    actions.push('change-nullability');
  }
  if (change.defaultChanged) {
    actions.push('change-default');
  }
  return actions;
}

export interface CreateTableRequest {
  schema: string | null;
  table: string;
  dialect: SqlIdentifierDialect;
  columns: readonly ColumnDraft[];
  /** 接在列与主键后面的表级约束原文（多表设计的 UNIQUE / FOREIGN KEY） */
  constraints?: readonly string[];
}

/**
 * 拼出 CREATE TABLE。
 *
 * 和改结构相反，这里三种方言几乎一致——没有已存在的数据要迁移，也没有
 * 要重述的既有属性，列定义就是用户刚写下的那一行。
 *
 * 主键写成表级 `PRIMARY KEY (a, b)` 而不是列级 `... PRIMARY KEY`：复合主键
 * 只能这么写，而两种写法并存意味着「一列还是多列」要分两条路径。
 *
 * **没有主键时不拦着**：临时表、日志表本来就可能不要主键。但那样的表在这个
 * 程序里不可编辑（定位不到一行），所以界面上要提一句，而不是悄悄建出来。
 */
export function buildCreateTable(request: CreateTableRequest): DdlPlan {
  const { dialect } = request;
  const columns = usableDraftColumns(request.columns);
  // 主键列一律 NOT NULL：三家里只有 SQLite 允许主键存 NULL，而那是它自己
  // 记录在案的历史遗留，照着建出来的表会有一行谁也定位不到
  const definitions = columns.map((column) =>
    columnDefinition(column, !column.nullable || column.primaryKey, dialect));

  const keyColumns = columns.filter((column) => column.primaryKey);
  if (keyColumns.length > 0) {
    definitions.push(
      `PRIMARY KEY (${keyColumns
        .map((column) => quoteSqlIdentifier(column.name, dialect))
        .join(', ')})`
    );
  }
  definitions.push(...(request.constraints ?? []));

  const reference = quoteQualifiedSqlIdentifier(
    request.schema ? [request.schema, request.table] : [request.table],
    dialect
  );
  return {
    statements: [`CREATE TABLE ${reference} (\n  ${definitions.join(',\n  ')}\n)`],
    refusals: [],
    impacts: []
  };
}

/**
 * 新建表时 schema 的起手值。
 *
 * 列表按字母排，第一个未必是用户平时建表的地方：SQL Server 上 `dataomni_meta`
 * 排在 `dbo` 前面，PostgreSQL 上 `analytics` 排在 `public` 前面。各家不写 schema
 * 时默认落在哪里，这里就先选哪里；那个 schema 不在列表里再退回第一个。
 */
export function defaultCreateSchema(
  schemas: readonly string[],
  dialect: SqlIdentifierDialect,
  username?: string | null
): string {
  // Oracle 的 schema 就是用户：不写 schema 时建在登录用户自己名下，名字是大写的
  const preferred = dialect === 'sqlserver'
    ? 'dbo'
    : dialect === 'postgresql'
      ? 'public'
      : dialect === 'duckdb'
        ? 'main'
      : dialect === 'oracle' && username
        ? username.toUpperCase()
        : null;
  return preferred && schemas.includes(preferred) ? preferred : schemas[0] ?? '';
}
