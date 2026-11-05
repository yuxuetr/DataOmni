import { catalogQueryParams, type SchemaMetadataQueries } from './catalogQueries';
import { catalogToCodegenSchema, type CatalogTable, type CodegenDialect, type CodegenSchema } from './codegenModel';
import type { ErLink, ErTable } from './erLayout';
import { groupIndexRows } from './schemaObjects';
import { toColumnInfo } from './tableMetadata';

type Select = (sql: string, params: unknown[]) => Promise<unknown>;

/** 同时在途的单表查询数。网络库上一次往返几十毫秒，太多并发反而挤占用户正在跑的查询 */
const CONCURRENCY = 4;

/**
 * 已有库的代码生成输入：ER 图已经读到了表与外键，每张表的列与唯一索引再逐表读单表结构查询
 * （结构页用的那一份）。为什么不往 ER 查询里加列，见 rfcs/codegen.md §3
 */
export async function loadCatalogCodegenSchema(
  select: Select,
  queries: Pick<SchemaMetadataQueries, 'columns' | 'indexes' | 'parameter_count'>,
  dialect: CodegenDialect,
  tables: readonly ErTable[],
  links: readonly ErLink[]
): Promise<CodegenSchema> {
  const loaded: CatalogTable[] = new Array(tables.length);
  let next = 0;
  const worker = async () => {
    while (next < tables.length) {
      const index = next;
      next += 1;
      const table = tables[index];
      const params = catalogQueryParams(queries.parameter_count, table.name, table.schema);
      const [columnRows, indexRows] = await Promise.all([
        select(queries.columns, params),
        select(queries.indexes, params)
      ]);
      loaded[index] = {
        schema: table.schema,
        name: table.name,
        columns: toColumnInfo(columnRows),
        indexes: groupIndexRows(Array.isArray(indexRows) ? indexRows : [])
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tables.length) }, worker));
  return catalogToCodegenSchema(dialect, loaded, links);
}
