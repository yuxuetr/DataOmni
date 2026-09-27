import type { TranslationKey, TranslationParams } from '../i18n/translate';
import { tableKey, type ErLink, type ErTable } from './erLayout';

type Translate = (key: TranslationKey, params?: TranslationParams) => string;

export interface DictionarySource {
  /** 连接名，或设计页的标题 */
  title: string;
  /** 方言的显示名（PostgreSQL、MySQL…） */
  dialect: string;
  /** 从库里读出来的，还是 AI 设计页上还没建的——开头那句「包含什么」两者不同 */
  origin: 'catalog' | 'design';
  tables: readonly ErTable[];
  links: readonly ErLink[];
  /** `YYYY-MM-DD`。传进来而不是在里面取：同样的输入要得到同样的文本 */
  date: string;
}

/**
 * 数据字典：每张表的列、类型、可空、主键、外键指向谁、被谁引用。
 *
 * 来源是 ER 图读出来的那一份目录，所以**没有**列注释、默认值、索引与唯一约束——
 * 文件开头照实写一句，不让人以为这是全部。表的次序、列的次序跟着目录走。
 */
export function buildDataDictionary(source: DictionarySource, t: Translate): string {
  const lines = [`# ${source.title}`, '', dictionaryBody(source, t)];
  return lines.join('\n');
}

/**
 * Agent Skill（`SKILL.md`）：同一份字典加 frontmatter。Agent 读了就知道这个库有哪些表、
 * 表之间怎么关联，写 SQL 时不必再去猜名字。
 */
export function buildAgentSkill(source: DictionarySource, t: Translate): string {
  const description = t('dictionary.skillDescription', {
    title: source.title,
    dialect: source.dialect,
    count: source.tables.length
  });
  return [
    '---',
    `name: ${skillName(source.title)}`,
    // JSON 的字符串就是合法的 YAML 双引号标量：标题里带冒号、引号也不会把 frontmatter 弄坏
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
    `# ${source.title}`,
    '',
    t('dictionary.skillIntro', { dialect: source.dialect }),
    '',
    dictionaryBody(source, t)
  ].join('\n');
}

/**
 * Skill 的名字只许小写字母、数字和连字符，最长 64。连接名全是中文时拼不出东西，用一个通用名
 */
export function skillName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = slug === '' ? 'database' : slug;
  return `${base.slice(0, 64 - '-schema'.length).replace(/-+$/, '')}-schema`;
}

function dictionaryBody(source: DictionarySource, t: Translate): string {
  const out: string[] = [
    t('dictionary.summary', {
      dialect: source.dialect,
      tables: source.tables.length,
      links: source.links.length,
      date: source.date
    }),
    '',
    `> ${t(source.origin === 'design' ? 'dictionary.coverageDesign' : 'dictionary.coverage')}`
  ];

  for (const table of source.tables) {
    const key = tableKey(table);
    out.push('', `## ${key}`, '');
    out.push(`| ${t('dictionary.column')} | ${t('dictionary.type')} | ${t('dictionary.nullable')} | ${t('dictionary.primaryKey')} | ${t('dictionary.references')} |`);
    out.push('| --- | --- | --- | --- | --- |');
    for (const column of table.columns) {
      const targets = source.links
        .filter((link) => link.from.table === key && link.from.column === column.name)
        .map((link) => `\`${cell(link.to.table)}.${cell(link.to.column)}\``);
      // 主键列一律写不可空：SQLite 的目录对 INTEGER PRIMARY KEY 报 notnull = 0，而它存不进 NULL。
      // 照抄目录会在字典里写出「主键可空」，读的人（和 Agent）会当真
      const nullable = column.isNullable && !column.isPrimaryKey;
      out.push(
        `| \`${cell(column.name)}\` | ${cell(column.dataType)} | ${nullable ? t('dictionary.yes') : t('dictionary.no')}`
        + ` | ${column.isPrimaryKey ? '✓' : ''} | ${targets.join(', ')} |`
      );
    }
    const referencedBy = source.links
      .filter((link) => link.to.table === key)
      .map((link) => `\`${cell(link.from.table)}.${cell(link.from.column)}\``);
    if (referencedBy.length > 0) {
      out.push('', t('dictionary.referencedBy', { columns: referencedBy.join(', ') }));
    }
  }
  return out.join('\n') + '\n';
}

/** 表格单元格里的竖线会切断这一行；换行会把表格整个断开 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
