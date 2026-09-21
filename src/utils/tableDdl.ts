import type { ColumnInfo } from '../contracts';
import type { TranslationKey } from '../i18n/translate';
import { isNumericColumnType } from './columnTypes';
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
  if (dialect !== 'mysql') {
    return raw;
  }
  if ((column.column_extra ?? '').includes('DEFAULT_GENERATED')) {
    return raw;
  }
  return isNumericColumnType(column.data_type) ? raw : quoteSqlStringLiteral(raw, 'mysql');
}

/** 一列在 ADD COLUMN 里的定义。三家通用的那一小段 */
function addColumnDefinition(column: ColumnDraft, dialect: SqlIdentifierDialect): string {
  const parts = [quoteSqlIdentifier(column.name, dialect), column.dataType.trim()];
  if (!column.nullable) {
    parts.push('NOT NULL');
  }
  if (column.defaultValue != null) {
    parts.push(`DEFAULT ${column.defaultValue}`);
  }
  return parts.join(' ');
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
  // `on update CURRENT_TIMESTAMP` 与 DEFAULT 是一对，不带上它等于把它删了
  const onUpdate = /on update ([^,]+)/i.exec(extra);
  if (onUpdate) {
    parts.push(`ON UPDATE ${onUpdate[1].trim()}`);
  }
  if (extra.includes('auto_increment')) {
    parts.push('AUTO_INCREMENT');
  }
  if (origin?.comment) {
    parts.push(`COMMENT ${quoteSqlStringLiteral(origin.comment, 'mysql')}`);
  }
  return parts.join(' ');
}

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
  if ((origin.column_extra ?? '').includes('DEFAULT_GENERATED')) {
    return 'ddl.refuse.mysqlExpressionDefault';
  }
  return null;
}

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
  const statements: string[] = [];
  const refusals: DdlRefusal[] = [];
  const impacts: DdlImpact[] = [];
  const current = tableReference(request, request.table);
  const combines = dialect === 'mysql';
  let renameTable: string | null = null;

  // 改列名在 PostgreSQL 与 SQLite 里必须单独成句，放在最前面，
  // 后面的动作一律用新名字
  const renames: string[] = [];
  // 删列排在加列之前：删掉 `code` 再新建一个同名的 `code` 是一次合理的编辑，
  // 而反过来的次序在三家里都会撞上「列已存在」。同一条 ALTER 里的动作
  // PostgreSQL 与 MySQL 都按书写次序执行，所以次序就是语义。
  const drops: string[] = [];
  const alters: string[] = [];
  const adds: string[] = [];

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
        adds.push(`ADD COLUMN ${addColumnDefinition(column, dialect)}`);
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
      alters.push(`ALTER COLUMN ${quoted} TYPE ${column.dataType.trim()}`);
    }
    if (change.nullabilityChanged) {
      alters.push(`ALTER COLUMN ${quoted} ${column.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`);
    }
    if (change.defaultChanged) {
      alters.push(defaultAction(quoted, column.defaultValue));
    }
  }

  const ordered = [...drops, ...alters, ...adds];
  if (request.newTableName !== request.table) {
    const renameTo = `RENAME TO ${quoteSqlIdentifier(request.newTableName, dialect)}`;
    if (combines) {
      ordered.push(renameTo);
    } else {
      renameTable = `ALTER TABLE ${current} ${renameTo}`;
    }
  }

  statements.push(...renames);

  if (ordered.length > 0) {
    if (dialect === 'sqlite') {
      // SQLite 一条 ALTER TABLE 只能做一件事
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
  const definitions = columns.map((column) => {
    const parts = [quoteSqlIdentifier(column.name, dialect), column.dataType.trim()];
    // 主键列一律 NOT NULL：三家里只有 SQLite 允许主键存 NULL，而那是它自己
    // 记录在案的历史遗留，照着建出来的表会有一行谁也定位不到
    if (!column.nullable || column.primaryKey) {
      parts.push('NOT NULL');
    }
    if (column.defaultValue != null) {
      parts.push(`DEFAULT ${column.defaultValue}`);
    }
    return parts.join(' ');
  });

  const keyColumns = columns.filter((column) => column.primaryKey);
  if (keyColumns.length > 0) {
    definitions.push(
      `PRIMARY KEY (${keyColumns
        .map((column) => quoteSqlIdentifier(column.name, dialect))
        .join(', ')})`
    );
  }

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
