import type { SqlDialect } from '../contracts/queryExecution';

export type SqlIdentifierDialect = SqlDialect;

export const quoteSqlIdentifier = (
  identifier: string,
  dialect: SqlIdentifierDialect
): string => {
  // SQL Server 的双引号只在 QUOTED_IDENTIFIER 打开时才是标识符（连接选项可以
  // 关掉它），方括号不受这个开关影响；右方括号成对转义
  if (dialect === 'sqlserver') {
    return `[${identifier.split(']').join(']]')}]`;
  }
  // ClickHouse 的反引号里反斜杠也是转义符：`e\\f` 是名字 `e\f`。先转义反斜杠，再转义反引号
  if (dialect === 'clickhouse') {
    return `\`${identifier.split('\\').join('\\\\').split('`').join('``')}\``;
  }
  const quote = dialect === 'mysql' ? '`' : '"';
  return `${quote}${identifier.split(quote).join(quote + quote)}${quote}`;
};

export const quoteQualifiedSqlIdentifier = (
  identifiers: string[],
  dialect: SqlIdentifierDialect
): string => identifiers.map(identifier => quoteSqlIdentifier(identifier, dialect)).join('.');

/**
 * 各家都保留、裸写当名字会报语法错的词。宁多勿少：多引一个只是难看一点，
 * 少引一个就是一条跑不通的语句
 */
const RESERVED_WORDS = new Set(`
  all alter analyse analyze and any array as asc between both by case cast check collate column
  constraint create cross current_date current_time current_timestamp current_user default delete
  desc distinct do drop else end except exists false fetch for foreign from full grant group having
  in index inner insert intersect into is join key leading left like limit localtime localtimestamp
  natural not null offset on only or order outer placing primary references returning right select
  session_user set some symmetric table then to trailing true union unique update user using values
  view when where window with
`.trim().split(/\s+/));

/**
 * 名字原样能裸写就裸写，否则加引号。给补全用：选中的名字插进去必须能执行，
 * 而每个名字都加引号（`"orders"."id"`）没人会这么手写。
 *
 * 能不能裸写看大小写怎么折：PostgreSQL 折成小写，所以 `Orders` 要引号；
 * Oracle 折成大写，小写建的才要；其余几家按原样比或不分大小写
 */
export function sqlIdentifierAsTyped(identifier: string, dialect: SqlIdentifierDialect): string {
  const plain = dialect === 'postgresql'
    ? /^[a-z_][a-z0-9_]*$/
    : dialect === 'oracle'
      ? /^[A-Z][A-Z0-9_$#]*$/
      : /^[A-Za-z_][A-Za-z0-9_]*$/;
  return plain.test(identifier) && !RESERVED_WORDS.has(identifier.toLowerCase())
    ? identifier
    : quoteSqlIdentifier(identifier, dialect);
}

/**
 * 连接类型 → 标识符引用方言。
 *
 * 已经是第三个调用点了。不认识的类型按 `sqlite` 走（双引号是 SQL 标准写法），
 * 而不是抛错——这条路径上真正重要的是「别让一个陌生类型把界面整个打掉」。
 */
export function identifierDialectFor(dbType: string): SqlIdentifierDialect {
  if (
    dbType === 'mysql'
    || dbType === 'sqlserver'
    || dbType === 'oracle'
    || dbType === 'duckdb'
    || dbType === 'clickhouse'
  ) {
    return dbType;
  }
  return dbType === 'postgresql' ? 'postgresql' : 'sqlite';
}
