import type { TranslationKey, TranslationParams } from '../i18n/translate';
import { tableKey, type ErLink, type ErTable } from './erLayout';

type Translate = (key: TranslationKey, params?: TranslationParams) => string;

/** 一张表读建表语句的结果：读到了原文，或者读的时候报了错 */
export type TableDdl =
  | { key: string; ddl: string }
  | { key: string; error: string };

export interface DdlScriptSource {
  /** 连接名 */
  title: string;
  database: string;
  /** `YYYY-MM-DD`，传进来：同样的输入要得到同样的文本 */
  date: string;
  /** 按导出的次序 */
  tables: readonly TableDdl[];
}

/**
 * 选中的那批表拼成一个 `.sql`：开头一段注释说是什么、读不到的有哪几张，
 * 之后每张表一段，原文就是数据库自己给的（`SHOW CREATE TABLE`）。
 *
 * 读不到的表不写空段落，只在开头列出来：文件要能直接拿去执行，
 * 而一段只有注释的「表」会让人以为它建出来了。
 */
export function buildDdlScript(source: DdlScriptSource, t: Translate): string {
  const read = source.tables.flatMap((table) => ('ddl' in table ? [table] : []));
  const failed = source.tables.flatMap((table) => ('error' in table ? [table] : []));

  const out = [
    `-- ${oneLine(t('schemaExport.scriptHeader', {
      title: source.title,
      database: source.database,
      count: read.length,
      date: source.date
    }))}`
  ];
  if (failed.length > 0) {
    out.push(`-- ${oneLine(t('schemaExport.scriptFailed', { count: failed.length }))}`);
    for (const table of failed) {
      out.push(`--   ${oneLine(table.key)}: ${oneLine(table.error)}`);
    }
  }

  for (const table of read) {
    const ddl = table.ddl.trim();
    out.push('', RULE, `-- ${oneLine(table.key)}`, RULE, ddl.endsWith(';') ? ddl : `${ddl};`);
  }
  return out.join('\n') + '\n';
}

const RULE = `-- ${'-'.repeat(60)}`;

/** 注释只管到行尾：报错信息里的换行会把后半句漏成 SQL */
function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ');
}

/**
 * 数据字典只要选中的表。外键只要一端在选中的表里就留着：
 * 「这一列指向 users.id」即使 users 没选，也是这张表结构的一部分。
 */
export function dictionarySubset(
  tables: readonly ErTable[],
  links: readonly ErLink[],
  keys: ReadonlySet<string>
): { tables: ErTable[]; links: ErLink[] } {
  return {
    tables: tables.filter((table) => keys.has(tableKey(table))),
    links: links.filter((link) => keys.has(link.from.table) || keys.has(link.to.table))
  };
}

/**
 * 最多 `limit` 个同时在跑，结果按输入次序返回。
 *
 * 一次导一百张表、每张一次往返：经 SSH 隧道一次一百多毫秒，一张张排队就是十几秒。
 * 同时跑几条把它压到几秒，又不至于一下子向服务端扔一百条。`run` 自己处理错误。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}
