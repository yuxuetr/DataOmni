import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ColumnInfo } from '../contracts';
import {
  buildCreateTable,
  buildTableDdl,
  columnDefaultSql,
  type ColumnDraft
} from './tableDdl';
import type { SqlIdentifierDialect } from './sqlIdentifiers';

/**
 * 改结构有两侧：SQL 在这里拼出来，跑它的是真正的数据库。
 *
 * 前端的单测只能证明字符串没变，证明不了那串字符是合法的 ALTER TABLE，更
 * 证明不了它跑完以后表是什么样——而「跑完以后表是什么样」正是 MySQL 重述
 * 整段定义时最容易出错的地方：少写一个 COLLATE 语句照样成功，属性没了。
 *
 * 这份语料是同一组输入的唯一期望输出。这里核对生成的语句，
 * `src-tauri/tests/database_smoke.rs` 把 fixture 与同样几条语句拿真库跑一遍，
 * 再核对跑完之后的列目录。
 */
interface CorpusColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKeyOrdinal: number | null;
  defaultValue: string | null;
  generated: boolean;
  collation?: string | null;
  comment?: string | null;
  extra?: string | null;
}

interface CorpusDraft {
  /** 对应 origin 里的列名；null 表示新增 */
  origin: string | null;
  name?: string;
  dataType?: string;
  nullable?: boolean;
  defaultValue?: string | null;
  dropped?: boolean;
  primaryKey?: boolean;
}

interface CorpusCase {
  name: string;
  /** 缺省是改结构；`create` 走建表那条路径 */
  kind?: 'create';
  dialect: SqlIdentifierDialect;
  schema: string | null;
  table: string;
  newTableName: string;
  origin: CorpusColumn[];
  draft: CorpusDraft[];
  statements: string[];
  refusals: Array<{ column: string; action: string; reason: string }>;
  impacts: string[];
}

// 用 `new URL` 而不是相对的 cwd 路径：vitest 的工作目录不保证是仓库根
const CORPUS_PATH = new URL('../../fixtures/ddl-conformance.json', import.meta.url);
const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as { cases: CorpusCase[] };

function toColumnInfo(column: CorpusColumn): ColumnInfo {
  return {
    name: column.name,
    data_type: column.dataType,
    is_nullable: column.nullable,
    is_primary_key: column.primaryKeyOrdinal !== null,
    primary_key_ordinal: column.primaryKeyOrdinal ?? undefined,
    default_value: column.defaultValue ?? undefined,
    is_generated: column.generated,
    collation: column.collation ?? null,
    comment: column.comment ?? null,
    column_extra: column.extra ?? null
  };
}

/**
 * 语料里的草稿只写**改动**，没写的沿用原值。
 *
 * 这和界面一致：打开编辑器时每一列的起点就是目录里的样子，用户只碰他要改的
 * 那几格。全写一遍的语料看不出哪里是改动。
 */
function toDraft(
  entry: CorpusDraft,
  byName: Map<string, ColumnInfo>,
  dialect: SqlIdentifierDialect
): ColumnDraft {
  const origin = entry.origin === null ? null : byName.get(entry.origin);
  if (entry.origin !== null && !origin) {
    throw new Error(`语料里的 draft 引用了不存在的列: ${entry.origin}`);
  }
  return {
    origin: origin ?? null,
    name: entry.name ?? origin?.name ?? '',
    dataType: entry.dataType ?? origin?.data_type ?? '',
    nullable: entry.nullable ?? origin?.is_nullable ?? true,
    // 没碰过默认值的列，起点是目录值归一之后的 SQL 原文——和界面一致
    defaultValue: entry.defaultValue !== undefined
      ? entry.defaultValue
      : origin
        ? columnDefaultSql(origin, dialect)
        : null,
    dropped: entry.dropped ?? false,
    primaryKey: entry.primaryKey ?? origin?.is_primary_key ?? false
  };
}

describe('改结构语料', () => {
  for (const testCase of corpus.cases) {
    it(testCase.name, () => {
      const byName = new Map(testCase.origin.map((column) => {
        const info = toColumnInfo(column);
        return [info.name, info];
      }));

      const columns = testCase.draft.map((entry) => toDraft(entry, byName, testCase.dialect));
      const plan = testCase.kind === 'create'
        ? buildCreateTable({
          schema: testCase.schema,
          table: testCase.table,
          dialect: testCase.dialect,
          columns
        })
        : buildTableDdl({
          schema: testCase.schema,
          table: testCase.table,
          newTableName: testCase.newTableName,
          dialect: testCase.dialect,
          columns
        });

      expect(plan.statements).toEqual(testCase.statements);
      expect(plan.refusals).toEqual(testCase.refusals);
      expect(plan.impacts.map((impact) => impact.column)).toEqual(testCase.impacts);
    });
  }

  it('三种方言的改结构与建表都有用例——少一种就是那一种从没跑过真库', () => {
    for (const kind of [undefined, 'create'] as const) {
      expect(new Set(
        corpus.cases.filter((testCase) => testCase.kind === kind)
          .map((testCase) => testCase.dialect)
      )).toEqual(new Set(['postgresql', 'mysql', 'sqlite']));
    }
  });
});
