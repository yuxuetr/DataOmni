import type { SqlIdentifierDialect } from './sqlIdentifiers';

/**
 * 把一个值包成 SQL 字符串字面量。
 *
 * 之所以需要它：`execute_query` 还不接受绑定参数（见 TODOs 2.4 第一条），
 * 筛选条件里的值只能内联。这不是权限问题——用户本来就能在编辑器里写任意
 * SQL——而是**正确性**问题：一个带撇号的姓氏会让语句直接语法错误。
 *
 * 这里按方言分支，与历史脱敏里「反斜杠一律按 MySQL 算」的取舍相反，因为
 * 代价方向不同：那边错了只是多打码或少打码一个展示用的字符串，这边错了
 * 是把一个错误的值发给数据库，查出来的行是错的而语句本身不会报错。
 */
export function quoteSqlStringLiteral(value: string, dialect: SqlIdentifierDialect): string {
  // 单引号写两遍是三种方言共同的规则
  let escaped = value.split("'").join("''");

  if (dialect === 'mysql') {
    // MySQL 默认开着反斜杠转义（NO_BACKSLASH_ESCAPES 关闭），字面量里的
    // `\` 必须写两遍，否则 `C:\temp` 里的 `\t` 会变成制表符。
    // PostgreSQL（standard_conforming_strings 默认开）与 SQLite 则相反：
    // 在那两家里把 `\` 写两遍会凭空多出一个反斜杠
    escaped = escaped.split('\\').join('\\\\');
  }

  // SQL Server 的 '…' 是按库的代码页存的非 Unicode 串：拿 '中文' 去比一列
  // nvarchar，两边在转换时就成了 '??'，条件静默地什么也匹配不上。N'…' 才是
  // Unicode 字面量；和 varchar 列比较时它会被隐式转换，照样能用
  if (dialect === 'sqlserver') {
    return `N'${escaped}'`;
  }
  return `'${escaped}'`;
}

/**
 * LIKE 模式里的转义字符。
 *
 * 不用惯用的 `\`：在 MySQL 里 `\` 同时是**字符串字面量**的转义符，模式里的
 * 一个 `\` 要写成四个才能传到 LIKE 那一层，而 PostgreSQL 和 SQLite 只要两个。
 * 两层转义叠在一起正是这类代码最容易错的地方。`!` 在三种方言的字符串字面量里
 * 都没有特殊含义，只需转义一层。
 */
export const LIKE_ESCAPE_CHAR = '!';

/**
 * 把用户输入的文本变成 LIKE 模式里的**字面**片段。
 *
 * 不转义的话，一个想搜 `100%` 的用户会搜到所有以 100 开头的值，而且完全
 *看不出哪里不对——结果集只是比预期大，不会报错。
 */
export function escapeLikePattern(text: string): string {
  let escaped = '';
  for (const character of text) {
    if (character === LIKE_ESCAPE_CHAR || character === '%' || character === '_') {
      escaped += LIKE_ESCAPE_CHAR;
    }
    escaped += character;
  }
  return escaped;
}
